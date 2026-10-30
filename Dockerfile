# Playwright image ships the exact Chromium that playwright-core 1.63.0 expects.
FROM mcr.microsoft.com/playwright:v1.63.0-noble
# Noto fonts cover non-Latin invoices (Urdu Nastaliq, Arabic, Devanagari, ...).
# The build fails if Noto Nastaliq Urdu is missing, so Urdu text never renders as boxes.
RUN apt-get update && apt-get install -y --no-install-recommends fonts-noto-core \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f \
  && fc-list | grep -qi "Noto Nastaliq Urdu"
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV DB_PATH=/data/docforge.db
# Untrusted customer/demo HTML is rendered by Chromium (--no-sandbox), so never run as root.
# pwuser is the Playwright image's built-in non-root user.
RUN mkdir -p /data/backups /data/files && chown -R pwuser:pwuser /data /app
USER pwuser
VOLUME /data
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run node directly (not via npm) so SIGTERM reaches the server's graceful shutdown.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
