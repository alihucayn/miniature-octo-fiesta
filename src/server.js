const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { openDb, Store, currentMonth } = require('./db');
const render = require('./render');
const { PLANS, planFromVariant, configuredVariants } = require('./plans');
const { GALLERY, getGalleryTemplate } = require('../gallery');

const { Renderer } = render;
// FORMATS comes from src/render.js; the fallback keeps validation working if
// an older renderer is loaded.
const FORMATS = render.FORMATS || { a4: 1, letter: 1, legal: 1, a5: 1, a3: 1, tabloid: 1, ledger: 1 };

const MAX_TEMPLATE_BYTES = 512 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HOUR = 60 * 60 * 1000;
const FILE_TTL_MS = 24 * HOUR;
const FILE_TOKEN_RE = /^[\w-]{32}$/;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const GUIDES_DIR = path.join(PUBLIC_DIR, 'guides');
const LEGAL_PAGES = ['terms', 'privacy', 'refunds', 'security'];
const PLACEHOLDER_ORIGIN = 'https://YOUR-DOMAIN';
const DRAFT_NOTE = '<p class="note muted"><b>Draft, not yet reviewed:</b> placeholders marked [TODO] will be filled before launch.</p>';

// Legal pages still holding [TODO] placeholders. In production the server
// refuses to start with these unless ALLOW_DRAFT_LEGAL=1.
function unfinishedLegalPages(dir = GUIDES_DIR) {
  return ['terms', 'privacy', 'refunds'].filter((n) => {
    try { return fs.readFileSync(path.join(dir, `${n}.html`), 'utf8').includes('[TODO'); } catch { return false; }
  });
}
const PLAN_ORDER = Object.keys(PLANS);
const MANAGE_URL = 'https://app.lemonsqueezy.com/my-orders';
const DEMO_MAX_IN_FLIGHT = 2;
const DEMO_MAX_QUEUE = 10;
const DEMO_MAX_DATA_CHARS = 20000;

// "1" -> 1, "true" -> true, "loopback" -> "loopback"; unset means do not trust
// X-Forwarded-For (a spoofable header would defeat the rate limits).
function parseTrustProxy(v) {
  if (v === undefined || v === null || v === '') return false;
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (s === 'true') return true;
  if (s === 'false' || s === '') return false;
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

// IPv4-mapped addresses are keyed as IPv4; IPv6 clients by their /64, since
// one host usually controls a whole /64.
function clientKey(ip = '') {
  let v = String(ip);
  if (v.startsWith('::ffff:')) v = v.slice(7);
  if (!v.includes(':')) return v;
  v = v.split('%')[0].toLowerCase();
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Fixed-window in-memory limiter; good enough for a single instance.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = clientKey(req.ip);
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return next();
    }
    if (++entry.count > max) {
      res.set('Retry-After', String(Math.ceil((entry.reset - now) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: 'Too many requests, slow down.' });
    }
    next();
  };
}

// a.person@example.com -> a***@example.com, so logs don't hold full addresses.
function maskEmail(e) {
  const s = String(e || '');
  const at = s.lastIndexOf('@');
  return at > 0 ? `${s[0]}***${s.slice(at)}` : '***';
}

// Transactional mail through Resend's HTTP API (no SDK dependency). Without
// RESEND_API_KEY and MAIL_FROM it only logs that a mail was skipped; the body
// is never logged because it can contain recovery links.
async function sendMail({ to, subject, text }) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!key || !from) {
    console.log(JSON.stringify({ evt: 'mail_skipped', to: maskEmail(to), subject, reason: 'RESEND_API_KEY or MAIL_FROM unset' }));
    return { skipped: true };
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from, to: [to], subject, text }),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const firstLine = (e) => String(e?.message || e || '').split('\n')[0].slice(0, 300);

