# Deploying DocForge

One container on one small VPS (2 vCPU / 4 GB is comfortable; the container is
capped at 2 GB), Caddy in front for TLS, SQLite in a Docker volume, daily
snapshots shipped off-site with rclone. No managed database or queue needed.

| File | What it is |
| --- | --- |
| `../Dockerfile` | Playwright 1.63.0 (noble) image + `fonts-noto-core` (build fails if Noto Nastaliq Urdu is missing), `HEALTHCHECK` on `/healthz`, runs `node` directly so `SIGTERM` triggers a graceful shutdown. |
| `../.dockerignore` | Keeps `node_modules`, `data`, `.git`, `*.db`, `*.pdf`, `.env*` (except `.env.example`), `test` and `docs` out of the image. `deploy/` stays in: `admin.js` runs in the container. |
| `../.env.example` | Every environment variable the server reads, with defaults. Copy to `.env`. |
| `docker-run.sh` | (Re)starts the container: `--init`, `--restart unless-stopped`, `--memory 2g`, port bound to `127.0.0.1:3000` only, volume `docforge-data:/data`, `--env-file .env`. |
| `Caddyfile` | `YOUR-DOMAIN { reverse_proxy 127.0.0.1:3000 }` with automatic HTTPS. |
| `backup.sh` | Copies the server's daily snapshots from the volume's `backups/` dir to an R2/B2 rclone remote; deletes remote copies older than 7 days. |
| `restore.md` | Step-by-step restore from a local or off-site snapshot. |
| `admin.js` | Support CLI: `info`, `rotate`, `set-plan`, `suspend`, `unsuspend`. |

## First deploy

```sh
git clone <repo> /opt/docforge && cd /opt/docforge
cp .env.example .env    # set PUBLIC_URL, SUPPORT_EMAIL, TRUST_PROXY=1, RESEND_*, LS_*
docker build -t docforge .
sh deploy/docker-run.sh
curl -fsS http://127.0.0.1:3000/healthz

# Caddy (Debian/Ubuntu package): replace YOUR-DOMAIN with the PUBLIC_URL host
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

Point the domain's A/AAAA record at the VPS before reloading Caddy so it can get
a certificate. Open only ports 80 and 443 (and SSH) in the firewall; port 3000 is
bound to localhost.

Checklist for `.env`:

- `PUBLIC_URL` is the real `https://` origin. Watermark links, upgrade links,
  the sitemap, recovery emails and hosted file URLs are built from it.
- `TRUST_PROXY=1` only because Caddy is in front; without it every request
  shares Caddy's IP for rate limiting. Never set it when the port is exposed directly.
- `RESEND_API_KEY` and `MAIL_FROM` are needed for lost-key emails; without them
  the recovery mail is only logged.
- Lemon Squeezy: webhook URL `https://YOUR-DOMAIN/webhooks/lemonsqueezy`, secret in `LS_WEBHOOK_SECRET`, one
  `LS_VARIANT_*` per product variant (monthly and yearly). A live event for an
  unmapped variant returns 500 so Lemon Squeezy retries it after you fix `.env`.
  Payout options differ by country; see `docs/launch-checklist.md`.
- `RENDER_CONCURRENCY=2` is sized for the 2 GB cap. Each concurrent Chromium
  page adds memory, so raise it only together with `--memory` in `docker-run.sh`
  and watch `docker stats docforge` under load.

## Updating

```sh
cd /opt/docforge && git pull
docker build -t docforge . && sh deploy/docker-run.sh
```

`docker-run.sh` stops the old container with `docker stop -t 40` (graceful `SIGTERM`;
the 40s grace is longer than `RENDER_DEADLINE_MS`, so in-flight renders finish),
removes it and starts the new one on the same volume. Expect a few seconds of 502s
from Caddy during the swap. `docker ps` shows `(healthy)` once Chromium is up.

## Backups

The server snapshots the database to `BACKUP_DIR` (default `/data/backups`)
at startup and every 24 hours, keeping the newest 7. That protects against bad
writes, not against losing the VPS, so ship them off-site:

```sh
rclone config                         # create e.g. "r2" (S3, provider Cloudflare) or "b2"
sudo RCLONE_REMOTE=r2:docforge-backups deploy/backup.sh
```

Run it as root (the volume is root-owned) from root's crontab, for example:

```
17 3 * * * RCLONE_REMOTE=r2:docforge-backups /opt/docforge/deploy/backup.sh >> /var/log/docforge-backup.log 2>&1
```

Test a restore once before launch using `restore.md`; an untested backup is not a backup.

## Support tasks (`admin.js`)

```sh
docker exec docforge node deploy/admin.js info customer@example.com
docker exec docforge node deploy/admin.js rotate customer@example.com     # prints the new key
docker exec docforge node deploy/admin.js set-plan customer@example.com pro
docker exec docforge node deploy/admin.js suspend customer@example.com    # API returns 403 account_suspended
docker exec docforge node deploy/admin.js unsuspend customer@example.com
```

`rotate` invalidates the old key immediately; send the new one over a private
channel. Customers can also recover keys themselves via `/#recover` when email
is configured. `set-plan` is for comps and fixes; if the account has a Lemon
Squeezy subscription, its next webhook can change the plan again. Node may print
an `ExperimentalWarning` for `node:sqlite` on stderr; it is harmless.

## Logs and health

```sh
docker logs -f --since 1h docforge          # JSON lines: backup_ok, backup_failed, mail_skipped, ...
docker inspect --format '{{.State.Health.Status}}' docforge
```

Point a free external uptime checker at `https://YOUR-DOMAIN/healthz` so you
hear about outages before customers do.

## Upgrading from a root-run image

The image runs as the non-root `pwuser`. If your `docforge-data` volume was
created by an older image that ran as root, fix its ownership once before the
next `docker-run.sh`:

```sh
docker run --rm -u root -v docforge-data:/data docforge chown -R pwuser:pwuser /data
```

Also check `.env`: `DB_PATH` must be `/data/docforge.db` (or unset). Older
copies of `.env.example` set `./data/docforge.db`, which put the database in the
container layer where every redeploy deleted it. `docker-run.sh` now forces
`DB_PATH=/data/docforge.db`.

## Legal pages gate

In production the server exits at startup if `public/guides/terms.html`,
`privacy.html` or `refunds.html` still contain `[TODO` placeholders. Fill them
(legal name, city, jurisdiction, dates, host and region) before launch; for a
private staging run set `ALLOW_DRAFT_LEGAL=1` in `.env`. Until then those pages
are served with `noindex`, a visible draft note, and are left out of the sitemap.
