# Restoring DocForge from a snapshot

Snapshots are `docforge-YYYY-MM-DD.db` files made by the server with `VACUUM INTO`
(consistent, no WAL needed). Local copies (newest 7) live in the `docforge-data`
volume under `backups/`; off-site copies (7 days) are on `$RCLONE_REMOTE`.

Run on the host, as root (the volume directory is root-owned).

1. Stop the container so nothing writes during the restore:

   ```sh
   docker stop docforge
   VOL="$(docker volume inspect --format '{{ .Mountpoint }}' docforge-data)"
   ```

2. Keep the current database aside, in case you need it back:

   ```sh
   cp "$VOL/docforge.db" "$VOL/docforge.db.before-restore-$(date +%F)"
   ```

3. Pick a snapshot. Either a local one:

   ```sh
   ls -l "$VOL/backups/"
   cp "$VOL/backups/docforge-2026-01-31.db" "$VOL/docforge.db"
   ```

   or an off-site one:

   ```sh
   rclone lsl "$RCLONE_REMOTE"
   rclone copyto "$RCLONE_REMOTE/docforge-2026-01-31.db" "$VOL/docforge.db"
   ```

4. Delete the stale WAL files. Leftover `-wal`/`-shm` files belong to the old
   database and would corrupt or override the restored one:

   ```sh
   rm -f "$VOL/docforge.db-wal" "$VOL/docforge.db-shm"
   ```

5. Start and verify:

   ```sh
   docker start docforge
   curl -fsS http://127.0.0.1:3000/healthz && echo
   docker exec docforge node deploy/admin.js info <a known customer email>
   curl -fsS https://YOUR-DOMAIN/v1/me -H "Authorization: Bearer <a known API key>"
   ```

   `/healthz` must return 200 and `/v1/me` must show the expected plan and usage.

Anything created after the snapshot (new signups, rotated keys, template edits,
usage counters) is lost. Accounts that upgraded in that window get their plan
back on the next Lemon Squeezy webhook for their subscription; check the Lemon
Squeezy dashboard for orders since the snapshot date and fix any gaps with
`node deploy/admin.js set-plan`. Hosted `output:'url'` files are not in the
snapshot; they expire after 24 hours anyway.