function createApp({ store, renderer, config = {} }) {
  const app = express();
  app.set('trust proxy', config.trustProxy ?? parseTrustProxy(process.env.TRUST_PROXY));
  app.disable('x-powered-by');

  const publicUrl = (config.publicUrl || process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, '');
  const supportEmail = config.supportEmail ?? process.env.SUPPORT_EMAIL ?? null;
  const webhookSecret = config.webhookSecret ?? process.env.LS_WEBHOOK_SECRET;
  const checkoutUrls = config.checkoutUrls || {
    starter: process.env.LS_CHECKOUT_STARTER,
    pro: process.env.LS_CHECKOUT_PRO,
    business: process.env.LS_CHECKOUT_BUSINESS,
  };
  const filesDir = config.filesDir || process.env.FILES_DIR
    || path.join(path.dirname(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'docforge.db')), 'files');
  const mailer = config.mailer || sendMail;
  const pricingUrl = `${publicUrl}/#pricing`;

  if (webhookSecret) {
    const missing = [];
    if (!Object.keys(configuredVariants()).length) missing.push('no LS_VARIANT_* set (paid webhooks will return 500)');
    if (!Object.values(checkoutUrls).some(Boolean)) missing.push('no LS_CHECKOUT_* set (nobody can pay)');
    if (missing.length) console.warn(`!!! BILLING MISCONFIGURED: LS_WEBHOOK_SECRET is set but ${missing.join('; ')}`);
  }

  // Fire-and-forget mail: a mail outage must never fail an API call.
  const notify = (msg) => {
    Promise.resolve()
      .then(() => mailer(msg))
      .catch((e) => console.error(JSON.stringify({ evt: 'mail_failed', to: maskEmail(msg.to), subject: msg.subject, err: firstLine(e) })));
  };

  function checkoutUrlFor(account, planId) {
    const base = checkoutUrls[planId];
    if (!base) return null;
    const url = new URL(base);
    url.searchParams.set('checkout[custom][account_id]', account.id);
    url.searchParams.set('checkout[email]', account.email);
    return url.toString();
  }

  const plansAbove = (planId) => PLAN_ORDER.slice(Math.max(0, PLAN_ORDER.indexOf(planId)) + 1);

  function upgradeUrlsFor(account) {
    const out = {};
    for (const id of plansAbove(account.plan || 'free')) {
      const url = checkoutUrlFor(account, id);
      if (url) out[id] = url;
    }
    return out;
  }

  // The next plan up, with its checkout link (or /#pricing when unconfigured).
  function nextUpgrade(account) {
    const id = plansAbove(account.plan || 'free')[0];
    if (!id) return null;
    const checkout = checkoutUrlFor(account, id);
    return { id, plan: PLANS[id], checkout, url: checkout || pricingUrl };
  }

  const upsell = (account) => ({ upgrade_url: pricingUrl, upgrade_urls: upgradeUrlsFor(account) });
  const contactLine = () => (supportEmail ? `email ${supportEmail}` : `see ${publicUrl}/#pricing`);

  // ---- hosted files (output: 'url') ----
  function sweepFiles() {
    let names;
    try { names = fs.readdirSync(filesDir); } catch { return; }
    const cutoff = Date.now() - FILE_TTL_MS;
    for (const n of names) {
      const p = path.join(filesDir, n);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true }); } catch { /* raced */ }
    }
  }
  setInterval(sweepFiles, HOUR).unref();

  // Webhook needs the raw body for signature verification, so it is mounted
  // before the JSON parser.
  app.post('/webhooks/lemonsqueezy', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    if (!webhookSecret) return res.status(503).json({ error: 'billing_not_configured' });
    const signature = Buffer.from(req.get('X-Signature') || '', 'utf8');
    const digest = Buffer.from(crypto.createHmac('sha256', webhookSecret).update(req.body).digest('hex'), 'utf8');
    if (signature.length !== digest.length || !crypto.timingSafeEqual(signature, digest)) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    let event;
    try { event = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_json' }); }

    const name = String(event?.meta?.event_name || '');
    const attrs = event?.data?.attributes || {};
    const accountId = event?.meta?.custom_data?.account_id || null;
    const subId = event?.data?.id != null ? String(event.data.id) : null;
    const status = attrs.status ?? null;
    const variantId = attrs.variant_id ?? null;
    const plan = variantId != null ? planFromVariant(variantId) : null;
    const log = (action, fn = console.log) =>
      fn(JSON.stringify({ evt: 'ls_webhook', name, sub_id: subId, account_id: accountId, variant_id: variantId, status, plan, action }));

    // Refunds first: a refunded payment ends paid access for that subscription.
    if (name === 'subscription_payment_refunded' || name === 'order_refunded') {
      const acc = accountId && store.accountById(accountId);
      if (!acc) { log('ignored_no_account'); return res.json({ ignored: true }); }
      const refundedSub = attrs.subscription_id ?? attrs.first_subscription_item?.subscription_id ?? null;
      if (acc.subscription_id == null || refundedSub == null || String(refundedSub) === acc.subscription_id) {
        store.setPlan(acc.id, 'free');
        log('downgraded_refund');
        return res.json({ ok: true });
      }
      log('ignored_stale_refund');
      return res.json({ ignored: 'stale_subscription' });
    }

    if (!name.startsWith('subscription_')) { log('ignored'); return res.json({ ignored: true }); }
    // subscription_payment_success/failed/recovered: plan state arrives via
    // subscription_updated, so these are acknowledged only.
    if (name.startsWith('subscription_payment_')) { log('ack_payment'); return res.json({ ok: true }); }

    if (!accountId) {
      if (name === 'subscription_created' || name === 'subscription_updated') {
        log('unmapped', console.error);
        return res.status(500).json({ error: 'missing_account_id' });
      }
      log('ignored_no_account');
      return res.json({ ignored: true });
    }
    const acc = store.accountById(accountId);
    if (!acc) { log('ignored_unknown_account', console.error); return res.json({ ignored: 'unknown_account' }); }

    // "cancelled" subscriptions stay usable until they expire.
    const live = ['active', 'on_trial', 'past_due', 'cancelled'].includes(status);
    const isCurrent = acc.subscription_id == null || acc.subscription_id === subId;
    if (live) {
      if (!plan) {
        // Retry until the operator sets the LS_VARIANT_* env var for this product.
        log('unmapped', console.error);
        return res.status(500).json({ error: 'unmapped_variant', variant_id: variantId });
      }
      // A cancellation of an older subscription must not undo a newer upgrade.
      if (status === 'cancelled' && !isCurrent) { log('ignored_stale'); return res.json({ ignored: 'stale_subscription' }); }
      store.setPlan(acc.id, plan, subId); // the newest live subscription wins
      log('set_plan');
      return res.json({ ok: true });
    }
    if (['expired', 'unpaid', 'paused'].includes(status)) {
      if (!isCurrent) { log('ignored_stale'); return res.json({ ignored: 'stale_subscription' }); }
      store.setPlan(acc.id, 'free');
      log('downgraded');
      return res.json({ ok: true });
    }
    log('ignored');
    res.json({ ignored: true });
  });

  app.use(express.json({ limit: '2mb' }));

  // ---- SEO, legal and machine-readable pages (before express.static) ----
  let guideNames = [];
  try {
    guideNames = fs.readdirSync(GUIDES_DIR).filter((n) => n.endsWith('.html')).map((n) => n.slice(0, -5));
  } catch { /* no guides yet */ }
  const hasGuidesIndex = guideNames.includes('index');

  // Pages are read once and served with the real origin substituted for the
  // https://YOUR-DOMAIN placeholder, so crawlers that don't run JS (link
  // previews, Google's first pass) see a valid canonical, og:url and og:image.
  // Pages still holding [TODO] placeholders get noindex (and a visible draft
  // note on legal pages) and are left out of the sitemap.
  const unfinished = new Set();
  const pageCache = new Map();
  const cachePage = (routes, file, type) => {
    let body;
    try { body = fs.readFileSync(file, 'utf8'); } catch { return; }
    const draft = body.includes('[TODO');
    body = body.split(PLACEHOLDER_ORIGIN).join(publicUrl);
    if (type === 'html' && draft) {
      if (!/<meta name="robots"/.test(body)) body = body.replace('<head>', '<head>\n<meta name="robots" content="noindex">');
      if (LEGAL_PAGES.includes(path.basename(file, '.html'))) body = body.replace(/(<h1[^>]*>.*?<\/h1>)/, `$1\n${DRAFT_NOTE}`);
    }
    for (const r of routes) {
      pageCache.set(r, { type, body });
      if (draft) unfinished.add(r);
    }
  };
  cachePage(['/', '/index.html'], path.join(PUBLIC_DIR, 'index.html'), 'html');
  cachePage(['/docs', '/docs.html'], path.join(PUBLIC_DIR, 'docs.html'), 'html');
  for (const n of guideNames) {
    const routes = n === 'index' ? ['/guides/', '/guides/index', '/guides/index.html'] : [`/guides/${n}`, `/guides/${n}.html`];
    if (LEGAL_PAGES.includes(n)) routes.unshift(`/${n}`);
    cachePage(routes, path.join(GUIDES_DIR, `${n}.html`), 'html');
  }
  cachePage(['/llms.txt'], path.join(GUIDES_DIR, 'llms.txt'), 'text');
  const guideSlugs = guideNames.filter((n) => n !== 'index' && !LEGAL_PAGES.includes(n) && !unfinished.has(`/guides/${n}`)).sort();

  app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
      `User-agent: *\nDisallow: /v1/\nDisallow: /webhooks/\nDisallow: /f/\n\nSitemap: ${publicUrl}/sitemap.xml\n`
    );
  });

  app.get('/sitemap.xml', (req, res) => {
    const paths = ['/', '/docs', ...LEGAL_PAGES.map((p) => `/${p}`).filter((p) => !unfinished.has(p)), ...(hasGuidesIndex ? ['/guides/'] : []), ...guideSlugs.map((s) => `/guides/${s}`)];
    const urls = paths.map((p) => `  <url><loc>${publicUrl}${p}</loc></url>`).join('\n');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  });

  const sendGuideFile = (file) => (req, res) => {
    res.sendFile(path.join(GUIDES_DIR, file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'not_found' });
    });
  };
  app.get('/openapi.json', sendGuideFile('openapi.json'));
  app.get([...pageCache.keys()], (req, res, next) => {
    const page = pageCache.get(req.path);
    if (!page) return next();
    res.type(page.type).send(page.body);
  });

  // Public, unguessable, 24h download links for output:'url'.
  app.get('/f/:token/:filename?', (req, res) => {
    const { token } = req.params;
    if (!FILE_TOKEN_RE.test(token)) return res.status(404).json({ error: 'not_found' });
    const file = path.join(filesDir, `${token}.pdf`);
    let st;
    try { st = fs.statSync(file); } catch { return res.status(404).json({ error: 'not_found' }); }
    if (Date.now() - st.mtimeMs > FILE_TTL_MS) {
      fs.rm(file, { force: true }, () => {});
      return res.status(404).json({ error: 'not_found' });
    }
    const name = String(req.params.filename || 'document.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'document.pdf';
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Length', String(st.size));
    res.set('Content-Disposition', `attachment; filename="${name.endsWith('.pdf') ? name : `${name}.pdf`}"`);
    res.set('Cache-Control', 'private, max-age=3600');
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });

  app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

  // Never launches Chromium: it only reports the pool's last known state.
  app.get('/healthz', (req, res) => {
    let db = true;
    try { store.db.prepare('SELECT 1').get(); } catch { db = false; }
    let rendererStatus = null;
    try { rendererStatus = renderer?.status?.() ?? null; } catch { rendererStatus = null; }
    const rendererDown = Boolean(rendererStatus && rendererStatus.lastLaunchError && !rendererStatus.connected);
    if (!db || rendererDown) return res.status(503).json({ ok: false, db, renderer: rendererStatus });
    res.json({ ok: true, db: true, renderer: rendererStatus });
  });

  app.get('/v1/plans', (req, res) => res.json({ plans: PLANS, support_email: supportEmail, public_url: publicUrl }));

  app.get('/v1/gallery', (req, res) => {
    res.json({
      templates: GALLERY.map(({ id, name, description, sampleData, options }) => ({ id, name, description, sample_data: sampleData, options })),
    });
  });

  app.get('/v1/gallery/:id', (req, res) => {
    const tpl = getGalleryTemplate(`gallery:${req.params.id}`);
    if (!tpl) return res.status(404).json({ error: 'not_found' });
    res.json({ id: tpl.id, name: tpl.name, description: tpl.description, html: tpl.html, css: tpl.css, sample_data: tpl.sampleData, options: tpl.options });
  });

  function welcomeMail(acc) {
    const starter = checkoutUrlFor(acc, 'starter');
    return {
      to: acc.email,
      subject: 'Your DocForge API key is ready',
      text: [
        `Your DocForge account is live (key prefix ${acc.apiKey.slice(0, 12)}...). The full key was shown once at signup.`,
        '',
        'Render your first invoice:',
        '',
        `curl -X POST ${publicUrl}/v1/render \\`,
        '  -H "Authorization: Bearer $DOCFORGE_KEY" \\',
        '  -H "Content-Type: application/json" \\',
        '  -d \'{"template_id":"gallery:invoice"}\' -o invoice.pdf',
        '',
        `Docs: ${publicUrl}/docs`,
        `The Free plan includes ${PLANS.free.monthlyRenders} watermarked renders a month.`,
        starter ? `Starter removes the watermark and gives you ${PLANS.starter.monthlyRenders} renders for $${PLANS.starter.priceUsd}/month: ${starter}` : `Plans: ${pricingUrl}`,
        '',
        `Lost your key? ${publicUrl}/#recover`,
      ].join('\n'),
    };
  }

  app.post('/v1/signup', rateLimit({ windowMs: HOUR, max: config.signupsPerHour ?? 5 }), (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email' });
    if (store.accountByEmail(email)) {
      return res.status(409).json({
        error: 'email_taken',
        message: `An account with this email already exists. Recover your key at ${publicUrl}/#recover${supportEmail ? ` or email ${supportEmail}` : ''}`,
      });
    }
    const rawSource = req.body?.source;
    const source = typeof rawSource === 'string' && rawSource.trim() ? rawSource.trim().slice(0, 100) : null;
    const acc = store.createAccount(email, { source });
    notify(welcomeMail(acc));
    res.status(201).json({
      api_key: acc.apiKey,
      plan: acc.plan,
      message: 'Store this key now: it is shown only once.',
      upgrade_urls: upgradeUrlsFor(acc),
    });
  });

  // ---- key recovery (public) ----
  const recoverLimit = rateLimit({ windowMs: HOUR, max: config.recoversPerHour ?? 5 });
  app.post('/v1/keys/recover', recoverLimit, (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const acc = EMAIL_RE.test(email) && email.length <= 254 ? store.accountByEmail(email) : null;
    // One mail per account per 10 minutes, whatever the source IP, so the
    // endpoint can't be used to flood a victim or burn the Resend quota.
    if (acc && !store.recentRecovery(acc.id)) {
      const token = store.createRecoveryToken(acc.id);
      notify({
        to: acc.email,
        subject: 'Recover your DocForge API key',
        text: [
          'Someone (hopefully you) asked to recover the DocForge API key for this email.',
          '',
          `Open this link within 30 minutes to get a new key: ${publicUrl}/#recover=${token}`,
          '',
          'Your current key keeps working until you open the link. If this was not you, ignore this email.',
        ].join('\n'),
      });
    }
    res.status(202).json({ message: 'If that email has an account, a recovery link is on its way.' });
  });

  app.post('/v1/keys/recover/confirm', recoverLimit, (req, res) => {
    const accountId = store.consumeRecoveryToken(String(req.body?.token || ''));
    const acc = accountId && store.accountById(accountId);
    if (!acc) return res.status(400).json({ error: 'invalid_token', message: 'This recovery link is invalid or expired. Request a new one.' });
    const apiKey = store.rotateKey(acc.id);
    notify({ to: acc.email, subject: 'Your DocForge API key was replaced', text: `A new API key was issued through the recovery link. The previous key no longer works.\n\nNot you? ${contactLine()}.` });
    res.json({ api_key: apiKey, message: 'Old key revoked. Store this key now: it is shown only once.' });
  });

  // ---- authenticated routes ----
  function auth(req, res, next) {
    const header = req.get('Authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('X-API-Key');
    const account = key && store.accountByKey(key);
    if (!account) return res.status(401).json({ error: 'unauthorized', message: 'Pass your API key as "Authorization: Bearer <key>".' });
    if ((account.status || 'active') !== 'active') {
      return res.status(403).json({ error: 'account_suspended', message: `This account is suspended. See /terms or email ${supportEmail || 'support'}.` });
    }
    req.account = account;
    req.plan = PLANS[account.plan] || PLANS.free;
    next();
  }

  const api = express.Router();
  api.use(auth);

  api.get('/me', (req, res) => {
    const used = store.usage(req.account.id);
    res.json({
      email: req.account.email,
      plan: req.account.plan,
      status: req.account.status || 'active',
      key_prefix: req.account.key_prefix,
      month: currentMonth(),
      renders_used: used,
      renders_limit: req.plan.monthlyRenders,
      renders_grace: req.plan.graceRenders,
      templates_used: store.countTemplates(req.account.id),
      templates_limit: req.plan.templates,
      upgrade_urls: upgradeUrlsFor(req.account),
    });
  });

  api.post('/keys/rotate', (req, res) => {
    const apiKey = store.rotateKey(req.account.id);
    notify({ to: req.account.email, subject: 'Your DocForge API key was rotated', text: `Your API key was rotated; the previous key no longer works.\n\nNot you? Recover access at ${publicUrl}/#recover or ${contactLine()}.` });
    res.json({ api_key: apiKey, message: 'Old key revoked. Store this key now.' });
  });

  api.get('/billing/checkout', (req, res) => {
    const plan = String(req.query.plan || '');
    const url = PLAN_ORDER.includes(plan) && plan !== 'free' ? checkoutUrlFor(req.account, plan) : null;
    if (!url) return res.status(400).json({ error: 'unknown_plan', plans: Object.keys(checkoutUrls).filter((p) => checkoutUrls[p]) });
    if (req.account.plan !== 'free' && req.account.subscription_id) {
      return res.status(409).json({
        error: 'already_subscribed',
        message: `You already have a ${PLANS[req.account.plan]?.name || req.account.plan} subscription. Change plans from your Lemon Squeezy order page to avoid paying twice.`,
        manage_url: MANAGE_URL,
      });
    }
    res.json({ checkout_url: url });
  });

  function validateTemplateBody(body, partial) {
    const { name, html, css, sample_data: sampleData } = body || {};
    if (!partial || name !== undefined) {
      if (typeof name !== 'string' || !name.trim() || name.length > 200) return 'name is required (max 200 chars)';
    }
    if (!partial || html !== undefined) {
      if (typeof html !== 'string' || !html.trim()) return 'html is required';
    }
    if (css !== undefined && typeof css !== 'string') return 'css must be a string';
    if (sampleData !== undefined && (typeof sampleData !== 'object' || sampleData === null)) return 'sample_data must be an object';
    if (Buffer.byteLength((html || '') + (css || '')) > MAX_TEMPLATE_BYTES) return 'template exceeds 512KB';
    return null;
  }

  const serializeTemplate = (t) => ({
    id: t.id, name: t.name, html: t.html, css: t.css, sample_data: t.sample_data, created_at: t.created_at, updated_at: t.updated_at,
  });

  api.get('/templates', (req, res) => res.json({ templates: store.listTemplates(req.account.id) }));

  api.post('/templates', (req, res) => {
    let body = req.body || {};
    // {"from_gallery": "invoice"} copies a built-in template for editing.
    if (body.from_gallery) {
      const g = getGalleryTemplate(`gallery:${String(body.from_gallery).replace(/^gallery:/, '')}`);
      if (!g) return res.status(404).json({ error: 'gallery_template_not_found' });
      body = { name: body.name || g.name, html: g.html, css: g.css, sample_data: g.sampleData };
    }
    const err = validateTemplateBody(body, false);
    if (err) return res.status(400).json({ error: 'invalid_template', message: err });
    if (store.countTemplates(req.account.id) >= req.plan.templates) {
      const next = nextUpgrade(req.account);
      return res.status(402).json({
        error: 'template_limit',
        message: `Your ${req.plan.name} plan allows ${req.plan.templates} templates.${
          next ? ` ${next.plan.name} allows ${next.plan.templates}. Upgrade instantly: ${next.url}` : ` Need more? ${contactLine()}.`
        }`,
        ...upsell(req.account),
      });
    }
    const t = store.createTemplate(req.account.id, { name: body.name.trim(), html: body.html, css: body.css, sampleData: body.sample_data });
    res.status(201).json(serializeTemplate(t));
  });

  api.get('/templates/:id', (req, res) => {
    const t = store.getTemplate(req.account.id, req.params.id);
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json(serializeTemplate(t));
  });

  api.put('/templates/:id', (req, res) => {
    const err = validateTemplateBody(req.body, true);
    if (err) return res.status(400).json({ error: 'invalid_template', message: err });
    const { name, html, css, sample_data: sampleData } = req.body;
    const t = store.updateTemplate(req.account.id, req.params.id, { name, html, css, sampleData });
    if (!t) return res.status(404).json({ error: 'not_found' });
    res.json(serializeTemplate(t));
  });

  api.delete('/templates/:id', (req, res) => {
    if (!store.deleteTemplate(req.account.id, req.params.id)) return res.status(404).json({ error: 'not_found' });
    res.status(204).end();
  });

  function resolveSource(account, body) {
    const id = body.template_id;
    if (id) {
      if (typeof id !== 'string') return { error: 'template_not_found' };
      const t = id.startsWith('gallery:') ? getGalleryTemplate(id) : store.getTemplate(account.id, id);
      if (!t) return { error: 'template_not_found' };
      return { html: t.html, css: t.css, options: t.options || {}, sample: t.sampleData || t.sample_data, raw: false };
    }
    if (typeof body.html === 'string' && body.html.trim()) {
      if (Buffer.byteLength(body.html + (body.css || '')) > MAX_TEMPLATE_BYTES) return { error: 'template_too_large' };
      return { html: body.html, css: typeof body.css === 'string' ? body.css : '', options: {}, raw: body.raw === true };
    }
    return { error: 'missing_template', message: 'Provide template_id or html.' };
  }

  // data may be an object or a JSON-encoded string (no-code tools often can
  // only send strings). Returns {value} or {error}.
  function parseData(v) {
    if (typeof v !== 'string') return { value: v ?? undefined };
    try {
      return { value: JSON.parse(v) };
    } catch (e) {
      return { error: { error: 'invalid_data', message: `data must be a JSON object or a JSON-encoded string: ${e.message}` } };
    }
  }

  // Shared request validation for base_url and options. Returns {error} or
  // {baseUrl, options}.
  function parseRenderOptions(body, templateOptions) {
    let baseUrl;
    if (body.base_url !== undefined && body.base_url !== null && body.base_url !== '') {
      let ok = false;
      try { ok = new URL(String(body.base_url)).protocol === 'https:'; } catch { ok = false; }
      if (!ok) return { error: { error: 'invalid_base_url', message: 'base_url must be an absolute https:// URL.' } };
      baseUrl = String(body.base_url);
    }
    const userOpts = body.options;
    if (userOpts !== undefined && userOpts !== null && (typeof userOpts !== 'object' || Array.isArray(userOpts))) {
      return { error: { error: 'invalid_option', message: 'options must be an object.' } };
    }
    const options = { ...(templateOptions || {}), ...(userOpts || {}) };
    if (userOpts?.format !== undefined && userOpts.format !== null && userOpts.format !== '') {
      const f = String(userOpts.format).toLowerCase();
      if (typeof userOpts.format !== 'string' || !Object.hasOwn(FORMATS, f)) {
        return { error: { error: 'invalid_option', message: `options.format must be one of: ${Object.keys(FORMATS).join(', ')}.` } };
      }
    }
    return { baseUrl, options };
  }

  // Maps renderer errors to API responses. `release` says whether the quota
  // reservation is returned: timeouts and oversized output consumed real work.
  function mapRenderError(e) {
    const code = e?.code;
    const msg = firstLine(e);
    if (code === 'BUSY') return { status: 503, retryAfter: 5, release: true, body: { error: 'busy', message: 'All renderers are busy. Retry in a few seconds.' } };
    if (code === 'RENDER_TIMEOUT') return { status: 504, release: false, body: { error: 'render_timeout', message: 'Rendering took too long. Check for slow remote assets or very large documents.' } };
    if (code === 'TOO_MANY_PAGES') return { status: 422, release: false, body: { error: 'too_many_pages', message: msg || 'The document exceeds the page limit for your plan.' } };
    if (code === 'TEMPLATE_TOO_EXPENSIVE') return { status: 422, release: false, body: { error: 'template_too_expensive', message: msg || 'The template took too long to evaluate.' } };
    if (code === 'INVALID_OPTION') return { status: 400, release: true, body: { error: 'invalid_option', message: msg } };
    if (code === 'TEMPLATE_ERROR' || /Parse error|Expecting|Missing helper/i.test(String(e?.message || ''))) {
      return { status: 422, release: true, body: { error: 'template_error', message: msg } };
    }
    return { status: 500, release: true, body: { error: 'render_failed', message: 'Rendering failed; please retry or contact support.' } };
  }

  function logRenderFailure({ route, account, body, status, code, requestId, e }) {
    console.error(JSON.stringify({
      evt: 'render_failed',
      route,
      account_id: account?.id ?? null,
      plan: account?.plan ?? null,
      template_id: typeof body.template_id === 'string' ? body.template_id : 'inline',
      status,
      code: code ?? null,
      request_id: requestId,
      err: firstLine(e),
    }));
  }

  function setAssetHeaders(res, pdf) {
    const blocked = Array.isArray(pdf?.blockedAssets) ? pdf.blockedAssets : [];
    if (blocked.length) {
      res.set('X-DocForge-Blocked-Assets', String(blocked.length));
      res.set('X-DocForge-Blocked-Asset-Example', String(blocked[0]).replace(/[^\x20-\x7e]/g, '').slice(0, 500));
    }
    return blocked;
  }

  const safeFilename = (v) => {
    const f = String(v || 'document.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 120) || 'document.pdf';
    return f.endsWith('.pdf') ? f : `${f}.pdf`;
  };

  async function sendPdf(res, pdf, body) {
    const filename = safeFilename(body.filename);
    const blocked = setAssetHeaders(res, pdf);
    const warnings = blocked.length ? { warnings: { blocked_assets: blocked } } : {};
    if (body.output === 'base64') {
      return res.json({ filename, content_type: 'application/pdf', size: pdf.length, base64: pdf.toString('base64'), ...warnings });
    }
    if (body.output === 'url') {
      const token = crypto.randomBytes(24).toString('base64url');
      await fs.promises.mkdir(filesDir, { recursive: true });
      await fs.promises.writeFile(path.join(filesDir, `${token}.pdf`), pdf);
      return res.json({
        url: `${publicUrl}/f/${token}/${encodeURIComponent(filename)}`,
        filename,
        size: pdf.length,
        expires_at: new Date(Date.now() + FILE_TTL_MS).toISOString(),
        content_type: 'application/pdf',
        ...warnings,
      });
    }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename}"`);
    res.send(pdf);
  }

  function quotaExceeded(account, plan) {
    const next = nextUpgrade(account);
    const grace = plan.graceRenders ? ` (plus ${plan.graceRenders} grace renders)` : '';
    const action = next
      ? `Upgrade instantly: ${next.url}`
      : `Need more? ${contactLine()}.`;
    return {
      error: 'quota_exceeded',
      message: `Monthly limit of ${plan.monthlyRenders} renders${grace} reached on ${plan.name}. ${action} Paid plans include a 10% grace band so a busy month does not break your app.`,
      ...upsell(account),
    };
  }

  const inFlight = new Map();

  api.post('/render', async (req, res) => {
    const body = req.body || {};
    const { account, plan } = req;
    const src = resolveSource(account, body);
    if (src.error) return res.status(src.error === 'template_not_found' ? 404 : 400).json(src);
    const parsed = parseData(body.data);
    if (parsed.error) return res.status(400).json(parsed.error);
    const usedSample = body.data === undefined && src.sample != null;
    const data = parsed.value ?? src.sample ?? {};
    if (typeof data !== 'object' || data === null) {
      return res.status(400).json({ error: 'invalid_data', message: 'data must be a JSON object or a JSON-encoded string' });
    }
    const opts = parseRenderOptions(body, src.options);
    if (opts.error) return res.status(400).json(opts.error);

    const running = inFlight.get(account.id) || 0;
    if (running >= plan.concurrency) {
      res.set('Retry-After', '1');
      return res.status(429).json({
        error: 'concurrency_limit',
        message: `The ${plan.name} plan renders ${plan.concurrency} document${plan.concurrency === 1 ? '' : 's'} at a time. Retry when one finishes.`,
      });
    }
    inFlight.set(account.id, running + 1);
    try {
      if (!store.reserveRender(account.id, plan.monthlyRenders + plan.graceRenders)) {
        return res.status(402).json(quotaExceeded(account, plan));
      }
      const requestId = crypto.randomUUID();
      let pdf;
      try {
        pdf = await renderer.pdf({
          html: src.html, css: src.css, data, options: opts.options, watermark: plan.watermark,
          raw: src.raw, baseUrl: opts.baseUrl, maxPages: plan.maxPages,
        });
        const used = store.usage(account.id);
        res.set('X-Renders-Limit', String(plan.monthlyRenders));
        res.set('X-Renders-Remaining', String(Math.max(0, plan.monthlyRenders - used)));
        if (used > plan.monthlyRenders) {
          res.set('X-Quota-Warning', 'over_limit');
          const next = nextUpgrade(account);
          if (next?.checkout) res.set('X-Upgrade-Url', next.checkout);
        }
        if (usedSample) res.set('X-DocForge-Sample-Data', 'true');
        await sendPdf(res, pdf, body);
        if (used === Math.floor(plan.monthlyRenders * 0.8) || used === plan.monthlyRenders) {
          const next = nextUpgrade(account);
          notify({
            to: account.email,
            subject: `DocForge: ${used} of ${plan.monthlyRenders} renders used this month`,
            text: [
              `You have used ${used} of the ${plan.monthlyRenders} renders on your ${plan.name} plan this month.`,
              plan.graceRenders
                ? `After that, ${plan.graceRenders} grace renders keep your app working while you decide.`
                : 'After that, renders return HTTP 402 until next month.',
              next ? `${next.plan.name} gives you ${next.plan.monthlyRenders} renders for $${next.plan.priceUsd}/month: ${next.url}` : `Need more? ${contactLine()}.`,
            ].join('\n\n'),
          });
        }
      } catch (e) {
        const m = mapRenderError(e);
        // A failure after the PDF exists (e.g. disk write for output:'url') is ours, so it is refunded too.
        if (m.release || pdf) store.releaseRender(account.id);
        logRenderFailure({ route: '/v1/render', account, body, status: m.status, code: e?.code, requestId, e });
        if (res.headersSent) return res.destroy();
        if (m.retryAfter) res.set('Retry-After', String(m.retryAfter));
        res.status(m.status).json(m.status === 500 ? { ...m.body, request_id: requestId } : m.body);
      }
    } finally {
      const n = (inFlight.get(account.id) || 1) - 1;
      if (n <= 0) inFlight.delete(account.id);
      else inFlight.set(account.id, n);
    }
  });

  const PUBLIC_V1 = new Set(['/demo/render', '/keys/recover', '/keys/recover/confirm']);
  app.use('/v1', (req, res, next) => (PUBLIC_V1.has(req.path) ? next() : api(req, res, next)));

  // Public, watermarked demo so visitors can try the gallery before signing up.
  const demoCache = new Map();
  let demoInFlight = 0;
  app.post('/v1/demo/render', rateLimit({ windowMs: HOUR, max: 30 }), async (req, res) => {
    const body = req.body || {};
    const tpl = getGalleryTemplate(String(body.template_id || ''));
    if (!tpl) return res.status(400).json({ error: 'demo_supports_gallery_only' });
    const parsed = parseData(body.data);
    if (parsed.error) return res.status(400).json(parsed.error);
    let data = parsed.value;
    if (typeof data !== 'object' || data === null) data = undefined;
    else if (JSON.stringify(data).length > DEMO_MAX_DATA_CHARS) data = undefined;
    const cacheable = data === undefined || JSON.stringify(data) === JSON.stringify(tpl.sampleData);
    const filename = `${tpl.id.slice(8)}-demo.pdf`;
    if (data === undefined) res.set('X-DocForge-Sample-Data', 'true');

    if (cacheable && demoCache.has(tpl.id)) return sendPdf(res, demoCache.get(tpl.id), { filename });
    if (demoInFlight >= DEMO_MAX_IN_FLIGHT) {
      res.set('Retry-After', '5');
      return res.status(429).json({ error: 'demo_busy', message: 'The live demo is busy. Try again in a few seconds, or sign up free for your own quota.' });
    }
    if ((renderer.queueLength ?? 0) > DEMO_MAX_QUEUE) {
      res.set('Retry-After', '5');
      return res.status(503).json({ error: 'busy', message: 'All renderers are busy. Retry in a few seconds.' });
    }
    demoInFlight++;
    const requestId = crypto.randomUUID();
    try {
      const pdf = await renderer.pdf({
        html: tpl.html, css: tpl.css, data: data ?? tpl.sampleData, options: tpl.options || {}, watermark: 'demo', maxPages: 5,
      });
      if (cacheable) demoCache.set(tpl.id, pdf);
      await sendPdf(res, pdf, { filename });
    } catch (e) {
      const m = mapRenderError(e);
      const isTemplate = m.body.error === 'template_error';
      const status = isTemplate ? 422 : m.status === 503 ? 503 : 500;
      logRenderFailure({ route: '/v1/demo/render', account: null, body, status, code: e?.code, requestId, e });
      if (res.headersSent) return res.destroy();
      if (status === 503) res.set('Retry-After', '5');
      if (isTemplate) return res.status(422).json(m.body);
      if (status === 503) return res.status(503).json(m.body);
      res.status(500).json({ error: 'render_failed', message: 'Rendering failed; please retry or contact support.', request_id: requestId });
    } finally {
      demoInFlight--;
    }
  });

  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid_json' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
    console.error(err);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

if (require.main === module) {
  (async () => {
    if (process.env.NODE_ENV === 'production') {
      const drafts = unfinishedLegalPages();
      if (drafts.length && process.env.ALLOW_DRAFT_LEGAL !== '1') {
        console.error(`FATAL: ${drafts.join(', ')} still contain [TODO] placeholders. Signups would agree to terms with no named operator or governing law. Fill public/guides/{terms,privacy,refunds}.html, or set ALLOW_DRAFT_LEGAL=1 for a private staging run.`);
        process.exit(1);
      }
      const dbPath = path.resolve(process.env.DB_PATH || '');
      if (!dbPath.startsWith('/data/')) {
        console.warn(`!!! DB_PATH resolves to ${dbPath}, which is not on the /data volume; in Docker every redeploy will delete it.`);
      }
    }
    const store = new Store(openDb());
    const publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000';
    const renderer = new Renderer({ publicUrl });
    try {
      await renderer.getBrowser();
    } catch (e) {
      console.error(`Chromium failed to launch (set CHROMIUM_PATH?): ${firstLine(e)}`);
      process.exit(1);
    }

    const backupDir = process.env.BACKUP_DIR || '/data/backups';
    let backupsOn = false;
    try { fs.mkdirSync(backupDir, { recursive: true }); backupsOn = true; } catch (e) {
      console.warn(`Backups disabled: cannot create ${backupDir}: ${firstLine(e)}`);
    }
    const backup = () => {
      try { console.log(JSON.stringify({ evt: 'backup_ok', file: store.snapshot(backupDir) })); } catch (e) {
        console.error(JSON.stringify({ evt: 'backup_failed', dir: backupDir, err: firstLine(e) }));
      }
    };
    if (backupsOn) {
      backup();
      setInterval(backup, 24 * HOUR).unref();
    }

    const port = Number(process.env.PORT) || 3000;
    const server = createApp({ store, renderer }).listen(port, () => console.log(`DocForge listening on :${port}`));
    const shutdown = () => server.close(() => renderer.close().finally(() => process.exit(0)));
    process.on('SIGTERM', shutdown);
    process.on('SIGINT', shutdown);
  })();
}

module.exports = { createApp, sendMail, parseTrustProxy, clientKey, unfinishedLegalPages, maskEmail };
