const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../src/server');
const { openDb, Store } = require('../src/db');
const { Renderer, buildHtml, isPrivateIp } = require('../src/render');

process.env.LS_VARIANT_PRO = '222';
const SECRET = 'whsec_test';

let server, base, store, renderer;
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforge-files-'));

before(async () => {
  store = new Store(openDb(':memory:'));
  renderer = new Renderer({ maxConcurrent: 2 });
  const app = createApp({ store, renderer, config: {
    webhookSecret: SECRET, signupsPerHour: 1000, checkoutUrls: { pro: 'https://shop.example/checkout/buy/abc' },
    supportEmail: 'help@docforge.test', filesDir, mailer: async () => {},
  } });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await renderer.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const json = (method, path, body, key) =>
  fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signup(email) {
  const res = await json('POST', '/v1/signup', { email });
  assert.equal(res.status, 201);
  return (await res.json()).api_key;
}

test('helpers compute invoice totals and escape data', () => {
  const html = buildHtml({
    html: '{{money (sum items "qty" "price") "USD"}}|{{fixed 3}}|{{name}}',
    data: { items: [{ qty: 2, price: 10 }, { qty: 1, price: 5.5 }], name: '<b>x</b>' },
  });
  assert.match(html, /\$25\.50\|3\.00\|&lt;b&gt;x&lt;\/b&gt;/);
});

test('private addresses are blocked for asset fetches', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.0.1', '172.20.0.1', '::1', '::ffff:10.0.0.1', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  assert.equal(isPrivateIp('8.8.8.8'), false);
});

test('signup, render gallery invoice, usage is counted', async () => {
  const key = await signup('render@test.dev');
  const res = await json('POST', '/v1/render', { template_id: 'gallery:invoice' }, key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const me = await (await json('GET', '/v1/me', undefined, key)).json();
  assert.equal(me.renders_used, 1);
  assert.equal(me.plan, 'free');
});

test('render inline html as base64', async () => {
  const key = await signup('inline@test.dev');
  const res = await json('POST', '/v1/render', { html: '<h1>Hi {{name}}</h1>', data: { name: 'Ali' }, output: 'base64' }, key);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(Buffer.from(body.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
});

test('template errors return 422 and do not consume quota', async () => {
  const key = await signup('broken@test.dev');
  const res = await json('POST', '/v1/render', { html: '{{#if}}' }, key);
  assert.equal(res.status, 422);
  const me = await (await json('GET', '/v1/me', undefined, key)).json();
  assert.equal(me.renders_used, 0);
});

test('quota is enforced', async () => {
  const key = await signup('quota@test.dev');
  const acc = store.accountByKey(key);
  for (let i = 0; i < 100; i++) assert.equal(store.reserveRender(acc.id, 100), true);
  const res = await json('POST', '/v1/render', { html: '<p>x</p>' }, key);
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error, 'quota_exceeded');
});

test('template CRUD, tenant isolation and plan limits', async () => {
  const key = await signup('crud@test.dev');
  const other = await signup('other@test.dev');
  const created = await json('POST', '/v1/templates', { from_gallery: 'receipt', name: 'My receipt' }, key);
  assert.equal(created.status, 201);
  const tpl = await created.json();
  assert.equal(tpl.name, 'My receipt');

  assert.equal((await json('GET', `/v1/templates/${tpl.id}`, undefined, other)).status, 404);
  assert.equal((await json('POST', '/v1/render', { template_id: tpl.id }, other)).status, 404);

  const upd = await json('PUT', `/v1/templates/${tpl.id}`, { name: 'Renamed' }, key);
  assert.equal((await upd.json()).name, 'Renamed');

  const rendered = await json('POST', '/v1/render', { template_id: tpl.id }, key);
  assert.equal(rendered.status, 200);

  await json('POST', '/v1/templates', { name: 'b', html: '<p>b</p>' }, key);
  await json('POST', '/v1/templates', { name: 'c', html: '<p>c</p>' }, key);
  const fourth = await json('POST', '/v1/templates', { name: 'd', html: '<p>d</p>' }, key);
  assert.equal(fourth.status, 402);

  assert.equal((await json('DELETE', `/v1/templates/${tpl.id}`, undefined, key)).status, 204);
});

test('auth is required', async () => {
  assert.equal((await json('GET', '/v1/me')).status, 401);
  assert.equal((await json('GET', '/v1/me', undefined, 'df_live_nope')).status, 401);
});

test('duplicate signup is rejected', async () => {
  await signup('dup@test.dev');
  assert.equal((await json('POST', '/v1/signup', { email: 'DUP@test.dev' })).status, 409);
});

test('lemon squeezy webhook upgrades and downgrades the plan', async () => {
  const key = await signup('billing@test.dev');
  const acc = store.accountByKey(key);

  const checkout = await (await json('GET', '/v1/billing/checkout?plan=pro', undefined, key)).json();
  assert.match(checkout.checkout_url, /checkout%5Bcustom%5D%5Baccount_id%5D=acc_/);

  const send = (status, sig) => {
    const payload = JSON.stringify({
      meta: { event_name: 'subscription_updated', custom_data: { account_id: acc.id } },
      data: { id: '99', attributes: { status, variant_id: 222 } },
    });
    const signature = sig || crypto.createHmac('sha256', SECRET).update(payload).digest('hex');
    return fetch(`${base}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': signature }, body: payload });
  };

  assert.equal((await send('active', 'deadbeef')).status, 401);
  assert.equal((await send('active')).status, 200);
  assert.equal(store.accountByKey(key).plan, 'pro');
  await send('expired');
  assert.equal(store.accountByKey(key).plan, 'free');
});

test('public demo renders gallery templates only', async () => {
  const ok = await json('POST', '/v1/demo/render', { template_id: 'gallery:certificate' });
  assert.equal(ok.status, 200);
  const bad = await json('POST', '/v1/demo/render', { template_id: 'tpl_x', html: '<p>' });
  assert.equal(bad.status, 400);
});

test('data may be a JSON-encoded string', async () => {
  const key = await signup('stringdata@test.dev');
  const res = await json('POST', '/v1/render', { html: '<h1>Hi {{name}}</h1>', data: JSON.stringify({ name: 'Ali' }) }, key);
  assert.equal(res.status, 200);
  assert.equal(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal(res.headers.get('x-renders-limit'), '100');
  assert.equal(res.headers.get('x-renders-remaining'), '99');
  const bad = await json('POST', '/v1/render', { html: '<p>x</p>', data: '{nope' }, key);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_data');
});

test('gallery render without data flags sample data', async () => {
  const key = await signup('sample@test.dev');
  const res = await json('POST', '/v1/render', { template_id: 'gallery:receipt', output: 'base64' }, key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-docforge-sample-data'), 'true');
});

test("output:'url' returns a fetchable hosted PDF", async () => {
  const key = await signup('hosted@test.dev');
  const res = await json('POST', '/v1/render', { html: '<p>hosted</p>', output: 'url', filename: 'inv 42' }, key);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.filename, 'inv_42.pdf');
  assert.equal(body.content_type, 'application/pdf');
  assert.ok(Date.parse(body.expires_at) > Date.now());
  const m = body.url.match(/\/f\/([\w-]{32})\/inv_42\.pdf$/);
  assert.ok(m, body.url);
  const file = await fetch(`${base}/f/${m[1]}/inv_42.pdf`);
  assert.equal(file.status, 200);
  assert.match(file.headers.get('content-disposition'), /attachment/);
  assert.equal(Buffer.from(await file.arrayBuffer()).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await fetch(`${base}/f/${'x'.repeat(32)}/a.pdf`)).status, 404);
  assert.equal((await fetch(`${base}/f/short/a.pdf`)).status, 404);
});

test('request shape validation: base_url, raw, format', async () => {
  const key = await signup('shape@test.dev');
  const http = await json('POST', '/v1/render', { html: '<p>x</p>', base_url: 'http://x' }, key);
  assert.equal(http.status, 400);
  assert.equal((await http.json()).error, 'invalid_base_url');
  const fmt = await json('POST', '/v1/render', { html: '<p>x</p>', options: { format: 'A9' } }, key);
  assert.equal(fmt.status, 400);
  assert.equal((await fmt.json()).error, 'invalid_option');
  const ok = await json('POST', '/v1/render', { html: '<p>x</p>', options: { format: 'Letter' }, output: 'base64' }, key);
  assert.equal(ok.status, 200);
  const me = await (await json('GET', '/v1/me', undefined, key)).json();
  assert.equal(me.renders_used, 1);
});

test('sitemap, robots, healthz and plans', async () => {
  const sm = await fetch(`${base}/sitemap.xml`);
  assert.equal(sm.status, 200);
  assert.match(await sm.text(), /\/docs</);
  assert.match(await (await fetch(`${base}/robots.txt`)).text(), /Disallow: \/v1\//);
  const hz = await fetch(`${base}/healthz`);
  assert.equal(hz.status, 200);
  assert.equal((await hz.json()).ok, true);
  const plans = await (await fetch(`${base}/v1/plans`)).json();
  assert.equal(plans.support_email, 'help@docforge.test');
  assert.equal(plans.plans.starter.priceUsd, 15);
  assert.equal(plans.plans.starter.graceRenders, 250);
  assert.equal(typeof plans.public_url, 'string');
});
