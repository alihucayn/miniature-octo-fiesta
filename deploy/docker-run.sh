#!/usr/bin/env sh
# Build and (re)start DocForge on a single VPS. Run from the repo root:
#   docker build -t docforge . && sh deploy/docker-run.sh
# Binds to localhost only; Caddy (deploy/Caddyfile) terminates TLS in front of it.
# .env must set TRUST_PROXY=1 and PUBLIC_URL=https://<your domain>.
set -eu
# docker stop sends SIGTERM and waits longer than RENDER_DEADLINE_MS (30s) so in-flight renders finish.
docker stop -t 40 docforge 2>/dev/null || true
docker rm docforge 2>/dev/null || true
# -e DB_PATH after --env-file so the DB always lives on the docforge-data volume.
docker run -d --name docforge --init --restart unless-stopped --memory 2g --stop-timeout 40 \
  --log-opt max-size=10m --log-opt max-file=5 \
  -p 127.0.0.1:3000:3000 -v docforge-data:/data --env-file .env \
  -e DB_PATH=/data/docforge.db docforge
