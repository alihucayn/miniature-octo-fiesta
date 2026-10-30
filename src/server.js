const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { openDb, Store, currentMonth } = require('./db');
const { Renderer } = require('./render');
const { PLANS, planFromVariant } = require('./plans');
const { GALLERY, getGalleryTemplate } = require('../gallery');

const MAX_TEMPLATE_BYTES = 512 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Fixed-window in-memory limiter; good enough for a single instance.
function rateLimit({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip;
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

function createApp({ store, renderer, config = {} }) {
  const app = express();
  app.set('trust proxy', config.trustProxy ?? 1);
  app.disable('x-powered-by');

  const publicUrl = config.publicUrl || process.env.PUBLIC_URL || 'http://localhost:3000';
  const webhookSecret = config.webhookSecret ?? process.env.LS_WEBHOOK_SECRET;
  const checkoutUrls = config.checkoutUrls || {
    starter: process.env.LS_CHECKOUT_STARTER,
    pro: process.env.LS_CHECKOUT_PRO,
    business: process.env.LS_CHECKOUT_BUSINESS,
  };

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

    const name = event?.meta?.event_name;
    const attrs = event?.data?.attributes || {};
    const accountId = event?.meta?.custom_data?.account_id;
    if (!name?.startsWith('subscription_') || !accountId) return res.json({ ignored: true });

    const plan = planFromVariant(attrs.variant_id);
    // "cancelled" subscriptions stay usable until they expire.
    const live = ['active', 'on_trial', 'past_due', 'cancelled'].includes(attrs.status);
    if (live && plan) store.setPlan(accountId, plan, String(event.data.id));
    else if (['expired', 'unpaid'].includes(attrs.status)) store.setPlan(accountId, 'free');
    res.json({ ok: true });
  });

  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  app.get('/healthz', (req, res) => res.json({ ok: true }));

  app.get('/v1/plans', (req, res) => res.json({ plans: PLANS }));

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

  app.post('/v1/signup', rateLimit({ windowMs: 60 * 60 * 1000, max: config.signupsPerHour ?? 5 }), (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) return res.status(400).json({ error: 'invalid_email' });
    if (store.accountByEmail(email)) {
      return res.status(409).json({ error: 'email_taken', message: 'An account with this email already exists. Contact support to recover your key.' });
    }
    const acc = store.createAccount(email);
    res.status(201).json({
      api_key: acc.apiKey,
      plan: acc.plan,
      message: 'Store this key now: it is shown only once.',
    });
  });

  // ---- authenticated routes ----
  function auth(req, res, next) {
    const header = req.get('Authorization') || '';
    const key = header.startsWith('Bearer ') ? header.slice(7).trim() : req.get('X-API-Key');
    const account = key && store.accountByKey(key);
    if (!account) return res.status(401).json({ error: 'unauthorized', message: 'Pass your API key as "Authorization: Bearer <key>".' });
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
      key_prefix: req.account.key_prefix,
      month: currentMonth(),
      renders_used: used,
      renders_limit: req.plan.monthlyRenders,
      templates_used: store.countTemplates(req.account.id),
      templates_limit: req.plan.templates,
    });
  });

  api.post('/keys/rotate', (req, res) => {
    res.json({ api_key: store.rotateKey(req.account.id), message: 'Old key revoked. Store this key now.' });
  });

  api.get('/billing/checkout', (req, res) => {
    const plan = String(req.query.plan || '');
    const base = checkoutUrls[plan];
    if (!base) return res.status(400).json({ error: 'unknown_plan', plans: Object.keys(checkoutUrls).filter((p) => checkoutUrls[p]) });
    const url = new URL(base);
    url.searchParams.set('checkout[custom][account_id]', req.account.id);
    url.searchParams.set('checkout[email]', req.account.email);
    res.json({ checkout_url: url.toString() });
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
      return res.status(402).json({ error: 'template_limit', message: `Your ${req.plan.name} plan allows ${req.plan.templates} templates. Upgrade for more.` });
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
      const t = id.startsWith('gallery:') ? getGalleryTemplate(id) : store.getTemplate(account.id, id);
      if (!t) return { error: 'template_not_found' };
      return { html: t.html, css: t.css, options: t.options || {}, sample: t.sampleData || t.sample_data };
    }
    if (typeof body.html === 'string' && body.html.trim()) {
      if (Buffer.byteLength(body.html + (body.css || '')) > MAX_TEMPLATE_BYTES) return { error: 'template_too_large' };
      return { html: body.html, css: typeof body.css === 'string' ? body.css : '', options: {} };
    }
    return { error: 'missing_template', message: 'Provide template_id or html.' };
  }

  async function sendPdf(res, pdf, body) {
    const filename = String(body.filename || 'document.pdf').replace(/[^\w.\-]+/g, '_').slice(0, 120);
    if (body.output === 'base64') {
      return res.json({ filename, content_type: 'application/pdf', size: pdf.length, base64: pdf.toString('base64') });
    }
    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', `inline; filename="${filename.endsWith('.pdf') ? filename : `${filename}.pdf`}"`);
    res.send(pdf);
  }

  api.post('/render', async (req, res) => {
    const body = req.body || {};
    const src = resolveSource(req.account, body);
    if (src.error) return res.status(src.error === 'template_not_found' ? 404 : 400).json(src);
    const data = body.data ?? src.sample ?? {};
    if (typeof data !== 'object' || data === null) return res.status(400).json({ error: 'invalid_data', message: 'data must be a JSON object' });

    if (!store.reserveRender(req.account.id, req.plan.monthlyRenders)) {
      return res.status(402).json({
        error: 'quota_exceeded',
        message: `You used all ${req.plan.monthlyRenders} renders on the ${req.plan.name} plan this month. Upgrade at ${publicUrl}/#pricing`,
      });
    }
    try {
      const pdf = await renderer.pdf({
        html: src.html, css: src.css, data, options: { ...src.options, ...(body.options || {}) }, watermark: req.plan.watermark,
      });
      res.set('X-Renders-Remaining', String(req.plan.monthlyRenders - store.usage(req.account.id)));
      await sendPdf(res, pdf, body);
    } catch (e) {
      // Failed renders don't count against the quota.
      store.releaseRender(req.account.id);
      const isTemplate = /Parse error|Expecting|Missing helper/i.test(e.message);
      res.status(isTemplate ? 422 : 500).json({ error: isTemplate ? 'template_error' : 'render_failed', message: e.message.split('\n').slice(0, 4).join('\n') });
    }
  });

  app.use('/v1', (req, res, next) => (req.path === '/demo/render' ? next() : api(req, res, next)));

  // Public, watermarked demo so visitors can try the gallery before signing up.
  app.post('/v1/demo/render', rateLimit({ windowMs: 60 * 60 * 1000, max: 30 }), async (req, res) => {
    const body = req.body || {};
    const tpl = getGalleryTemplate(String(body.template_id || ''));
    if (!tpl) return res.status(400).json({ error: 'demo_supports_gallery_only' });
    const data = typeof body.data === 'object' && body.data !== null ? body.data : tpl.sampleData;
    try {
      const pdf = await renderer.pdf({ html: tpl.html, css: tpl.css, data, options: tpl.options || {}, watermark: true });
      await sendPdf(res, pdf, { filename: `${tpl.id.slice(8)}-demo.pdf` });
    } catch (e) {
      res.status(422).json({ error: 'render_failed', message: e.message.split('\n')[0] });
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
  const store = new Store(openDb());
  const renderer = new Renderer();
  const port = Number(process.env.PORT) || 3000;
  const server = createApp({ store, renderer }).listen(port, () => console.log(`DocForge listening on :${port}`));
  const shutdown = () => server.close(() => renderer.close().finally(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createApp };
