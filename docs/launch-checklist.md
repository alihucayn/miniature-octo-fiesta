# DocForge launch checklist

Work through this in order. Each step unblocks the next; do not skip ahead to distribution (step 10) while
anything in steps 1-8 is open. Founder details, dates and measured numbers are `TODO` until you fill them in.

Decision log (fill in as you go):

| Decision | Choice | Date | Notes |
|---|---|---|---|
| Payment provider / payout route | TODO | TODO | payout fee + FX cost: TODO |
| Product name | TODO (rename or "DocForge PDF API") | TODO | |
| Domain | TODO | TODO | |
| Support inbox | TODO (Cloudflare Email Routing / Zoho) | TODO | |
| Measured demo p50 | TODO ms | TODO | used in docs/launch/show-hn.md |

---

## 1. Payouts first (blocks everything else)

Stripe does not onboard Pakistani entities, and PayPal cannot receive payments in Pakistan, so the payout route
decides which billing provider the code uses. Verify it before building anything else on top of it.

- [ ] Open a Lemon Squeezy store (free) with the founder's real identity: TODO founder legal name, TODO country of residence.
- [ ] In Lemon Squeezy **Settings → Payouts**, check whether a Pakistani bank account (IBAN, PKR or USD) or a
      Payoneer receiving account is accepted. Screenshot the result for the decision log.
- [ ] If Lemon Squeezy pays out: record the payout method, payout fee and FX spread (bank's USD→PKR rate vs.
      interbank on the payout day). Keep the existing `/webhooks/lemonsqueezy` integration. Go to step 2.
- [ ] If Lemon Squeezy does not pay out, evaluate **Polar** next. Polar pays out through Stripe Connect Express.
      Whether an individual resident in Pakistan can complete Connect Express onboarding is disputed: verify by
      actually starting onboarding, not from forum posts. Record the outcome.
- [ ] If Polar is not possible, evaluate **Paddle** with payouts to Payoneer (Paddle reviews sellers manually and
      wants a live website with terms, privacy and refund pages first; see step 7).
- [ ] Record the decision, the per-transaction fee (Lemon Squeezy: 5% + $0.50 on its standard plan, verify) and the
      payout/FX cost in the decision log above. Update the "Path to target" numbers in README.md if they differ.

### If switching to Polar (spec, not yet implemented)

Only do this if Lemon Squeezy cannot pay out. It is a contained change in `src/server.js`, `src/plans.js` and the tests.

- [ ] Add a `POST /webhooks/polar` route using `express.raw` (same pattern as `/webhooks/lemonsqueezy`) and verify
      signatures with the Standard Webhooks scheme (`standardwebhooks` package: `webhook-id`, `webhook-timestamp`,
      `webhook-signature` headers, secret `POLAR_WEBHOOK_SECRET`). This adds one dependency; get it approved first.
- [ ] Events:
  - `subscription.active`, `subscription.updated`, `subscription.uncanceled` → `store.setPlan(accountId, planFromProduct(productId), subscriptionId)`.
  - `subscription.revoked` → `store.setPlan(accountId, 'free')`, only when the stored subscription id matches (same rule as the Lemon Squeezy downgrade).
  - An unmapped product id in live mode returns 500 so Polar retries and the problem is visible (same as `unmapped_variant`).
- [ ] `planFromProduct(productId)` in `src/plans.js`, mapped from `POLAR_PRODUCT_STARTER`, `POLAR_PRODUCT_PRO`,
      `POLAR_PRODUCT_BUSINESS` (and `*_YEARLY`), mirroring `planFromVariant`.
- [ ] Checkout is created server side: `GET /v1/billing/checkout?plan=<id>` calls the Polar checkout API with
      `metadata.account_id = <account id>` and `customer_email`, and returns `{checkout_url}`. The webhook reads
      `metadata.account_id` back. The response contract (200 / 400 `unknown_plan` / 409 `already_subscribed`) stays the same.
- [ ] `upgrade_urls` in 402 bodies, `/v1/signup` and `/v1/me` point at `/v1/billing/checkout?plan=<id>` links instead of static checkout URLs.
- [ ] Rewrite the webhook tests in `test/billing.test.js` for Polar payloads (signed with a test secret): active,
      updated (plan change), uncanceled, revoked with matching and non-matching subscription id, bad signature (401), unmapped product (500).
- [ ] Update `.env.example`, the README billing section and the customer-portal link in the 409 `manage_url`.

## 2. Name decision

`trydocforge.com` (Rev Vision Ltd) already sells an invoice-to-PDF API under the name DocForge. Same name, same
category: this is a trademark and search-results problem. Decide before buying a domain.

- [ ] Option A: **rename.** Shortlist 3-5 names, then for each check: `.com`/`.dev` availability, the npm package
      name (`npm view <name>`), the GitHub org/repo name, and a web search for "<name> pdf" and "<name> api".
      Pick one with no PDF/document product on page one.
