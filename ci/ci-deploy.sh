#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# ci-deploy.sh — pull pre-built images + health-gated swap + rollback
# Runs on the PROD VM (self-hosted runner label: prod). NO compiling here.
#
#   ./ci/ci-deploy.sh <image-tag>
#
# Requires: REGISTRY env set; prod's ~/sundog/.env already in place (that's the
# canonical secrets file the running stack uses — NOT .env.production, which is a
# stale template; using the wrong one => Postgres P1000 auth failure).
#
# Bad-divorce: this is the convenient path. If CI/GitHub is down, a human still
# deploys by hand via deploy/prod-deploy.sh. Nothing here is the only way in.
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

TAG="${1:?usage: ci-deploy.sh <image-tag>}"
: "${REGISTRY:?set REGISTRY (e.g. registry.<tailnet>.ts.net:5000)}"

SUNDOG_DIR="${HOME}/sundog"
cd "$SUNDOG_DIR"

# Run from ~/sundog (it has ./server/certs the prod compose mounts + the canonical
# .env). Do NOT pass --env-file: bare compose auto-loads ~/sundog/.env exactly like
# the hand deploys (restore-env.sh) do — that's the file Postgres was initialized
# with. Forcing --env-file .env.production sent the api a stale password => P1000.
# (REGISTRY/TAG come from the shell env; .env supplies POSTGRES_PASSWORD etc.)
COMPOSE=(docker compose -f docker-compose.prod.yml -f ci/docker-compose.deploy.yml)
HEALTH_URL="http://localhost:3001/api/health"

green() { printf '\033[0;32m%s\033[0m\n' "$1"; }
red()   { printf '\033[0;31m%s\033[0m\n' "$1"; }

# ── Capture the currently-running api image tag for rollback ──
PREV_REF="$(docker inspect --format '{{.Config.Image}}' servicepro-api 2>/dev/null || true)"
PREV_TAG="${PREV_REF##*:}"
[ -n "$PREV_TAG" ] && green "Current api image: ${PREV_REF} (rollback target: ${PREV_TAG})" \
                   || red  "No running api container found — first deploy, no rollback target."

swap() {
  local tag="$1"
  green "── Pulling images @ ${tag} ──"
  TAG="$tag" "${COMPOSE[@]}" pull api client   # strict: if the registry is unreachable, abort BEFORE touching the running stack
  # --no-deps + naming only api client: recreate ONLY those two. Postgres/Redis/
  # Caddy are left running untouched (a bare `up -d` recreated everything incl.
  # Postgres — and waited on caddy's depends_on:api-healthy, which is what made
  # the deploy 'fail' on a slow boot). `|| true` so a non-zero up doesn't trip
  # `set -e` and skip the rollback below — healthy() is the real gate.
  green "── Swapping api + client @ ${tag} (--no-deps, Postgres untouched) ──"
  TAG="$tag" "${COMPOSE[@]}" up -d --no-deps api client || true
}

healthy() {
  green "── Health check (${HEALTH_URL}) ──"
  for i in $(seq 1 40); do
    if curl -fsS "$HEALTH_URL" 2>/dev/null | grep -q '"ok"'; then
      green "✓ API healthy after ${i}s"; return 0
    fi
    sleep 2
  done
  red "✖ API did not become healthy in ~80s"; return 1
}

# ── Deploy ──
swap "$TAG"

if healthy; then
  green "══ Deploy ${TAG} complete ══"
  exit 0
fi

# ── Rollback ──
docker logs servicepro-api --tail 40 || true
if [ -n "$PREV_TAG" ] && [ "$PREV_TAG" != "$TAG" ]; then
  red "Rolling back to ${PREV_TAG} ..."
  swap "$PREV_TAG"
  if healthy; then
    red "Rolled back to ${PREV_TAG}. Deploy ${TAG} FAILED — investigate before retrying."
    exit 1
  fi
  red "Rollback to ${PREV_TAG} ALSO unhealthy — manual intervention required."
fi
exit 1
