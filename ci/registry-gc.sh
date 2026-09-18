#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# registry-gc.sh — reclaim disk in the self-hosted Docker registry on guilder.
#
#   ./ci/registry-gc.sh --dry-run          # show the plan, delete nothing
#   ./ci/registry-gc.sh                    # delete + garbage-collect
#   ./ci/registry-gc.sh --pin b5341a2      # protect a tag on top of the defaults
#
# Why this exists: ci.yml pushes two tags per master commit (<sha> and latest)
# and NOTHING ever removes them. prune-docker.sh deliberately leaves the registry
# alone — on the build host the local images are pure cache because "the registry
# holds the real copies", so the registry is the one store with no reclaim at
# all. It reached 128 tags per repo and filled guilder's disk, which is what
# kills the runner mid-build (verify passes, `build images` never concludes, no
# logs uploaded).
#
# ── The one thing this must never do ─────────────────────────────────────────
# Delete the tag prod is CURRENTLY running. ci-deploy.sh captures the running api
# image as PREV_TAG and rolls back with `compose pull` of that tag — so if it is
# gone from the registry, a failed deploy cannot roll back and prod stays broken.
# That is not hypothetical: when the deploy leg is wedged, prod sits many merges
# behind master (b5341a2 while master was 3 commits ahead), so the live tag can
# age out of a count-based window. Hence --pin / REGISTRY_GC_PIN, which the unit
# file sets to the live prod tag — keep that current, and re-check it after any
# stretch where deploys were failing.
#
# Deletes are by DIGEST, and a digest can carry several tags (every <sha> shares
# its digest with `latest` on the commit that pushed it). So the protected set is
# resolved to digests first, and any digest wearing a protected tag is skipped
# whole — otherwise deleting an old sha would silently take `latest` with it.
#
# Concurrency: the registry stays UP by default. Between a push's blob upload and
# its manifest PUT those blobs are unreferenced, so a GC racing a push can delete
# them and leave a corrupt image. The timer runs Sunday 04:30, clear of the
# Sun-03:00 prune and of any weekday merge. Pass --stop-registry to close that
# window for a manual run at a busy time; it restarts on every exit path. Default
# is registry-up because prune-docker.sh sets the house rule: a cleanup job must
# not be able to cause an outage.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

REGISTRY_URL="${REGISTRY_URL:-http://localhost:5000}"
# Auto-detected rather than hardcoded: SETUP-CI-PIPELINE.md starts the registry
# with `docker run --name registry`, while ci/registry/docker-compose.registry.yml
# names it servicepro-registry and is still marked "proposed". Guessing wrong
# means the blob GC silently never runs. Override with REGISTRY_CONTAINER.
REGISTRY_CONTAINER="${REGISTRY_CONTAINER:-}"
KEEP="${REGISTRY_GC_KEEP:-30}"
REPOS="${REGISTRY_GC_REPOS:-servicepro-api servicepro-client}"
PINS="${REGISTRY_GC_PIN:-}"
DRY_RUN=0
STOP_REGISTRY=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)       DRY_RUN=1 ;;
    --stop-registry) STOP_REGISTRY=1 ;;
    --keep)          KEEP="${2:?--keep needs a number}"; shift ;;
    --pin)           PINS="${PINS} ${2:?--pin needs a tag}"; shift ;;
    -h|--help)       sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

command -v jq >/dev/null 2>&1 || {
  echo "registry-gc: jq is required (apt-get install -y jq)" >&2; exit 2; }

if [ -z "$REGISTRY_CONTAINER" ]; then
  REGISTRY_CONTAINER="$(docker ps --filter 'ancestor=registry:2' --format '{{.Names}}' | head -1)"
fi
if [ -z "$REGISTRY_CONTAINER" ] || ! docker inspect "$REGISTRY_CONTAINER" >/dev/null 2>&1; then
  echo "registry-gc: no running registry:2 container found — set REGISTRY_CONTAINER" >&2
  exit 2
fi

# A manifest fetch must accept every media type `docker push` can produce, or the
# registry answers 404 and a live tag looks deletable when it is not.
ACCEPT='application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json'

NL=$'\n'

api() { curl -sS -m 30 "$@"; }

# Digest for a tag, from the header the registry returns on a manifest GET.
digest_of() {
  api -o /dev/null -D - -H "Accept: ${ACCEPT}" \
      "${REGISTRY_URL}/v2/$1/manifests/$2" \
    | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'
}

