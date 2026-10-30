#!/usr/bin/env bash
# Off-site copy of DocForge's SQLite snapshots.
#
# The server itself writes a consistent snapshot (VACUUM INTO) to
# BACKUP_DIR=/data/backups once a day and keeps the newest 7 locally.
# This script copies them from the docforge-data volume to an rclone remote
# (Cloudflare R2 or Backblaze B2) and deletes remote copies older than 7 days.
#
# Setup (on the host, once):
#   rclone config          # create a remote, e.g. "r2" (S3 provider Cloudflare) or "b2"
#   export RCLONE_REMOTE=r2:docforge-backups
#
# Crontab example (host, daily at 03:17 after the in-process snapshot):
#   17 3 * * * RCLONE_REMOTE=r2:docforge-backups /opt/docforge/deploy/backup.sh >> /var/log/docforge-backup.log 2>&1
set -euo pipefail

: "${RCLONE_REMOTE:?set RCLONE_REMOTE, e.g. r2:docforge-backups}"
VOLUME="${DOCFORGE_VOLUME:-docforge-data}"

MOUNTPOINT="$(docker volume inspect --format '{{ .Mountpoint }}' "$VOLUME")"
SRC="$MOUNTPOINT/backups"
if [ ! -d "$SRC" ] || ! ls "$SRC"/docforge-*.db >/dev/null 2>&1; then
  echo "$(date -Is) no snapshots in $SRC (is the container running with BACKUP_DIR=/data/backups?)" >&2
  exit 1
fi

# copy (not sync): remote keeps files the local 7-day rotation already removed.
rclone copy "$SRC" "$RCLONE_REMOTE" --include 'docforge-*.db'
rclone delete "$RCLONE_REMOTE" --min-age 7d --include 'docforge-*.db'
echo "$(date -Is) backup ok: $(ls "$SRC"/docforge-*.db | wc -l) local snapshots copied to $RCLONE_REMOTE"
