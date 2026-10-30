# DocForge: JSON → PDF API

Send JSON, get a pixel-perfect PDF. DocForge renders invoices, receipts, certificates, quotes and packing
slips from HTML + Handlebars templates through one HTTP call. It ships with a landing page, a no-signup live demo,
API-key accounts, monthly quotas, stored templates and Lemon Squeezy subscription billing.

**Goal:** $100–500/month, which is roughly 8–25 paying customers on the $15/$39 plans.

**Before launch, work through [`docs/launch-checklist.md`](docs/launch-checklist.md)** (payouts, name, domain,
email, legal pages, billing test, ops). Launch copy is in [`docs/launch/show-hn.md`](docs/launch/show-hn.md).

---

## 1. Why this product (research summary, Oct 2026)

| Signal | What it shows |
|---|---|
| Api2Pdf reportedly reached **~$10K/mo**; PDFShift **~$7.2K/mo** ([Indie Hackers](https://www.indiehackers.com/post/this-week-in-micro-saas-simple-pdf-tool-10k-mrr-revenue-and-more-9ab80ccbb5)) | Solo founders make real money from PDF-generation APIs |
| TrustMRR-verified: PDFBolt, pdfs.build (~$15K MRR), Docstron ([PDFBolt](https://trustmrr.com/startup/pdfbolt?metric=mrr), [pdfs.build](https://trustmrr.com/startup/pdfs-build)) | Several new entrants since 2024 are still growing, so demand is not saturated |
| Incumbent prices (see the table in section 2) | DocForge at **$15 for 2,500 docs** ($6 per 1,000) undercuts the per-document price, with a usable free tier |
| Bank-statement converters: crowded, tens to hundreds of $/mo ([Flippa](https://flippa.com/12279501), [microns](https://www.microns.io/startup-listings/ai-bank-statement-parser)) | Rejected: many entrants, accuracy-heavy, low revenue |
| Generic invoice generators: "pick a niche or don't compete" ([Questera](https://www.questera.ai/blogs/build-invoice-generator-saas-with-ai)) | Rejected as a consumer app; invoices are instead a template inside an API sold to developers |

**Why an API rather than a consumer tool:** developers integrate it once and then pay every month
(low churn), there is no per-customer support for document content, and costs are tiny: one 4 GB VPS (e.g. Hetzner CX22, price checked [TODO YYYY-MM])
renders tens of thousands of PDFs a month.

## 2. Pricing (in `src/plans.js`)

| Plan | Monthly | Yearly (10x) | PDFs/month | Cost per 1,000 | Templates | Watermark |
|---|---|---|---|---|---|---|
| Free | $0 | – | 100 | – | 3 | small linked footer (free marketing) |
| Starter | $15 | $150 | 2,500 | $6.00 | 20 | no |
| Pro | $39 | $390 | 10,000 | $3.90 | 100 | no |
| Business | $99 | $990 | 50,000 | $1.98 | 500 | no |

Paid plans get a **10% grace band**: renders past the limit keep working (with `X-Quota-Warning: over_limit` and
`X-Upgrade-Url` headers) until 110%, then return 402 `quota_exceeded` with `upgrade_urls`. Static pages read prices
from `/v1/plans` through `site.js`, so `src/plans.js` is the single place to change them.

**Path to the target, net of Lemon Squeezy fees (5% + $0.50 per payment, verify):**
10 Starter + 5 Pro = $345 gross; fees ≈ $17.25 + $7.50 = $24.75, so ≈ $320, and **about $315 net** after
payout/FX costs (record the real payout cost in the checklist). 3 Business + 5 Pro = $492 gross, about $455 net.

### Competitors: checked [TODO YYYY-MM], verify before quoting

| Product | Entry paid plan | Docs included | Cost per 1,000 | Source |
|---|---|---|---|---|
| PDFMonkey | €19/mo | 300 | ≈ €63 | [pricing](https://pdfmonkey.io/pricing/) |
| APITemplate.io | $19–24/mo | TODO | TODO | [comparison](https://freetier.co/compare/apitemplateio-vs-craftmypdf) |
| CraftMyPDF | $29/mo | TODO | TODO | [comparison](https://freetier.co/compare/apitemplateio-vs-craftmypdf) |
| PDFShift | $9/mo | 500 | $18 | [Capterra](https://www.capterra.com/p/184246/PDFShift/) |
| Api2Pdf | usage-based | – | TODO | TODO |
| PDFBolt | TODO | TODO | TODO | TODO |
| pdfs.build | TODO | TODO | TODO | TODO |
| DocRaptor | TODO | TODO | TODO | TODO |
| **DocForge Starter** | $15/mo | 2,500 | $6.00 | `src/plans.js` |

Every number in this table must be re-checked on the vendor's own pricing page before it appears on a public
page (checklist step 9). Leave a cell as TODO rather than guess.

### Getting paid from Pakistan

Stripe does not onboard Pakistani entities and **PayPal cannot receive payments in Pakistan**, so DocForge bills
through Lemon Squeezy as merchant of record. Whether Lemon Squeezy pays out to a Pakistani bank account or
Payoneer must be confirmed in its payout settings before launch; the fallbacks (Polar, then Paddle with Payoneer)
and the Polar switch spec are in [checklist step 1](docs/launch-checklist.md#1-payouts-first-blocks-everything-else).

## 3. Go-to-market

**Niche:** invoices and receipts generated from **Stripe, WooCommerce and no-code tools** (Make, Zapier, n8n) by
developers and small SaaS/ecommerce operators. Not merchant-of-record sellers (Lemon Squeezy, Paddle, Gumroad
users already get invoices from their provider), and not "HTML to PDF for everything".

1. **Pre-launch blockers:** everything in [`docs/launch-checklist.md`](docs/launch-checklist.md) steps 1–9
   (payouts, name, domain, support email, legal pages, test purchase and refund, store activation, deploy +
   backups + monitoring, verified competitor prices).
2. **Week 1: launch.** Listings with `?ref=` on every link (Search Console, RapidAPI via `/openapi.json`,
   alternativeTo, SaaSHub, Toolradar, Peerlist, Indie Hackers, Product Hunt), Show HN last
   ([copy](docs/launch/show-hn.md)). The **linked watermark loop** runs from day one: every free-plan PDF carries
   "Made with DocForge · <host>" linking to `/?ref=pdf`, and demo PDFs link to `/?ref=demo`.
3. **Weeks 2–6: guides and recipes.** One page per niche query under `/guides/` (invoice/receipt/certificate/quote/
   packing-slip PDF API, Stripe invoice PDF, Laravel HTML to PDF, competitor alternatives), plus copy-paste
   Make/Zapier/n8n recipes ("Stripe payment → PDF receipt → email"). Answer Stack Overflow/Reddit questions about
   Puppeteer PDF pain where the answer genuinely fits.
4. **Expand only when Search Console shows impressions** for a query cluster: write more pages around what is
   already getting impressions instead of new categories.
5. **Every Monday:** signups by source, activated accounts and paid accounts
   ([queries](docs/launch-checklist.md#11-weekly-metrics-every-monday)).

## 4. Running it

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`) and a Chromium that matches `playwright-core@1.63.0`.

```bash
npm install
npx playwright-core install chromium   # skip if a matching Chromium is already installed
cp .env.example .env                     # then fill in values
npm start                                # http://localhost:3000
npm test
```

### Production

- A VPS with **at least 4 GB RAM** (e.g. Hetzner CX22). Chromium is the memory hog; 1–2 GB boxes fall over under load.
- Build and run with `deploy/docker-run.sh`, which does:

  ```bash
  docker build -t docforge .
  docker run -d --name docforge --init --restart unless-stopped --memory 2g --stop-timeout 40 \
    --log-opt max-size=10m --log-opt max-file=5 \
    -p 127.0.0.1:3000:3000 -v docforge-data:/data --env-file .env \
    -e DB_PATH=/data/docforge.db docforge
  ```

- Keep `RENDER_CONCURRENCY=2` (default) on a 4 GB box; raise it only after a load test.
- Put **Caddy** in front for HTTPS using `deploy/Caddyfile`, and set `TRUST_PROXY=1` so per-IP limits see real
  client IPs. The container only listens on `127.0.0.1`, so it is not reachable around Caddy.
- Set `PUBLIC_URL`, `SUPPORT_EMAIL`, `RESEND_API_KEY`/`MAIL_FROM` and the `LS_*` variables (see `.env.example`).
- Monitor `GET /healthz` (e.g. UptimeRobot).

### Backups & restore

- The database is one SQLite file in the `docforge-data` volume (`DB_PATH`, default `/data/docforge.db`).
  Rendered files for `output: "url"` live in `FILES_DIR` and expire after 24 hours, so they are not backed up.
- The server itself snapshots the DB (`VACUUM INTO`) to `BACKUP_DIR` (default `/data/backups`) as
  `docforge-YYYY-MM-DD.db` at startup and every 24h, keeping the newest 7.
- `deploy/backup.sh` copies those snapshots off-site with rclone (keeping 7 days) and needs `RCLONE_REMOTE`; without it
  the script exits 1. Cron: `17 3 * * * RCLONE_REMOTE=r2:docforge-backups /opt/docforge/deploy/backup.sh`. See deploy/README.md.
- Restoring is documented in `deploy/restore.md`. Do one restore drill before launch (checklist step 8).

## 5. Billing setup (Lemon Squeezy)

1. Create one product with subscription variants: Starter $15, Pro $39, Business $99 monthly, and yearly variants
   at 10x ($150/$390/$990).
2. Put each variant ID in `LS_VARIANT_*` (yearly ones in `LS_VARIANT_*_YEARLY`) and each checkout link in `LS_CHECKOUT_*`.
3. Add a webhook to `https://YOUR-DOMAIN/webhooks/lemonsqueezy` for `subscription_*`, `subscription_payment_refunded`
   and `order_refunded` events and copy its signing secret into `LS_WEBHOOK_SECRET`.
4. Customers call `GET /v1/billing/checkout?plan=pro`. The returned URL carries their account ID, so the
   webhook upgrades the right account automatically. An expired or refunded subscription drops back to Free (only when
   the subscription id matches), and an unknown live variant returns 500 so the problem is visible and retried.
5. Complete one test-mode purchase and one refund end to end before submitting the store (checklist step 6).

> **Check payouts first.** PayPal cannot receive in Pakistan and Stripe is unavailable, so confirm Lemon Squeezy
> pays out to a Pakistani bank or Payoneer before launch. Fallbacks and the Polar switch spec are in
> [`docs/launch-checklist.md`](docs/launch-checklist.md).

## 6. Architecture

```
src/server.js   Express API: signup, auth, templates CRUD, render, demo, billing webhook
src/render.js   Handlebars + helpers, Chromium (playwright-core) PDF rendering, concurrency queue, SSRF guard
src/db.js       SQLite (node:sqlite): accounts (hashed keys), templates, monthly usage counters
src/plans.js    Plans, limits and the payment-variant → plan mapping
gallery/        5 built-in templates (invoice, receipt, certificate, quote, packing slip)
public/         Landing page with live demo and pricing, plus API docs (/docs)
test/           node:test suite
deploy/         docker-run.sh, Caddyfile, backup.sh, restore.md
docs/           launch checklist, launch copy, post-launch roadmap specs
```

Safety and cost controls:
- API keys are stored only as SHA-256 hashes.
- Quotas are reserved atomically in SQL, so concurrent requests can't overshoot them. Failed renders are refunded.
- JavaScript in templates is disabled. Assets load only over `https:` from public IPs, which blocks SSRF to
  cloud metadata and internal services. `data:` URIs are allowed.
- Per-IP rate limits apply to signup and the public demo. Body size and template size are capped.

## 7. Roadmap

Done:
- Email-based API key recovery (`POST /v1/keys/recover`, link to `/#recover=<token>`).
- 10% grace band on paid plans with upgrade headers and `upgrade_urls`.
- `output: "url"` (24-hour download links) and `base64` output.
- `header_html`/`footer_html` with page numbers; `qr` helper.

Next (after the first paying customer; specs in [`docs/roadmap-specs.md`](docs/roadmap-specs.md)):
- **MCP server** (`docforge-mcp`, separate package) so Claude Desktop/Cursor users can render PDFs with their key.
- **Template editor** (`public/editor.html`) with a client-side preview and metered "Render real PDF".

Later, only if customers ask:
- Async rendering with webhooks for large batches.
- Merging and appending existing PDFs (e.g. terms & conditions) to rendered documents.
