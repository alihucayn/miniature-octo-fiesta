// Static pages, response headers and small server helpers. Uses a stub
// renderer, so no Chromium and no network are needed.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createApp, sendMail, parseTrustProxy, clientKey, unfinishedLegalPages, maskEmail } = require('../src/server');
const { openDb, Store } = require('../src/db');

const stub = {
  next: null, // optional override for the next pdf() call
  calls: [],
  queueLength: 0,
  status: () => ({ connected: true, lastLaunchError: null, active: 0, queued: 0 }),
  pdf(args) {
    stub.calls.push(args);
    if (stub.next) { const f = stub.next; stub.next = null; return f(args); }
    return Promise.resolve(Buffer.from('%PDF-1.4 stub'));
  },
};

const mails = [];
let server, base, store;
const filesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforge-site-'));

before(async () => {
  store = new Store(openDb(':memory:'));
  const app = createApp({
    store,
    renderer: stub,
    config: { signupsPerHour: 1000, filesDir, mailer: async (m) => { mails.push(m); } },
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(filesDir, { recursive: true, force: true });
});

const json = (method, p, body, key) =>
  fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function signup(email, extra = {}) {
  const res = await json('POST', '/v1/signup', { email, ...extra });
  assert.equal(res.status, 201);
  return res.json();
}

test('parseTrustProxy: unset is false, numbers are parsed, names pass through', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('true'), true);
  assert.equal(parseTrustProxy('1'), 1);
  assert.equal(parseTrustProxy(' 2 '), 2);
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy(1), 1);
});

