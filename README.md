# DocForge: JSON → PDF API

Send JSON, get a pixel-perfect PDF. DocForge renders invoices, receipts, certificates, quotes and packing
slips from HTML + Handlebars templates through one HTTP call. It ships with a landing page, a no-signup live demo,
API-key accounts, monthly quotas, stored templates and Lemon Squeezy subscription billing.

**Goal:** $100–500/month, which is 10–40 paying customers on the $9/$29 plans.

---

## 1. Why this product (research summary, Oct 2026)

| Signal | What it shows |
|---|---|
| Api2Pdf reportedly reached **~$10K/mo**; PDFShift **~$7.2K/mo** ([Indie Hackers](https://www.indiehackers.com/post/this-week-in-micro-saas-simple-pdf-tool-10k-mrr-revenue-and-more-9ab80ccbb5)) | Solo founders make real money from PDF-generation APIs |
| TrustMRR-verified: PDFBolt, pdfs.build (~$15K MRR), Docstron ([PDFBolt](https://trustmrr.com/startup/pdfbolt?metric=mrr), [pdfs.build](https://trustmrr.com/startup/pdfs-build)) | Several new entrants since 2024 are still growing, so demand is not saturated |
| Incumbent prices: PDFMonkey €19 for 300 docs ([pricing](https://pdfmonkey.io/pricing/)), CraftMyPDF $29, APITemplate $19–24 ([comparison](https://freetier.co/compare/apitemplateio-vs-craftmypdf)), PDFShift $9 for 500 ([Capterra](https://www.capterra.com/p/184246/PDFShift/)) | DocForge at **$9 for 2,000 docs** is clearly cheaper, with a usable free tier |
| Bank-statement converters: crowded, tens to hundreds of $/mo ([Flippa](https://flippa.com/12279501), [microns](https://www.microns.io/startup-listings/ai-bank-statement-parser)) | Rejected: many entrants, accuracy-heavy, low revenue |
| Generic invoice generators: "pick a niche or don't compete" ([Questera](https://www.questera.ai/blogs/build-invoice-generator-saas-with-ai)) | Rejected as a consumer app; invoices are instead a template inside an API sold to developers |

**Why an API rather than a consumer tool:** developers integrate it once and then pay every month
(low churn), there is no per-customer support for document content, and costs are tiny: one $6–12/mo VPS
renders tens of thousands of PDFs a month.

## 2. Pricing (in `src/plans.js`)

| Plan | Price | PDFs/month | Templates | Watermark |
|---|---|---|---|---|
| Free | $0 | 100 | 3 | small footer (free marketing) |
| Starter | $9 | 2,000 | 20 | no |
| Pro | $29 | 15,000 | 100 | no |
| Business | $79 | 60,000 | 500 | no |

Paths to the target: 12 Starter + 6 Pro ≈ **$282/mo**, or 3 Business + 8 Pro ≈ **$469/mo**.

## 3. Go-to-market plan (first 90 days)

1. **Deploy** on a $6 VPS (Hetzner/DigitalOcean) with Docker, behind Caddy for HTTPS, on a cheap `.dev`/`.io` domain.
2. **SEO pages that bring developers in:** one page per template ("invoice PDF API", "certificate generator API",
   "HTML to PDF in Node/Python/PHP/Laravel/Django"). These long-tail queries drive most traffic for this category.
3. **Listings (free, one-off):** RapidAPI, Product Hunt, Hacker News "Show HN", Indie Hackers, alternativeTo
   (as an alternative to PDFMonkey/CraftMyPDF/APITemplate), SaaSHub, Peerlist, TrustMRR once revenue starts.
4. **No-code channel:** publish ready-made Make/Zapier/n8n recipes ("Stripe payment → PDF receipt → email").
   No-code users pay without haggling and rarely churn.
5. **Answer questions:** Stack Overflow / Reddit threads about Puppeteer PDF pain (memory leaks, fonts, page
   breaks), linking to the free tier.
6. **Watermark loop:** every free-plan PDF carries "Generated with DocForge", which acts as free distribution.

## 4. Running it

Requires Node ≥ 22.5 (uses the built-in `node:sqlite`) and a Chromium that matches `playwright-core@1.63.0`.

```bash
npm install
npx playwright-core install chromium   # skip if a matching Chromium is already installed
cp .env.example .env                     # then fill in values
npm start                                # http://localhost:3000
npm test                                 # 11 API + rendering tests
```

Docker:

```bash
docker build -t docforge .
docker run -p 3000:3000 -v docforge-data:/data --env-file .env docforge
```

## 5. Billing setup (Lemon Squeezy)

1. Create one product with three subscription variants (Starter $9, Pro $29, Business $79).
2. Put each variant ID in `LS_VARIANT_*` and its checkout link in `LS_CHECKOUT_*`.
3. Add a webhook to `https://YOUR-DOMAIN/webhooks/lemonsqueezy` for `subscription_*` events and copy its
   signing secret into `LS_WEBHOOK_SECRET`.
4. Customers call `GET /v1/billing/checkout?plan=pro`. The returned URL carries their account ID, so the
   webhook upgrades the right account automatically, and an expired subscription drops back to Free.

> **Check payouts first.** Before launch, confirm the payment provider can pay out to your country and bank
> (Lemon Squeezy, Paddle and Polar each publish supported payout countries). All billing logic sits in one webhook
> handler in `src/server.js` plus `src/plans.js`, so switching to Paddle or another merchant of record is a small change.

## 6. Architecture

```
src/server.js   Express API: signup, auth, templates CRUD, render, demo, billing webhook
src/render.js   Handlebars + helpers, Chromium (playwright-core) PDF rendering, concurrency queue, SSRF guard
src/db.js       SQLite (node:sqlite): accounts (hashed keys), templates, monthly usage counters
src/plans.js    Plans, limits and the payment-variant → plan mapping
gallery/        5 built-in templates (invoice, receipt, certificate, quote, packing slip)
public/         Landing page with live demo and pricing, plus API docs (/docs)
test/           node:test suite
```

Safety and cost controls:
- API keys are stored only as SHA-256 hashes.
- Quotas are reserved atomically in SQL, so concurrent requests can't overshoot them. Failed renders are refunded.
- JavaScript in templates is disabled. Assets load only over `https:` from public IPs, which blocks SSRF to
  cloud metadata and internal services. `data:` URIs are allowed.
- Per-IP rate limits apply to signup and the public demo. Body size and template size are capped.

## 7. Next steps (in priority order)

- Email-based key recovery and a small dashboard (needs an SMTP/Resend key).
- A visual template editor with live preview (the biggest differentiator in reviews of competitors).
- Async rendering with webhooks plus S3/R2 storage links, for large batches.
- Merging and appending existing PDFs (e.g. terms & conditions) to rendered documents.
