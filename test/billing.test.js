const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { openDb, Store } = require('../src/db');
const { PLANS, planFromVariant, configuredVariants } = require('../src/plans');

process.env.LS_VARIANT_STARTER = '111';
process.env.LS_VARIANT_PRO = '222';
delete process.env.LS_VARIANT_BUSINESS;
const SECRET = 'whsec_billing';
const CHECKOUT = { starter: 'https://shop.example/checkout/buy/starter', pro: 'https://shop.example/checkout/buy/pro' };

// Stub renderer: no Chromium needed. `mode` switches behaviour per test.
const stub = {
  mode: 'ok',
  queueLength: 0,
  status: () => ({ connected: true, lastLaunchError: null, active: 0, queued: 0 }),
  pdf() {
    if (stub.mode === 'hang') return new Promise(() => {});
    if (stub.mode === 'busy') return Promise.reject(Object.assign(new Error('queue full'), { code: 'BUSY' }));
    if (stub.mode === 'crash') return Promise.reject(new Error('page.pdf: Target closed\n  at internal stack'));
    if (stub.mode === 'pages') return Promise.reject(Object.assign(new Error('Document has 30 pages; plan allows 20'), { code: 'TOO_MANY_PAGES' }));
    return Promise.resolve(Buffer.from('%PDF-1.4 stub'));
  },
};

const mails = [];
let server, base, store;

function start(config) {
  const app = createApp({
    store,
    renderer: stub,
    config: { webhookSecret: SECRET, signupsPerHour: 1000, checkoutUrls: CHECKOUT, mailer: async (m) => { mails.push(m); }, ...config },
  });
  return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
}

