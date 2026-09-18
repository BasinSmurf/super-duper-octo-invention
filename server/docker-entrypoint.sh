#!/bin/sh
set -e

# Apply any pending Prisma migrations before starting the API.
# Runs on every container start; prisma migrate deploy is idempotent (skips
# migrations that are already applied), so this is safe on hot restarts.
#
# postgres: service_healthy in docker-compose ensures the DB is reachable by
# the time we get here, so we don't need a wait-for-it loop.
#
# If migrations fail, set -e halts the script and the container exits — the
# error surfaces in `docker logs api` rather than the API silently coming up
# against a stale schema.

echo "[entrypoint] Applying Prisma migrations..."
prisma migrate deploy

echo "[entrypoint] Starting API server..."
exec node dist/index.js
