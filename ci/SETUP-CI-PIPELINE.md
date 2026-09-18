<!-- Source audit 2026-09-17, baseline 45b3d44; live runner status not inspected. -->

# Standing up the ServicePRO CI/CD pipeline — ELI5

Goal: push to `master` on GitHub → it auto-builds the images on a beefy box, stores them, and auto-deploys to prod with a health check + rollback. No more SSHing in to `down && up --build`.

You have two machines:
- **Guilder** — a fresh Linux VM (0 things installed). This becomes the **build box**: it compiles the images and stores them. (Lives on the Hyper-V host — it has the RAM/disk; the prod box is too small to build.)
- **servpro** — the existing **prod box**. It only *pulls* the finished image and swaps it in.

## The mental model (3 actors)
- **GitHub** = the dispatcher. Holds the job tickets ("build commit abc123"). Does no work itself.
- **A runner** = a worker program you install on *your* machine. It phones GitHub asking "any work?" — it reaches **out**, so you open **zero inbound ports** (good for on-prem).
- **The registry** = a warehouse where finished images (the "boxes") are stored so prod can grab them.

You install **two workers**: a big one on Guilder (builds + stocks the warehouse) and a tiny one on servpro (grabs the box, swaps it in).

> Throughout, replace `<OWNER>/<REPO>` with your GitHub repo, and `guilder.<tailnet>.ts.net` with Guilder's real Tailscale name (run `tailscale status` to see it). Assumes Ubuntu/Debian — adjust `apt` for other distros.

---

## PART 1 — Guilder (the build box), from zero

### 1. System basics
```bash
sudo apt-get update && sudo apt-get install -y git curl ca-certificates
```

### 2. Docker
```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER      # run docker without sudo
# log out and back in (or: newgrp docker) so the group takes effect
docker run --rm hello-world        # sanity check
```

### 3. Tailscale (so prod can reach Guilder's warehouse)
```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale status                   # note Guilder's name, e.g. guilder.<tailnet>.ts.net
```

### 4. Start the warehouse (registry)
```bash
docker run -d --restart=unless-stopped --name registry \
  -p 5000:5000 \
  -v registry-data:/var/lib/registry \
  -e REGISTRY_STORAGE_DELETE_ENABLED=true \
  registry:2
curl -s http://localhost:5000/v2/_catalog    # should print {"repositories":[]}
```
(That `-v registry-data` keeps the images across reboots; `DELETE_ENABLED` lets you garbage-collect later.)

### 5. Let Docker trust the warehouse (plain HTTP)
The registry is HTTP, so Docker refuses it unless whitelisted. On **Guilder**:
```bash
echo '{ "insecure-registries": ["guilder.<tailnet>.ts.net:5000"] }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
docker start registry              # restart brought it down; bring it back
```

### 6. Install the build worker (GitHub Actions runner)
On GitHub: **repo → Settings → Actions → Runners → New self-hosted runner → Linux** — this page has the runner **token** you'll need below (one-time, expires in ~1 hour).