test('clientKey: IPv4-mapped is IPv4, IPv6 keyed by its /64', () => {
  assert.equal(clientKey('::ffff:203.0.113.5'), '203.0.113.5');
  assert.equal(clientKey('203.0.113.5'), '203.0.113.5');
  const a = clientKey('2001:db8:aa:bb:1:2:3:4');
  assert.equal(a, '2001:db8:aa:bb::/64');
  assert.equal(clientKey('2001:0db8:00aa:00bb:ffff::1'), a, 'same /64 shares a bucket');
  assert.equal(clientKey('2001:db8::1'), '2001:db8:0:0::/64');
  assert.notEqual(clientKey('2001:db8:aa:bc::1'), a);
  assert.equal(clientKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
});

test('sendMail without Resend config logs to/subject only, never the body', async () => {
  const saved = { k: process.env.RESEND_API_KEY, f: process.env.MAIL_FROM };
  delete process.env.RESEND_API_KEY;
  delete process.env.MAIL_FROM;
  const logged = [];
  const orig = console.log;
  console.log = (...a) => logged.push(a.join(' '));
  try {
    const r = await sendMail({ to: 'a@test.dev', subject: 'Recover', text: 'secret-token-xyz' });
    assert.deepEqual(r, { skipped: true });
  } finally {
    console.log = orig;
    if (saved.k !== undefined) process.env.RESEND_API_KEY = saved.k;
    if (saved.f !== undefined) process.env.MAIL_FROM = saved.f;
  }
  assert.equal(logged.length, 1);
  const evt = JSON.parse(logged[0]);
  assert.equal(evt.evt, 'mail_skipped');
  assert.equal(evt.subject, 'Recover');
  assert.ok(!logged[0].includes('secret-token-xyz'));
});

test('legal, machine-readable and guide pages are served', async () => {
  for (const p of ['/terms', '/privacy', '/refunds', '/security', '/llms.txt', '/docs', '/', '/guides/', '/guides/invoice-pdf-api', '/assets/site.js', '/assets/og.png']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    await res.arrayBuffer();
  }
  const og = await fetch(`${base}/assets/og.png`);
  assert.match(og.headers.get('content-type'), /image\/png/);
  const sig = Buffer.from(await og.arrayBuffer()).subarray(1, 4).toString();
  assert.equal(sig, 'PNG');
  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.match(String(spec.openapi), /^3\./);
  assert.ok(spec.paths['/v1/render'], 'openapi documents /v1/render');
});

test('sitemap lists finished pages only, legal pages at their top-level path', async () => {
  const xml = await (await fetch(`${base}/sitemap.xml`)).text();
  const dir = path.join(__dirname, '..', 'public', 'guides');
  const slugs = fs.readdirSync(dir).filter((n) => n.endsWith('.html') && n !== 'index.html').map((n) => n.slice(0, -5));
  for (const s of slugs) {
    const draft = fs.readFileSync(path.join(dir, `${s}.html`), 'utf8').includes('[TODO');
    const legal = ['terms', 'privacy', 'refunds', 'security'].includes(s);
    assert.ok(!xml.includes(`/guides/${s}<`) || (!legal && !draft), `${s} listed wrongly`);
    if (legal) assert.equal(xml.includes(`/${s}</loc>`), !draft, s);
    else assert.equal(xml.includes(`/guides/${s}</loc>`), !draft, s);
  }
  for (const s of ['pdfmonkey-alternative', 'apitemplate-alternative', 'pdfshift-alternative']) {
    assert.ok(!xml.includes(`/guides/${s}<`), `${s} must stay out of the sitemap until verified`);
  }
});

test('pages are served with the real origin and absolute og:image', async () => {
  for (const p of ['/', '/docs', '/guides/', '/guides/invoice-pdf-api', '/privacy', '/llms.txt']) {
    const body = await (await fetch(base + p)).text();
    assert.ok(!body.includes('YOUR-DOMAIN'), p);
    assert.ok(!body.includes('content="/assets/og.png"'), p);
  }
  const landing = await (await fetch(`${base}/`)).text();
  assert.match(landing, /<meta property="og:image" content="http:\/\/[^"]+\/assets\/og\.png">/);
  assert.doesNotMatch(landing, /noindex/);
});

test('draft pages are noindex and legal drafts show a visible note', async () => {
  const draftLegal = unfinishedLegalPages();
  for (const n of draftLegal) {
    const html = await (await fetch(`${base}/${n}`)).text();
    assert.match(html, /<meta name="robots" content="noindex">/, n);
    assert.match(html, /Draft, not yet reviewed/, n);
  }
  const alt = await (await fetch(`${base}/guides/pdfmonkey-alternative`)).text();
  assert.match(alt, /noindex/);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docforge-legal-'));
  fs.writeFileSync(path.join(dir, 'terms.html'), '<p>[TODO: legal name]</p>');
  fs.writeFileSync(path.join(dir, 'privacy.html'), '<p>done</p>');
  assert.deepEqual(unfinishedLegalPages(dir), ['terms']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('maskEmail keeps only the first letter and the domain', () => {
  assert.equal(maskEmail('alice@example.com'), 'a***@example.com');
  assert.equal(maskEmail('nope'), '***');
});

test('key recovery sends at most one mail per account per cooldown', async () => {
  await signup('flood@test.dev');
  const before = mails.length;
  for (let i = 0; i < 3; i++) {
    const r = await json('POST', '/v1/keys/recover', { email: 'flood@test.dev' });
    assert.equal(r.status, 202);
  }
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(mails.slice(before).filter((m) => m.to === 'flood@test.dev').length, 1);
});

test('demo flags sample data whenever user data was substituted', async () => {
  for (const data of [5, '5', 'x'.repeat(10), { big: 'y'.repeat(25000) }]) {
    const res = await json('POST', '/v1/demo/render', { template_id: 'gallery:invoice', data });
    if (res.status === 400) { await res.arrayBuffer(); continue; } // e.g. an unparseable string
    assert.equal(res.status, 200, JSON.stringify(data).slice(0, 30));
    assert.equal(res.headers.get('x-docforge-sample-data'), 'true', JSON.stringify(data).slice(0, 30));
    await res.arrayBuffer();
  }
  const own = await json('POST', '/v1/demo/render', { template_id: 'gallery:invoice', data: { number: 'X-1' } });
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('x-docforge-sample-data'), null);
  await own.arrayBuffer();
});

test('deleteAccount removes the account and its rows', async () => {
  const { api_key: key } = await signup('gone@test.dev');
  const t = await json('POST', '/v1/templates', { name: 't', html: '<p>{{x}}</p>' }, key);
  assert.equal(t.status, 201);
  const acc = store.accountByEmail('gone@test.dev');
  store.createRecoveryToken(acc.id);
  assert.equal(store.deleteAccount(acc.id), true);
  assert.equal(store.accountByEmail('gone@test.dev'), undefined);
  for (const tbl of ['templates', 'usage', 'recovery_tokens']) {
    assert.equal(store.db.prepare(`SELECT COUNT(*) AS n FROM ${tbl} WHERE account_id = ?`).get(acc.id).n, 0, tbl);
  }
  assert.equal((await json('GET', '/v1/me', undefined, key)).status, 401);
});

test('docs page keeps the anchors other pages link to', async () => {
  const html = await (await fetch(`${base}/docs`)).text();
  for (const id of ['remote-assets', 'security', 'no-code']) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.match(html, /<script[^>]+src="\/assets\/site\.js"[^>]*defer/);
  const landing = await (await fetch(`${base}/`)).text();
  assert.match(landing, /\/assets\/site\.js/);
  assert.match(landing, /id="recoverForm"/);
});

test('unknown hosted file tokens return 404', async () => {
  assert.equal((await fetch(`${base}/f/not-a-token/x.pdf`)).status, 404);
  assert.equal((await fetch(`${base}/f/${'a'.repeat(32)}/x.pdf`)).status, 404);
});

test('successful renders carry quota headers and a .pdf filename', async () => {
  const { api_key: key } = await signup('headers@test.dev');
  const res = await json('POST', '/v1/render', { html: '<p>x</p>', filename: 'invoice 42' }, key);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-renders-limit'), '100');
  assert.equal(res.headers.get('x-renders-remaining'), '99');
  assert.equal(res.headers.get('x-quota-warning'), null);
  assert.equal(res.headers.get('x-docforge-sample-data'), null);
  assert.match(res.headers.get('content-disposition'), /filename="invoice_42\.pdf"/);
  const b64 = await (await json('POST', '/v1/render', { html: '<p>x</p>', filename: 'a.pdf', output: 'base64' }, key)).json();
  assert.equal(b64.filename, 'a.pdf');
  assert.equal(b64.warnings, undefined);
});

test('blocked assets surface as headers and JSON warnings', async () => {
  const { api_key: key } = await signup('blocked@test.dev');
  const withBlocked = () => {
    const buf = Buffer.from('%PDF-1.4 stub');
    Object.defineProperty(buf, 'blockedAssets', { value: ['http://169.254.169.254/latest', 'http://10.0.0.1/x.png'] });
    return Promise.resolve(buf);
  };
  stub.next = withBlocked;
  const bin = await json('POST', '/v1/render', { html: '<img src="http://10.0.0.1/x.png">' }, key);
  assert.equal(bin.status, 200);
  assert.equal(bin.headers.get('x-docforge-blocked-assets'), '2');
  assert.equal(bin.headers.get('x-docforge-blocked-asset-example'), 'http://169.254.169.254/latest');
  stub.next = withBlocked;
  const body = await (await json('POST', '/v1/render', { html: '<p>x</p>', output: 'base64' }, key)).json();
  assert.deepEqual(body.warnings, { blocked_assets: ['http://169.254.169.254/latest', 'http://10.0.0.1/x.png'] });
  stub.next = withBlocked;
  const url = await (await json('POST', '/v1/render', { html: '<p>x</p>', output: 'url' }, key)).json();
  assert.equal(url.warnings.blocked_assets.length, 2);
});

test('raw is only honoured for inline html; template ids always compile', async () => {
  const { api_key: key } = await signup('raw@test.dev');
  stub.calls.length = 0;
  await json('POST', '/v1/render', { html: '<p>{{x}}</p>', raw: true }, key);
  await json('POST', '/v1/render', { template_id: 'gallery:receipt', raw: true }, key);
  assert.equal(stub.calls[0].raw, true);
  assert.equal(stub.calls[1].raw, false);
  assert.equal(stub.calls[1].watermark, true, 'free plan gets the normal stamp, not the demo one');
});

test('signup source is trimmed and capped at 100 chars', async () => {
  await signup('src1@test.dev', { source: '  hn  ' });
  await signup('src2@test.dev', { source: 'x'.repeat(250) });
  await signup('src3@test.dev', { source: '   ' });
  const row = (e) => store.db.prepare('SELECT source FROM accounts WHERE email = ?').get(e).source;
  assert.equal(row('src1@test.dev'), 'hn');
  assert.equal(row('src2@test.dev').length, 100);
  assert.equal(row('src3@test.dev'), null);
});

test('key rotation revokes the old key and sends a notice', async () => {
  const { api_key: key } = await signup('rotate@test.dev');
  mails.length = 0;
  const res = await json('POST', '/v1/keys/rotate', undefined, key);
  assert.equal(res.status, 200);
  const { api_key: fresh } = await res.json();
  assert.notEqual(fresh, key);
  assert.equal((await json('GET', '/v1/me', undefined, key)).status, 401);
  assert.equal((await json('GET', '/v1/me', undefined, fresh)).status, 200);
  await new Promise((r) => setImmediate(r));
  const notice = mails.find((m) => m.to === 'rotate@test.dev');
  assert.ok(notice, 'rotation mail sent');
  assert.ok(!notice.text.includes(fresh), 'mail never contains the new key');
});

test('demo returns 503 busy when the renderer queue is long', async () => {
  stub.queueLength = 11;
  try {
    const res = await json('POST', '/v1/demo/render', { template_id: 'gallery:certificate', data: { name: 'Q' } });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'busy');
    assert.equal(res.headers.get('retry-after'), '5');
  } finally {
    stub.queueLength = 0;
  }
});

test('healthz never launches the renderer and reports db + renderer state', async () => {
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.deepEqual(Object.keys(body).sort(), ['db', 'ok', 'renderer']);
  assert.equal(body.db, true);
  assert.equal(body.renderer.connected, true);
});
