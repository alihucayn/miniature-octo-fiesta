const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/server');
const { openDb, Store } = require('../src/db');
const { Renderer, buildHtml, isPrivateIp } = require('../src/render');

process.env.LS_VARIANT_PRO = '222';
const SECRET = 'whsec_test';

let server, base, store, renderer;

before(async () => {
  store = new Store(openDb(':memory:'));
  renderer = new Renderer({ maxConcurrent: 2 });
  const app = createApp({ store, renderer, config: { webhookSecret: SECRET, signupsPerHour: 1000, checkoutUrls: { pro: 'https://shop.example/checkout/buy/abc' } } });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.close();
  await renderer.close();
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
