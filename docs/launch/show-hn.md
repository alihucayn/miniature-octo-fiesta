# Launch copy: Show HN and listings

**Gate: do not post until `docs/launch-checklist.md` items 1-8 are done** (payouts verified, name decided, domain
live, support email working, legal pages filled, billing tested end to end, store activated, ops and backups in
place) **and the founder can stay online for 6 hours after posting** to answer every comment. Fill the
`[TODO measured p50]` from the checklist's load test. Replace `<domain>` everywhere.

---

## Show HN

**Title** (max 80 chars):

> Show HN: DocForge – JSON to PDF API with a live demo, no signup

(If you kept the name, consider "Show HN: DocForge PDF API – …" to avoid confusion with trydocforge.com.)

**URL:** `https://<domain>/?ref=hn#demo`

**First comment** (post immediately after submitting):

> Hi HN, I'm TODO founder first name, a student/developer in Pakistan. DocForge turns JSON plus an HTML/Handlebars
> template into a PDF with one POST. It ships with invoice, receipt, certificate, quote and packing-slip templates.
>
> You can try it without signing up: the demo on the landing page renders a real PDF from the built-in templates
> (watermarked "SAMPLE", rate-limited per IP).
>
> Some implementation details people usually ask about:
>
> - Rendering is headless Chromium (playwright-core). Each render gets a fresh browser context with JavaScript
>   disabled, so a template can't run scripts or keep state between customers.
> - Remote assets (images, fonts, CSS) are only fetched over https, and every hostname is DNS-resolved and
>   blocked if it points at a private, loopback, link-local or metadata IP. Only a small allowlist of resource
>   types is loaded at all. Blocked URLs are reported back in a response header instead of failing silently.
> - Quotas are reserved atomically in SQLite before the render starts, so parallel requests can't overshoot a
>   plan; template syntax errors and server-side failures release the reservation, while renders that time out,
>   exceed the page limit or are too expensive to evaluate still count as one.
> - PDFs are rendered in memory and streamed back. Nothing is written to disk unless you ask for
>   `output: "url"`, which keeps the file for 24 hours behind an unguessable link.
> - Billing goes through Lemon Squeezy as merchant of record, which handles sales tax/VAT. That matters for me
>   because Stripe isn't available to Pakistani businesses.
>
> Honest comparison: if you're comfortable running your own infrastructure, Gotenberg (or Puppeteer/Playwright
> directly) is free and very good, and you should probably use it. DocForge is for people who'd rather not
> babysit a Chromium pool, page-break CSS and SSRF filtering, and want ready-made templates and a quota
> instead. Pricing has a free tier of 100 PDFs/month (with a small footer link) and paid plans from $15/month.
>
> Median render time for the invoice template on a 4 GB VPS is [TODO measured p50] ms.
>
> I'd like feedback on the API shape and the templates, and on what's missing for your use case.

---

## Product Hunt

- **Name:** DocForge PDF API
- **Tagline (60 chars):** Send JSON, get a PDF. Invoices, receipts and certificates.
- **Link:** `https://<domain>/?ref=producthunt`
- **Description:** A JSON-to-PDF API for developers and no-code builders. Pick a ready-made invoice, receipt,
  certificate, quote or packing-slip template (or bring your own HTML/Handlebars), POST your data, get a PDF.
  Try the live demo without an account. Free tier: 100 PDFs/month.
- **Maker comment:** a shortened version of the Show HN comment (keep the self-hosting paragraph).

## Indie Hackers

- **Title:** I built a JSON-to-PDF API from Pakistan (and had to solve payouts first)
- **Link:** `https://<domain>/?ref=indiehackers`
- **Body (short):** What it does in two sentences; why payouts drove the choice of Lemon Squeezy (Stripe/PayPal
  unavailable); the pricing reasoning (cost per 1,000 PDFs vs. PDFMonkey/APITemplate/PDFShift, with prices marked
  "checked TODO YYYY-MM"); what's next. Ask one concrete question, e.g. "would you pay yearly for this?".
  No revenue numbers until there are real ones.

## r/SideProject

- **Title:** I made a JSON → PDF API with a no-signup demo (invoices, receipts, certificates)
- **Link:** `https://<domain>/?ref=reddit-sideproject#demo`
- **Body:** Three lines: what it is, the demo link, the free tier. Then "Built with Node, Express, SQLite and
  headless Chromium. Feedback on the templates welcome." Reply to every comment; don't cross-post the same day.

## alternativeTo description

- **Link:** `https://<domain>/?ref=alternativeto`
- **Alternative to:** PDFMonkey, APITemplate.io, CraftMyPDF, PDFShift.
- **Description:** DocForge PDF API turns JSON into PDFs through one HTTP call. It includes invoice, receipt,
  certificate, quote and packing-slip templates, supports custom HTML/Handlebars templates, and has a free tier
  of 100 PDFs per month. Hosted service; paid plans add higher monthly volumes and remove the footer link.
