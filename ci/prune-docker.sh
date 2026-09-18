#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# prune-docker.sh — scheduled disk reclaim for the CI build host and the prod VM.
#
#   ./ci/prune-docker.sh build   # Hyper-V build runner — aggressive
#   ./ci/prune-docker.sh prod    # prod VM — conservative, keeps rollback targets
#
# Why two profiles: ci.yml tags two images per master commit and nothing ever
# removed them, so the build host filled up and CI died mid-log-write. On the
# build host those images are pure cache (the registry holds the real copies),
# so they can go early. On prod they ARE the rollback path — ci-deploy.sh swaps
# back to the previously-running tag when a health check fails — so prod keeps a
# month of them.
#
# What this NEVER does, on either host:
#   - `--volumes` anything. That's the Postgres data on prod and the registry
#     store on the build host. A cleanup job must not be able to cause an outage.
#   - touch images backing a running container (docker's own rule for `-a`, but
#     the retention windows below mean we don't lean on it).
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

PROFILE="${1:-build}"

case "$PROFILE" in
  build) BUILD_CACHE=1; IMAGE_AGE="336h" ;;  # 14d — a fortnight of merges
  prod)  BUILD_CACHE=0; IMAGE_AGE="720h" ;;  # 30d — well past any rollback window
  *) echo "usage: prune-docker.sh [build|prod]" >&2; exit 2 ;;
esac

before="$(df -h --output=avail / | tail -1 | tr -d ' ')"
echo "[prune:${PROFILE}] starting — ${before} free on /"

if [ "$BUILD_CACHE" = "1" ]; then
  # The single biggest reclaim on a build host, and the safest: layer cache only.
  docker builder prune -af
fi

# Dangling layers first (cheap, zero retention concerns), then aged tagged images.
docker image prune -f
docker image prune -af --filter "until=${IMAGE_AGE}"

after="$(df -h --output=avail / | tail -1 | tr -d ' ')"
echo "[prune:${PROFILE}] done — ${before} free → ${after} free"

# Loud enough to notice in `journalctl -u sundog-prune`, since a prune that stops
# reclaiming anything means the real growth is somewhere docker doesn't own
# (runner _work checkouts, _diag logs, journal).
avail_pct="$(df --output=pcent / | tail -1 | tr -dc '0-9')"
if [ "$avail_pct" -ge 85 ]; then
  echo "[prune:${PROFILE}] WARNING: / still ${avail_pct}% used after prune — investigate non-docker growth" >&2
fi