before(async () => {
  store = new Store(openDb(':memory:'));
  server = await start({});
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

const json = (method, path, body, key, b = base) =>
  fetch(b + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signup(email, extra = {}) {
  const res = await json('POST', '/v1/signup', { email, ...extra });
  assert.equal(res.status, 201);
  return res.json();
}

function webhook(name, { accountId, subId, status, variantId, attrs = {} }) {
  const payload = JSON.stringify({
    meta: { event_name: name, custom_data: accountId ? { account_id: accountId } : undefined },
    data: { id: subId, attributes: { status, variant_id: variantId, ...attrs } },
  });
  const signature = crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
  return fetch(`${base}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body: payload });
}

test('plans: pricing, grace and variant mapping read env at call time', () => {
  assert.deepEqual(
    Object.values(PLANS).map((p) => [p.priceUsd, p.monthlyRenders, p.templates, p.graceRenders, p.concurrency, p.maxPages]),
    [[0, 100, 3, 0, 1, 20], [15, 2500, 20, 250, 2, 200], [39, 10000, 100, 1000, 3, 500], [99, 50000, 500, 5000, 4, 500]]
  );
  assert.equal(planFromVariant(111), 'starter');
  assert.equal(planFromVariant('undefined'), null);
  assert.equal(planFromVariant(undefined), null);
  process.env.LS_VARIANT_PRO_YEARLY = '333';
  assert.equal(planFromVariant('333'), 'pro');
  delete process.env.LS_VARIANT_PRO_YEARLY;
  assert.equal(planFromVariant('333'), null);
  assert.deepEqual(configuredVariants(), { 111: 'starter', 222: 'pro' });
});

test('signup returns upgrade_urls, stores source and sends a welcome mail', async () => {
  const body = await signup('src@test.dev', { source: '  hn  ' });
  assert.match(body.upgrade_urls.starter, /checkout%5Bcustom%5D%5Baccount_id%5D=acc_/);
  assert.ok(body.upgrade_urls.pro);
  assert.equal(body.upgrade_urls.business, undefined);
  assert.equal(store.accountByEmail('src@test.dev').source, 'hn');
  await new Promise((r) => setImmediate(r));
  const welcome = mails.find((m) => m.to === 'src@test.dev');
  assert.ok(welcome);
  assert.match(welcome.text, /gallery:invoice/);
  assert.ok(!welcome.text.includes(body.api_key), 'welcome mail must not contain the full key');
});

test('free quota 402 carries upgrade_urls with account id', async () => {
  const { api_key: key } = await signup('freequota@test.dev');
  const acc = store.accountByKey(key);
  for (let i = 0; i < 100; i++) store.reserveRender(acc.id, 100);
  const res = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, 'quota_exceeded');
  assert.match(body.upgrade_url, /\/#pricing$/);
  assert.ok(body.upgrade_urls.starter.includes(acc.id));
  assert.match(body.message, /Upgrade instantly: https:\/\/shop\.example\/checkout\/buy\/starter/);
  assert.match(body.message, /10% grace/);
});

test('paid plan renders inside the grace band with a warning header', async () => {
  const { api_key: key } = await signup('grace@test.dev');
  const acc = store.accountByKey(key);
  store.setPlan(acc.id, 'starter', 'sub_g');
  for (let i = 0; i < PLANS.starter.monthlyRenders; i++) store.reserveRender(acc.id, 1e9);
  const res = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-quota-warning'), 'over_limit');
  assert.equal(res.headers.get('x-renders-remaining'), '0');
  assert.equal(res.headers.get('x-renders-limit'), '2500');
  assert.match(res.headers.get('x-upgrade-url'), /buy\/pro.*account_id/);
  const me = await (await json('GET', '/v1/me', undefined, key)).json();
  assert.equal(me.renders_grace, 250);
  assert.equal(me.status, 'active');
  assert.ok(me.upgrade_urls.pro);
  assert.equal(me.upgrade_urls.starter, undefined);
});

test('webhooks: newest subscription wins, stale expiry ignored, refund downgrades', async () => {
  const { api_key: key } = await signup('wh@test.dev');
  const acc = store.accountByKey(key);
  assert.equal((await webhook('subscription_created', { accountId: acc.id, subId: '1', status: 'active', variantId: 111 })).status, 200);
  assert.equal(store.accountById(acc.id).plan, 'starter');
  assert.equal((await webhook('subscription_created', { accountId: acc.id, subId: '2', status: 'active', variantId: 222 })).status, 200);
  assert.equal(store.accountById(acc.id).plan, 'pro');
  const stale = await webhook('subscription_expired', { accountId: acc.id, subId: '1', status: 'expired', variantId: 111 });
  assert.equal(stale.status, 200);
  assert.equal((await stale.json()).ignored, 'stale_subscription');
  const staleCancel = await webhook('subscription_cancelled', { accountId: acc.id, subId: '1', status: 'cancelled', variantId: 111 });
  assert.equal(staleCancel.status, 200);
  assert.equal(store.accountById(acc.id).plan, 'pro');

  const payment = await webhook('subscription_payment_success', { accountId: acc.id, subId: 'inv_1', status: 'paid', attrs: { subscription_id: 2 } });
  assert.equal(payment.status, 200);
  assert.equal(store.accountById(acc.id).plan, 'pro');

  const refund = await webhook('subscription_payment_refunded', { accountId: acc.id, subId: 'inv_1', status: 'refunded', attrs: { subscription_id: 2 } });
  assert.equal(refund.status, 200);
  assert.equal(store.accountById(acc.id).plan, 'free');
});

test('webhooks: unmapped live variant and missing account id return 500', async () => {
  const { api_key: key } = await signup('unmapped@test.dev');
  const acc = store.accountByKey(key);
  assert.equal((await webhook('subscription_created', { accountId: acc.id, subId: '9', status: 'active', variantId: 999 })).status, 500);
  assert.equal((await webhook('subscription_updated', { subId: '9', status: 'active', variantId: 111 })).status, 500);
  assert.equal(store.accountById(acc.id).plan, 'free');
});

test('checkout: 409 when already subscribed, 400 for unknown plan', async () => {
  const { api_key: key } = await signup('checkout@test.dev');
  const acc = store.accountByKey(key);
  const first = await json('GET', '/v1/billing/checkout?plan=starter', undefined, key);
  assert.equal(first.status, 200);
  assert.match((await first.json()).checkout_url, /checkout%5Bemail%5D=checkout%40test\.dev/);
  const unknown = await json('GET', '/v1/billing/checkout?plan=business', undefined, key);
  assert.equal(unknown.status, 400);
  assert.deepEqual((await unknown.json()).plans, ['starter', 'pro']);
  await webhook('subscription_created', { accountId: acc.id, subId: '50', status: 'active', variantId: 111 });
  const second = await json('GET', '/v1/billing/checkout?plan=pro', undefined, key);
  assert.equal(second.status, 409);
  const body = await second.json();
  assert.equal(body.error, 'already_subscribed');
  assert.equal(body.manage_url, 'https://app.lemonsqueezy.com/my-orders');
});

test('template_limit 402 names the next plan', async () => {
  const { api_key: key } = await signup('tpl@test.dev');
  for (const n of ['a', 'b', 'c']) assert.equal((await json('POST', '/v1/templates', { name: n, html: '<p>x</p>' }, key)).status, 201);
  const res = await json('POST', '/v1/templates', { name: 'd', html: '<p>d</p>' }, key);
  assert.equal(res.status, 402);
  const body = await res.json();
  assert.equal(body.error, 'template_limit');
  assert.match(body.message, /Starter allows 20/);
  assert.ok(body.upgrade_urls.starter);
});

test('suspended accounts get 403', async () => {
  const { api_key: key } = await signup('suspended@test.dev');
  store.setStatus(store.accountByKey(key).id, 'suspended');
  const res = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error, 'account_suspended');
});

test('key recovery: 202 always, token rotates the key once', async () => {
  const { api_key: oldKey } = await signup('lost@test.dev');
  mails.length = 0;
  const unknown = await json('POST', '/v1/keys/recover', { email: 'nobody@test.dev' });
  assert.equal(unknown.status, 202);
  const known = await json('POST', '/v1/keys/recover', { email: 'LOST@test.dev' });
  assert.equal(known.status, 202);
  assert.deepEqual(await known.json(), await unknown.json());
  await new Promise((r) => setImmediate(r));
  assert.equal(mails.length, 1);
  const token = mails[0].text.match(/#recover=([\w-]+)/)[1];

  const ok = await json('POST', '/v1/keys/recover/confirm', { token });
  assert.equal(ok.status, 200);
  const { api_key: newKey } = await ok.json();
  assert.notEqual(newKey, oldKey);
  assert.equal((await json('GET', '/v1/me', undefined, oldKey)).status, 401);
  assert.equal((await json('GET', '/v1/me', undefined, newKey)).status, 200);
  const reused = await json('POST', '/v1/keys/recover/confirm', { token });
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).error, 'invalid_token');
});

test('duplicate signup points to key recovery', async () => {
  await signup('dup2@test.dev');
  const res = await json('POST', '/v1/signup', { email: 'dup2@test.dev' });
  assert.equal(res.status, 409);
  assert.match((await res.json()).message, /#recover/);
});

test('renderer errors map to stable codes and refund quota', async () => {
  const { api_key: key } = await signup('errors@test.dev');
  const id = store.accountByKey(key).id;
  try {
    stub.mode = 'busy';
    const busy = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get('retry-after'), '5');
    stub.mode = 'crash';
    const crash = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
    assert.equal(crash.status, 500);
    const body = await crash.json();
    assert.equal(body.error, 'render_failed');
    assert.ok(body.request_id);
    assert.ok(!body.message.includes('Target closed'));
    assert.equal(store.usage(id), 0);
    stub.mode = 'pages';
    const pages = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
    assert.equal(pages.status, 422);
    assert.equal((await pages.json()).error, 'too_many_pages');
    assert.equal(store.usage(id), 1, 'too_many_pages keeps the reservation');
  } finally {
    stub.mode = 'ok';
  }
});

test('second concurrent free render gets 429 concurrency_limit', async () => {
  const { api_key: key } = await signup('concurrent@test.dev');
  stub.mode = 'hang';
  const ctrl = new AbortController();
  const firstReq = fetch(`${base}/v1/render`, {
    method: 'POST', signal: ctrl.signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ html: '<p>y</p>' }),
  }).catch(() => {});
  await new Promise((r) => setTimeout(r, 100));
  stub.mode = 'ok';
  const second = await json('POST', '/v1/render', { html: '<p>z</p>' }, key);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error, 'concurrency_limit');
  assert.equal(second.headers.get('retry-after'), '1');
  ctrl.abort();
  await firstReq;
});

test('rate limit ignores X-Forwarded-For when trust proxy is off', async () => {
  const s = await start({ signupsPerHour: 2, trustProxy: false });
  const b = `http://127.0.0.1:${s.address().port}`;
  try {
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${b}/v1/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `203.0.113.${i + 1}` },
        body: JSON.stringify({ email: `xff${i}@test.dev` }),
      });
      statuses.push(res.status);
    }
    assert.deepEqual(statuses, [201, 201, 429]);
  } finally {
    s.closeAllConnections();
    s.close();
  }
});

