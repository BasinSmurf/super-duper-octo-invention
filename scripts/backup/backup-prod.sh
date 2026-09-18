#!/usr/bin/env bash
#
# Sundog nightly backup — Postgres dump + file storage volume → S3.
#
# Setup:
#   1. Install aws-cli on the prod box: `sudo apt install awscli` (or v2 from AWS).
#   2. Configure creds with a least-privilege IAM user that has
#      s3:PutObject, s3:GetObject, s3:DeleteObject, s3:ListBucket on one bucket.
#      `aws configure` writes to ~/.aws/credentials.
#   3. Create an env file at /home/sundog/sundog-backup.env (chmod 600):
#         BACKUP_S3_BUCKET=sundog-backups
#         BACKUP_S3_PREFIX=prod
#         AWS_DEFAULT_REGION=us-east-2     # or wherever
#         # PG_USER, PG_DB, PG_CONTAINER override defaults if your stack differs
#   4. Apply scripts/backup/lifecycle.json to the bucket so old dumps tier into
#      Glacier IR → Deep Archive (one-time):
#         aws s3api put-bucket-lifecycle-configuration \
#           --bucket sundog-backups \
#           --lifecycle-configuration file://scripts/backup/lifecycle.json
#      Strategy: Standard for 30 days (instant restore), Glacier IR for the
#      next 60 (~ms retrieval at ~1/4 cost), Deep Archive after 90 days
#      (~$1/TB/month, 12-hour thaw), expire at 365 days.
#   5. Add to crontab (`sudo crontab -e` or user crontab if user has docker access):
#         30 2 * * * . /home/sundog/sundog-backup.env && /home/sundog/sundog/scripts/backup/backup-prod.sh
#      (2:30 AM UTC = before the day's first techs hit the road in MT/CT.)
#   6. Tail /var/log/sundog-backup.log the next morning to confirm it ran.
#   7. Run scripts/backup/restore-prod.sh against a throwaway VM monthly to
#      prove backups actually restore. Untested backups are not backups.

set -euo pipefail

# ─── Config (override via env file) ────────────────────────────────────────
S3_BUCKET="${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET must be set, e.g. sundog-backups}"
S3_PREFIX="${BACKUP_S3_PREFIX:-prod}"
PG_CONTAINER="${PG_CONTAINER:-servicepro-postgres}"
PG_USER="${PG_USER:-servicepro}"
PG_DB="${PG_DB:-servicepro}"
STORAGE_VOLUME_PATH="${STORAGE_VOLUME_PATH:-/var/lib/docker/volumes/servicepro_api-storage/_data}"
LOCAL_RETENTION_DAYS="${LOCAL_RETENTION_DAYS:-3}"
TMP_DIR="${TMP_DIR:-/tmp/sundog-backup}"
LOG_FILE="${LOG_FILE:-/var/log/sundog-backup.log}"

DATE_STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DATE_DAY="$(date -u +%Y-%m-%d)"

mkdir -p "$TMP_DIR"
# Ensure log file is writable; fall back to TMP_DIR if /var/log isn't writable.
if ! touch "$LOG_FILE" 2>/dev/null; then
  LOG_FILE="$TMP_DIR/sundog-backup.log"
  touch "$LOG_FILE"
fi

log() {
  printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" | tee -a "$LOG_FILE"
}

fail() {
  log "ERROR: $*"
  # Hook a notifier here if you want — e.g. curl to a Slack webhook,
  # or `mail -s "Sundog backup failed" you@example.com < "$LOG_FILE"`.
  exit 1
}

# ─── Pre-flight ───────────────────────────────────────────────────────────
command -v aws   >/dev/null || fail "aws CLI not found in PATH"
command -v gzip  >/dev/null || fail "gzip not found"
command -v tar   >/dev/null || fail "tar not found"
command -v sudo  >/dev/null || fail "sudo not found"

# Cheap reachability + auth check before we burn time on the dump.
aws s3 ls "s3://$S3_BUCKET" >/dev/null 2>&1 \
  || fail "Cannot list s3://$S3_BUCKET — check credentials, region, and bucket name"

log "── Backup start: $DATE_STAMP ──"

# ─── Postgres dump ────────────────────────────────────────────────────────
DUMP_FILE="$TMP_DIR/pg-${DATE_STAMP}.sql.gz"
log "Dumping postgres ($PG_DB)…"

# pg_dump runs INSIDE the container; pipe stdout out and gzip on the host.
# --clean --if-exists makes restores idempotent against a non-empty target.
sudo docker exec "$PG_CONTAINER" \
  pg_dump -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
  | gzip -9 > "$DUMP_FILE" \
  || fail "pg_dump failed"

DUMP_SIZE="$(du -h "$DUMP_FILE" | cut -f1)"
log "Dump complete: $(basename "$DUMP_FILE") ($DUMP_SIZE)"

# ─── File storage tarball ────────────────────────────────────────────────
STORAGE_FILE="$TMP_DIR/storage-${DATE_STAMP}.tar.gz"
if sudo test -d "$STORAGE_VOLUME_PATH"; then
  log "Archiving file storage volume…"
  # --warning=no-file-changed silences warnings when techs upload concurrently.
  sudo tar --warning=no-file-changed -czf "$STORAGE_FILE" -C "$STORAGE_VOLUME_PATH" . \
    || fail "Storage tar failed"
  sudo chown "$(id -u):$(id -g)" "$STORAGE_FILE"
  STORAGE_SIZE="$(du -h "$STORAGE_FILE" | cut -f1)"
  log "Storage archive: $(basename "$STORAGE_FILE") ($STORAGE_SIZE)"
else
  log "WARN: Storage volume not found at $STORAGE_VOLUME_PATH — skipping"
fi

# ─── Upload to S3 ─────────────────────────────────────────────────────────
S3_DAILY="s3://$S3_BUCKET/$S3_PREFIX/daily/$DATE_DAY"

log "Uploading dump → $S3_DAILY/"
aws s3 cp --no-progress "$DUMP_FILE" "$S3_DAILY/" \
  || fail "S3 upload (dump) failed"

if [ -f "$STORAGE_FILE" ]; then
  log "Uploading storage tarball → $S3_DAILY/"
  aws s3 cp --no-progress "$STORAGE_FILE" "$S3_DAILY/" \
    || fail "S3 upload (storage) failed"
fi

# ─── Local cleanup ───────────────────────────────────────────────────────
log "Pruning local copies older than $LOCAL_RETENTION_DAYS days from $TMP_DIR…"
find "$TMP_DIR" -maxdepth 1 -type f -mtime +"$LOCAL_RETENTION_DAYS" \
  \( -name 'pg-*.sql.gz' -o -name 'storage-*.tar.gz' \) \
  -print -delete \
  || log "WARN: local prune failed (non-fatal)"

log "── Backup complete: $DATE_STAMP ──"