- [ ] Option B: **keep the name** and always use the descriptor **"DocForge PDF API"** in titles, listings and
      the domain (e.g. `docforgepdf.*`), never plain "DocForge" in a listing title.
- [ ] If renaming, change these (files at the time of writing; grep `-i docforge` again before you start):
  - `package.json`, `package-lock.json`: `"name"`.
  - `src/server.js`: email subjects/bodies ("Your DocForge API key…", usage-warning subject), `X-DocForge-*`
    response headers (`X-DocForge-Blocked-Assets`, `X-DocForge-Blocked-Asset-Example`, `X-DocForge-Sample-Data`),
    the listen log line, the default `docforge.db` path.
  - `src/render.js`: watermark text "Made with DocForge", "SAMPLE · DocForge demo", PDF producer "DocForge free", the `docforgeBuild` worker flag.
  - `src/db.js`: default `docforge.db` path and the `docforge-YYYY-MM-DD.db` backup file pattern (keep reading the old pattern once, or rename existing backups).
  - `Dockerfile` (`DB_PATH=/data/docforge.db`), `.env.example`, `deploy/**` (image name `docforge`, volume `docforge-data`, scripts).
  - `public/index.html`, `public/docs.html`, `public/guides/**` (titles, meta, OG text, competitor pages), `public/assets/site.js` (`window.DocForge`, `df_source` key), `public/assets/og.png`.
  - Tests: `test/api.test.js`, `test/render.test.js`, `test/billing.test.js` (header names, watermark text).
  - `README.md`, `docs/**`.
  - Header renames are a breaking API change: do it before the first paying customer.
- [ ] Record the decision in the log.

## 3. Domain