# Child manifest digests of an OCI index (empty for a plain v2 manifest).
# Includes attestation children — everything the index references.
children_of() {
  api -H "Accept: ${ACCEPT}" "${REGISTRY_URL}/v2/$1/manifests/$2" \
    | jq -r '.manifests[]?.digest // empty'
}

# Build time, read from the image config blob. Ordering only.
#
# Two manifest shapes have to work here. A plain v2 manifest carries
# .config.digest directly, but modern `docker push` publishes an OCI image INDEX
# whose .manifests[] point at per-platform children — and there .config is
# absent. Without the index branch every tag reads as undated, the fail-safe
# protects all of them, and the GC quietly reclaims nothing. Attestation entries
# in an index carry platform.architecture "unknown", so skip those and take the
# first real image.
created_of() {
  local repo="$1" tag="$2" man cfg child
  man="$(api -H "Accept: ${ACCEPT}" "${REGISTRY_URL}/v2/${repo}/manifests/${tag}")"
  cfg="$(printf '%s' "$man" | jq -r '.config.digest // empty')"
  if [ -z "$cfg" ]; then
    child="$(printf '%s' "$man" \
      | jq -r 'first(.manifests[]? | select((.platform.architecture // "unknown") != "unknown") | .digest) // empty')"
    [ -n "$child" ] || return 1
    cfg="$(api -H "Accept: ${ACCEPT}" "${REGISTRY_URL}/v2/${repo}/manifests/${child}" \
          | jq -r '.config.digest // empty')"
  fi
  [ -n "$cfg" ] || return 1
  api "${REGISTRY_URL}/v2/${repo}/blobs/${cfg}" | jq -r '.created // empty'
}

echo "[registry-gc] ${REGISTRY_URL} — keeping ${KEEP} newest per repo"
[ -n "${PINS// /}" ] && echo "[registry-gc] pinned: ${PINS}"
[ "$DRY_RUN" = "1" ] && echo "[registry-gc] DRY RUN — nothing will be deleted"

before="$(df -h --output=avail / | tail -1 | tr -d ' ')"

if [ "$STOP_REGISTRY" = "1" ] && [ "$DRY_RUN" = "0" ]; then
  # Guaranteed restart: a registry left stopped breaks every push AND leaves
  # registry-data eligible for `system prune --volumes`, the one command that
  # destroys every rollback target on the box.
  trap 'echo "[registry-gc] restarting ${REGISTRY_CONTAINER}"; docker start "$REGISTRY_CONTAINER" >/dev/null' EXIT
fi

total_deleted=0