test('demo: string data and sample cache', async () => {
  let calls = 0;
  const orig = stub.pdf;
  stub.pdf = (args) => { calls++; assert.equal(args.watermark, 'demo'); assert.equal(args.maxPages, 5); return orig(args); };
  try {
    assert.equal((await json('POST', '/v1/demo/render', { template_id: 'gallery:quote' })).status, 200);
    assert.equal((await json('POST', '/v1/demo/render', { template_id: 'gallery:quote' })).status, 200);
    assert.equal(calls, 1, 'sample-data demo renders are cached');
    const str = await json('POST', '/v1/demo/render', { template_id: 'gallery:quote', data: JSON.stringify({ number: 'Q-1' }) });
    assert.equal(str.status, 200);
    assert.equal(calls, 2);
    const bad = await json('POST', '/v1/demo/render', { template_id: 'gallery:quote', data: '{' });
    assert.equal(bad.status, 400);
  } finally {
    stub.pdf = orig;
  }
});

test('healthz reports renderer launch failure as 503', async () => {
  const orig = stub.status;
  stub.status = () => ({ connected: false, lastLaunchError: 'no chromium', active: 0, queued: 0 });
  try {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).ok, false);
  } finally {
    stub.status = orig;
  }
});

test('store snapshot keeps the newest backups', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforge-bak-'));
  try {
    for (let d = 1; d <= 9; d++) fs.writeFileSync(path.join(dir, `docforge-2020-01-0${d}.db`), '');
    const file = store.snapshot(dir);
    assert.ok(fs.statSync(file).size > 0);
    const left = fs.readdirSync(dir).sort();
    assert.equal(left.length, 7);
    assert.ok(left.includes(path.basename(file)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