Download + extract the runner. This snippet **auto-resolves the current version** (don't hardcode `vX.Y.Z` — that's a placeholder; a literal copy downloads a 9-byte 404 page and `tar` dies with "not in gzip format"):
```bash
mkdir -p actions-runner && cd actions-runner
RUNNER_VERSION=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | grep -oP '"tag_name": "v\K[^"]+')
ARCH=$( [ "$(uname -m)" = "aarch64" ] && echo arm64 || echo x64 )
curl -o actions-runner.tar.gz -L \
  "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${ARCH}-${RUNNER_VERSION}.tar.gz"
file actions-runner.tar.gz          # MUST say "gzip compressed data" (~80MB), not "ASCII text"
tar xzf actions-runner.tar.gz
```
Then configure it — **add the `build` label** (that's how the pipeline finds this box):
```bash
./config.sh --url https://github.com/<OWNER>/<REPO> --token <TOKEN-FROM-GITHUB> \
  --name guilder --labels build --unattended
```
Make it a service so it survives reboots/logout:
```bash
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status               # should say "active (running)"
```
Guilder now appears under Settings → Actions → Runners as **Idle**, waiting for work.

---

## PART 2 — servpro (the prod box), the deploy worker

servpro already has Docker + the repo at `~/sundog`. **The canonical secrets file the running stack loads is `~/sundog/.env`** — bare `docker compose` auto-loads `.env`, NOT `.env.production`. (Heads-up: `restore-env.sh` writes `.env.production`, but the live stack runs off `.env`; the password Postgres was initialized with lives in `.env`. Using the wrong one = P1000 auth failure. Worth reconciling those two files someday, but the deploy uses `.env`.) Two things to add:

### 7. Trust the warehouse on prod too
```bash
echo '{ "insecure-registries": ["guilder.<tailnet>.ts.net:5000"] }' | sudo tee /etc/docker/daemon.json
sudo systemctl restart docker
```
(If you already have a `daemon.json`, merge the key in rather than overwrite.)

### 8. Confirm prod's deploy dir is ready
The deploy job runs in `~/sundog`, which must have:
- the git checkout (it does — `prod-deploy.sh` already `git pull`s it),
- `~/sundog/.env` present (the canonical secrets the stack auto-loads — the password matching the Postgres volume),
- `~/sundog/server/certs/` (the Enverus certs, as today).
Quick check: `ls ~/sundog/.env ~/sundog/server/certs`.

### 8b. Give prod its own key into the repo
The deploy job's first command is `git -C "$HOME/sundog" pull --ff-only origin master`.
That runs as the runner's user with **no GitHub credentials from the workflow** — the
box authenticates on its own. So `~/sundog` needs a key GitHub accepts, and it has to
survive reboots (an agent-held, passphrase-protected key does not).

As the runner's user on servpro:
```bash
ssh-keygen -t ed25519 -f ~/.ssh/id_ed25519_sundog_deploy -N "" -C "servpro-ci-deploy"
cat ~/.ssh/id_ed25519_sundog_deploy.pub
```
Paste that public key into the **repo's** Settings -> Deploy keys -> Add deploy key
(title `servpro-ci-deploy`, **leave "Allow write access" unchecked** — the deploy only
pulls). A deploy key is scoped to this one repo, which is why it beats putting the key
on a personal account.

Confirm the remote is the SSH form, then prove it end to end:
```bash
git -C ~/sundog remote -v      # want git@github.com:<OWNER>/<REPO>.git
ssh -T git@github.com          # "does not provide shell access" IS success
git -C ~/sundog pull --ff-only origin master
```

If `~/.ssh` holds several keys (sidecar certs and the like) and ssh offers the wrong one,
pin it — otherwise skip this, a lone key is picked up on its own:
```bash
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/id_ed25519_sundog_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

### 9. Install the prod worker
Same as step 6, **but label it `prod`** and run it on servpro:
```bash
./config.sh --url https://github.com/<OWNER>/<REPO> --token <NEW-TOKEN> \
  --name servpro --labels prod --unattended
sudo ./svc.sh install && sudo ./svc.sh start
```
(Grab a fresh token from the same GitHub page — tokens are one-time.)

---

## PART 3 — One GitHub setting

Tell the pipeline where the warehouse is: **repo → Settings → Secrets and variables → Actions → Variables → New repository variable**
- Name: `REGISTRY_HOST`
- Value: `guilder.<tailnet>.ts.net:5000`

---

## PART 4 — Fire it

Push any commit to `master` (or merge a PR). Then **repo → Actions** and watch:
1. **verify** (on Guilder) — typecheck + tests + migrate-from-zero drift gate. Lint runs report-only.
2. **build-and-push** (on Guilder) — builds api + client images, tags `:<git-sha>` + `:latest`, pushes to the warehouse.
3. **deploy** (on servpro) — `git pull` in `~/sundog`, pulls the new image, swaps **only api + client** (Postgres/Redis/Caddy are left running), health-checks `http://localhost:3001/api/health`, and **attempts image rollback to the previous tag** if the API health check fails.

Confirm: `curl -s http://localhost:3001/api/health` on prod returns `{"status":"ok"}`, and inspect `servicepro-api` plus `servicepro-client-build`. The client is a one-shot asset-copy container: use `docker ps -a` and confirm it exited with code 0. Load the UI as a separate smoke check.

---

## Auto-deploy — the safety rails (so it's not scary)
- **API-health-gated image rollback:** `ci-deploy.sh` attempts the previous tag if health fails. This does not reverse migrations or Compose changes, verify client assets, or guarantee recovery if the previous tag is unavailable.
- **Postgres is never cycled** — only api + client are recreated, so the DB isn't at risk on an app ship.
- **Manual deployment of a built tag:** set `REGISTRY` and run `~/sundog/ci/ci-deploy.sh <built-short-sha>` on prod. The local legacy `deploy/prod-deploy.sh` builds on prod and cycles the full stack; its helper restores `.env.production` while Compose uses `.env`. Review that mismatch before using it.

## Housekeeping (set-and-forget cron on Guilder)
Build cache + old images grow. Add to Guilder's crontab (`crontab -e`):
```bash
# weekly: trim build cache older than 7 days
0 3 * * 0  docker builder prune -af --filter until=168h
```
### Registry reclaim — `ci/registry-gc.sh`

`docker builder prune` does **not** touch the registry, and the registry never
garbage-collects itself: ci.yml pushes two tags per master commit and nothing
removes them. It reached 128 tags per repo and filled Guilder's disk, which
kills the runner mid-build — `verify` passes, `build images` never concludes,
and **no logs are uploaded at all** (that missing-logs detail is the signature;
a real build error concludes the step and leaves logs).

Bare `garbage-collect` on its own reclaims nothing, because GC only frees blobs
no manifest references and every tag is still a manifest. Tags have to be
deleted first. That is what this script does:

```bash
./ci/registry-gc.sh --dry-run     # show the plan — always look first
./ci/registry-gc.sh               # apply
```

Install the weekly timer (Guilder only — prod has no registry):

```bash
sudo cp ci/systemd/sundog-registry-gc.{service,timer} /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now sundog-registry-gc.timer
```

**Two traps, both found the hard way — do not "simplify" past them:**

- **Never add `--delete-untagged`.** Registry 2.8 does not treat the children of
  an OCI image index as tagged, so that flag deletes the per-platform children of
  *surviving* images too. Every remaining tag then fails to pull with
  `short read ... unexpected EOF`. The script instead deletes each doomed index's
  children explicitly and runs a plain GC.
- **Keep `REGISTRY_GC_PIN` set to the tag prod is running.** `ci-deploy.sh` rolls
  back by pulling that tag; if GC removed it, a failed deploy becomes an outage.
  The keep-window normally covers it — but after a stretch of failed deploys prod
  sits many merges behind, which is exactly when it wouldn't. Check with:
  ```bash
  ssh sundog@servpro "docker inspect --format '{{.Config.Image}}' servicepro-api"
  ```

## Adding a new environment variable (read this first)
It is always a **two-file change**, in the same commit:
1. `server/src/**` reads `process.env.YOUR_VAR`
2. `docker-compose.prod.yml` lists `YOUR_VAR: ${YOUR_VAR:-}` under the api service's `environment:`

The api service has **no `env_file:`** — bare compose auto-loads `~/sundog/.env` for
*interpolation*, but only keys named in the `environment:` block are actually injected
into the container. Skip step 2 and the var is invisible to the running app no matter
what prod's `.env` says. There is no error: the feature just silently does nothing,
which is the worst possible failure mode and the hardest to trace.

Shipped broken this way four times so far — #43 (gcal), #56 (RingCentral), #99 (mailer),
#98 (S3 file store). If the var names a **path that gets a named volume**, it is a
three-file change: `server/Dockerfile` must `mkdir -p` and `chown node:node` that path
too, or Docker creates the mountpoint root-owned and the container (running as `node`)
hits EACCES on every write.

## If something breaks
- **Job stuck "Queued" forever** → the runner with that label isn't online. `sudo ./svc.sh status` on the right box; check Settings → Actions → Runners shows it Idle.
- **`http: server gave HTTP response to HTTPS client`** on push/pull → the `insecure-registries` daemon.json step was missed on that box, or you forgot to restart docker.
- **`required variable POSTGRES_PASSWORD is missing`** during deploy → `~/sundog/.env` isn't present on prod (bare compose auto-loads `.env`).
- **`P1000: Authentication failed ... credentials for 'sundog' are not valid`** → the api is loading the wrong env file (a stale `.env.production` instead of `.env`); the deploy must use the same `.env` Postgres was initialized with.
- **Deploy dies in seconds on `git ... pull` with bare `ERROR: Repository not found.`** → prod's SSH key for the repo, nothing else (the workflow and the image build are fine; note the missing `remote:` prefix — that is GitHub's SSH rejection, not HTTPS). Redo step 8b. This bit on 2026-08-20 after a key was swapped out during unrelated cert work, and master sat undeployed for three days.
- **Deploy says "rolled back"** → the new image came up unhealthy; `docker logs servicepro-api --tail 50` on prod for the real error. Confirm the rollback health result; rollback can also fail. Database migrations are not rolled back.
- **Enverus cert errors after deploy** → `~/sundog/server/certs` is empty on prod (the mount needs the real certs in place).

## What this maps to
- Workflow: `.github/workflows/ci.yml`
- Deploy script: `ci/ci-deploy.sh` · image override: `ci/docker-compose.deploy.yml` · registry: `ci/registry/docker-compose.registry.yml`
- Design + spec: `mk2/CI-IMPLEMENTATION.md`, ADR-0001, ADR-0009.