- [ ] Buy the domain (Cloudflare Registrar sells at cost; check it accepts the founder's card).
- [ ] Point DNS at the VPS (A/AAAA records), proxied or DNS-only to suit Caddy's certificate issuance.
- [ ] Set `PUBLIC_URL=https://<domain>` in `.env` (no trailing slash). It drives watermark links, `output:'url'`
      links, recovery links, `upgrade_url`, sitemap and robots.

## 4. Support inbox and transactional email

- [ ] Create `support@<domain>` with **Cloudflare Email Routing** (forward to a personal inbox, free) or **Zoho Mail** (free tier, can send as the address).
- [ ] Set `SUPPORT_EMAIL=support@<domain>`. `/v1/plans` exposes it and `site.js` fills every `[data-support-email]`.
- [ ] Create a **Resend** account, add and verify the domain (SPF, DKIM, and a DMARC record `p=none` to start).
- [ ] Set `RESEND_API_KEY` and `MAIL_FROM="DocForge <noreply@<domain>>"`.
- [ ] Test: sign up with a real address, then run the key recovery flow (`/#recover`) end to end. Check the email lands in the inbox, not spam.

## 5. Legal pages and founder details

- [ ] Fill every `TODO` in `public/guides/terms.html` and `public/guides/privacy.html` (legal name, country, contact
      address, governing law, sub-processors: the VPS host, Resend, the payment provider).
- [ ] Review `public/guides/refunds.html` and `public/guides/security.html` against what the code actually does.
- [ ] Fill the "Built by" block on the landing page (TODO founder name, TODO link to GitHub/X/LinkedIn). Real name and face help conversion; no invented team.
- [ ] These are drafts, not legal advice. If budget allows, have them read by a lawyer once revenue starts.

## 6. Billing configuration (Lemon Squeezy)

- [ ] Create one product "DocForge PDF API" with subscription variants:
  - Starter $15/month, Pro $39/month, Business $99/month.
  - Yearly variants at 10x monthly: Starter $150/year, Pro $390/year, Business $990/year.
- [ ] Set `LS_VARIANT_STARTER`, `LS_VARIANT_PRO`, `LS_VARIANT_BUSINESS`, `LS_VARIANT_STARTER_YEARLY`,
      `LS_VARIANT_PRO_YEARLY`, `LS_VARIANT_BUSINESS_YEARLY` to the variant ids.
- [ ] Set `LS_CHECKOUT_STARTER`, `LS_CHECKOUT_PRO`, `LS_CHECKOUT_BUSINESS` to the checkout links.
- [ ] Add a webhook to `https://<domain>/webhooks/lemonsqueezy`; copy its signing secret into `LS_WEBHOOK_SECRET`.
- [ ] Enable events: `subscription_created`, `subscription_updated`, `subscription_cancelled`, `subscription_resumed`,
      `subscription_expired`, `subscription_paused`, `subscription_unpaused`, `subscription_payment_success`,
      `subscription_payment_failed`, `subscription_payment_recovered`, `subscription_payment_refunded`, `order_refunded`.
- [ ] In **test mode**, complete one purchase end to end: sign up → `GET /v1/billing/checkout?plan=starter` → pay
      with a test card → webhook arrives → `GET /v1/me` shows `plan: starter` and no watermark on the next render.
- [ ] In test mode, refund that order: the webhook arrives and the account drops back to `free`.
- [ ] Check the server log for `ls_webhook` lines with the right `account_id` and `plan`, and no `unmapped_variant`.

## 7. Store activation

- [ ] Confirm `/terms`, `/privacy`, `/refunds` and `/security` are live on the production domain and linked from the footer.
- [ ] Only then submit the Lemon Squeezy store for activation (they review the live site). Expect questions; answer from the same pages.
- [ ] After approval, switch the variant ids, checkout links and webhook secret to live-mode values and repeat one real purchase with a small amount (refund it afterwards).

## 8. Operations

- [ ] VPS with at least 4 GB RAM (e.g. Hetzner CX22). Install Docker and Caddy.
- [ ] Build the image and start it with `deploy/docker-run.sh` (binds to `127.0.0.1:3000`, `--memory 2g`, volume `docforge-data`, `--env-file .env`).
- [ ] Put Caddy in front with `deploy/Caddyfile` and set `TRUST_PROXY=1` so per-IP rate limits see the real client IP.
      Do **not** set `TRUST_PROXY` if the port is reachable directly.
- [ ] Keep `RENDER_CONCURRENCY=2` on a 4 GB box until the load test says otherwise.
- [ ] Install the `deploy/backup.sh` cron (daily, with `RCLONE_REMOTE` set). The server writes the local snapshots itself; the script only copies them off the box.
- [ ] Do one restore drill following `deploy/restore.md` on a scratch container; confirm an API key from before the backup still works.
- [ ] UptimeRobot (free) HTTP monitor on `https://<domain>/healthz`, alerting the founder's email/phone.
- [ ] Load test against the real render path, not the demo (the demo is limited to 30/hour per IP and serves a
      cached sample PDF, so its latency means nothing). Sign up `loadtest@<domain>`, then
      `docker exec docforge node deploy/admin.js set-plan loadtest@<domain> business` and run
      `npx autocannon -c 4 -d 30 -m POST -H 'content-type=application/json' -H 'authorization=Bearer <key>' -b '{"template_id":"gallery:invoice"}' https://<domain>/v1/render`.
      Use `-c 4` (Business concurrency); higher values only return 429 `concurrency_limit`. This uses roughly 1-2k
      of the test account's renders. Record p50 and p99 in the decision log; the p50 goes into the Show HN comment.

## 9. Competitor prices

- [ ] Re-check every competitor price in README.md and `public/guides/*-alternative.html` on the vendors' own pricing pages.
- [ ] Replace each `checked [TODO YYYY-MM], verify` marker with the actual month checked. If a number cannot be
      verified, remove it rather than guess.
- [ ] Only then publish or link the comparison pages (`/guides/pdfmonkey-alternative`, `/guides/apitemplate-alternative`, `/guides/pdfshift-alternative`).

## 10. Distribution (every link carries `?ref=`)

Use `https://<domain>/?ref=<channel>` (query before the hash, e.g. `/?ref=hn#demo`) so the `source` column shows what worked.

- [ ] Google Search Console: verify the domain, submit `https://<domain>/sitemap.xml`.
- [ ] RapidAPI: import `https://<domain>/openapi.json`, link back with `?ref=rapidapi`.
- [ ] alternativeTo (as an alternative to PDFMonkey, APITemplate.io, CraftMyPDF, PDFShift): `?ref=alternativeto`.
- [ ] SaaSHub: `?ref=saashub`.
- [ ] Toolradar: `?ref=toolradar`.
- [ ] Peerlist (project launch): `?ref=peerlist`.
- [ ] Indie Hackers (product page + post): `?ref=indiehackers`.
- [ ] Product Hunt: `?ref=producthunt`.
- [ ] Show HN last, when everything above is stable: `?ref=hn`. Copy is in `docs/launch/show-hn.md`.

## 11. Weekly metrics (every Monday)

Run against the production database (read-only copy is fine, e.g. the latest backup):

```sql
-- Signups by source
SELECT source, count(*) FROM accounts GROUP BY source ORDER BY 2 DESC;

-- Activated: accounts with any usage row
SELECT count(DISTINCT account_id) FROM usage WHERE renders > 0;

-- Paid
SELECT plan, count(*) FROM accounts WHERE plan != 'free' GROUP BY plan;
```

Tables are `accounts` (`plan`, `source`, `status`) and `usage` (`account_id`, `month`, `renders`) in `src/db.js`. Log the three numbers weekly in a
spreadsheet; a channel that brings signups but no activations is not worth more time.