for repo in $REPOS; do
  tags="$(api "${REGISTRY_URL}/v2/${repo}/tags/list" | jq -r '.tags[]?' || true)"
  if [ -z "$tags" ]; then
    echo "[registry-gc] ${repo}: no tags"
    continue
  fi
  n_tags="$(printf '%s\n' $tags | sed '/^$/d' | wc -l | tr -d ' ')"

  # Tags that are protected no matter what, and so must NOT compete for a slot
  # in the keep window. `latest` carries the same build time as the sha it was
  # pushed with, so leaving it in the ranking let it consume a slot and silently
  # made --keep N retain only N-1 real builds.
  always="$(printf '%s\n%s\n' "latest" "$PINS" | tr ' ' '\n' | sed '/^$/d' | sort -u)"

  # Order by build time, newest first. A tag whose timestamp cannot be read is
  # treated as PROTECTED rather than guessed at — never delete on missing data.
  dated=""
  undated=""
  for t in $tags; do
    if printf '%s\n' "$always" | grep -qx "$t"; then continue; fi
    if c="$(created_of "$repo" "$t" 2>/dev/null)" && [ -n "$c" ]; then
      dated="${dated}${c}	${t}${NL}"
    else
      undated="${undated}${t} "
      echo "[registry-gc] ${repo}: ${t} has no readable build time — protecting it"
    fi
  done

  keep_tags="$(printf '%s' "$dated" | sed '/^$/d' | sort -r | head -n "$KEEP" | cut -f2)"
  protected="$(printf '%s\n%s\n%s\n' "$keep_tags" "$always" "$undated" \
               | tr ' ' '\n' | sed '/^$/d' | sort -u)"

  # Resolve protection to digests: one digest, many tags. Children are collected
  # too — a child manifest can in principle be shared with a surviving index, and
  # deleting one out from under a live image is exactly the corruption this
  # script exists to avoid.
  protected_digests=""
  protected_children=""
  for t in $protected; do
    d="$(digest_of "$repo" "$t" || true)"
    [ -n "$d" ] && protected_digests="${protected_digests}${d}${NL}"
    for c in $(children_of "$repo" "$t" || true); do
      protected_children="${protected_children}${c}${NL}"
    done
  done
  protected_digests="$(printf '%s' "$protected_digests" | sed '/^$/d' | sort -u)"
  protected_children="$(printf '%s' "$protected_children" | sed '/^$/d' | sort -u)"

  # Candidates: every unprotected tag, minus any sharing a protected digest.
  # Tracked as "tag digest" pairs, not bare digests: a destructive plan has to
  # name the tags a human recognises, and several tags can map to one digest.
  del_pairs=""
  for t in $tags; do
    if printf '%s\n' "$protected" | grep -qx "$t"; then continue; fi
    d="$(digest_of "$repo" "$t" || true)"
    [ -n "$d" ] || continue
    if printf '%s\n' "$protected_digests" | grep -qx "$d"; then
      echo "[registry-gc] ${repo}: ${t} shares a digest with a protected tag — keeping"
      continue
    fi
    del_pairs="${del_pairs}${t} ${d}${NL}"
  done

  # One DELETE per digest, so collapse tags that share one. Counting is done on
  # the deduped list rather than with `wc -l` on a command substitution, whose
  # stripped trailing newline undercounts by one.
  del_digests="$(printf '%s' "$del_pairs" | sed '/^$/d' | awk '{print $2}' | sort -u)"
  n_del=0
  for d in $del_digests; do n_del=$((n_del + 1)); done
  n_keep=0
  for t in $protected; do n_keep=$((n_keep + 1)); done

  echo "[registry-gc] ${repo}: ${n_tags} tags → deleting ${n_del} manifests, keeping ${n_keep} (${protected//${NL}/ })"

  if [ "$n_del" = "0" ]; then continue; fi
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s' "$del_pairs" | sed '/^$/d' \
      | sed "s|^\\([^ ]*\\) \\(.*\\)$|[registry-gc]   would delete ${repo}:\\1 (\\2)|"
    continue
  fi

  # A tag points at an OCI INDEX whose per-platform children are themselves
  # manifests. Deleting only the index leaves those children in place, still
  # referencing every layer, so a plain garbage-collect reclaims nothing. The
  # obvious shortcut — `garbage-collect --delete-untagged` — is worse than
  # useless here: registry 2.8 does not treat index-referenced children as
  # tagged, so it deletes the children of SURVIVING indexes too and every
  # remaining image fails to pull with "short read ... unexpected EOF". Verified
  # against a throwaway registry. So: delete the children of doomed indexes
  # explicitly, skip any child a protected index still references, and run the
  # GC without --delete-untagged.
  for d in $del_digests; do
    for c in $(children_of "$repo" "$d" || true); do
      if printf '%s\n' "$protected_children" | grep -qx "$c"; then
        echo "[registry-gc] ${repo}: child ${c} is shared with a kept image — leaving it"
        continue
      fi
      api -o /dev/null -w '' -X DELETE "${REGISTRY_URL}/v2/${repo}/manifests/${c}" || true
    done
    code="$(api -o /dev/null -w '%{http_code}' -X DELETE "${REGISTRY_URL}/v2/${repo}/manifests/${d}")"
    case "$code" in
      202|404) total_deleted=$((total_deleted + 1)) ;;
      *) echo "[registry-gc] WARN ${repo}@${d} delete returned HTTP ${code}" >&2 ;;
    esac
  done
done

if [ "$DRY_RUN" = "1" ]; then
  echo "[registry-gc] dry run complete — re-run without --dry-run to apply"
  exit 0
fi

# Deleting manifests only unlinks them; the blobs are reclaimed here.
echo "[registry-gc] running blob garbage-collect (${total_deleted} manifests unlinked)"
if [ "$STOP_REGISTRY" = "1" ]; then
  echo "[registry-gc] stopping ${REGISTRY_CONTAINER} for an exclusive GC"
  docker stop "$REGISTRY_CONTAINER" >/dev/null
  # Container is down, so GC from a throwaway container on the same volume.
  docker run --rm --volumes-from "$REGISTRY_CONTAINER" registry:2 \
    bin/registry garbage-collect /etc/docker/registry/config.yml
else
  docker exec "$REGISTRY_CONTAINER" \
    bin/registry garbage-collect /etc/docker/registry/config.yml
fi

after="$(df -h --output=avail / | tail -1 | tr -d ' ')"
echo "[registry-gc] done — ${before} free → ${after} free"

avail_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [ "$avail_pct" -ge 85 ]; then
  echo "[registry-gc] WARNING: / still ${avail_pct}% used — check runner _work, _diag and the journal" >&2
fi
