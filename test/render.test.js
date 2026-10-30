const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { PDFDocument } = require('pdf-lib');
const { Renderer, buildHtml, isPrivateIp, FORMATS } = require('../src/render');

let renderer;
before(() => { renderer = new Renderer({ maxConcurrent: 2, publicUrl: 'https://docforge.test' }); });
after(async () => { await renderer.close(); });

const isPdf = (buf) => Buffer.isBuffer(buf) && buf.subarray(0, 5).toString() === '%PDF-';
const rejectsCode = (p, codes) => assert.rejects(p, (e) => {
  assert.ok([].concat(codes).includes(e.code), `unexpected code ${e.code}: ${e.message}`);
  return true;
});

test('free renders are stamped with pdf-lib; paid renders are untouched', async () => {
  const free = await renderer.pdf({ html: '<html><head></head><p>x</p></html>', css: 'div{display:none!important}', watermark: true });
  assert.ok(isPdf(free));
  const doc = await PDFDocument.load(free, { updateMetadata: false });
  assert.equal(doc.getProducer(), 'DocForge free');
  assert.match(free.toString('latin1'), /docforge\.test\/\?ref=pdf/);

  const paid = await renderer.pdf({ html: '<p>x</p>', watermark: false });
  assert.notEqual((await PDFDocument.load(paid, { updateMetadata: false })).getProducer(), 'DocForge free');
  assert.doesNotMatch(paid.toString('latin1'), /ref=pdf/);
  assert.deepEqual(Object.keys(paid).includes('blockedAssets'), false);
  assert.deepEqual(paid.blockedAssets, []);
});

test('demo watermark renders and links ?ref=demo', async () => {
  const pdf = await renderer.pdf({ html: '<p>demo</p>', watermark: 'demo' });
  assert.ok(isPdf(pdf));
  assert.match(pdf.toString('latin1'), /\?ref=demo/);
});

test('template bombs are cut off with TEMPLATE_TOO_EXPENSIVE', async () => {
  const items = Array.from({ length: 1000 }, (_, i) => i);
  const t0 = Date.now();
  await rejectsCode(renderer.pdf({
    html: '{{#each items}}{{#each ../items}}{{#each ../../items}}x{{/each}}{{/each}}{{/each}}',
    data: { items },
  }), 'TEMPLATE_TOO_EXPENSIVE');
  assert.ok(Date.now() - t0 < 5000);
});

test('handlebars errors carry TEMPLATE_ERROR', async () => {
  await rejectsCode(renderer.pdf({ html: '{{#if}}' }), 'TEMPLATE_ERROR');
});

test('a full queue rejects with BUSY', async () => {
  const r = new Renderer({ maxConcurrent: 1, maxQueue: 1, queueTimeoutMs: 60000, publicUrl: 'https://docforge.test' });
  try {
    const first = r.pdf({ html: '<p>1</p>' });
    const second = r.pdf({ html: '<p>2</p>' });
    assert.equal(r.queueLength, 1);
    await rejectsCode(r.pdf({ html: '<p>3</p>' }), 'BUSY');
    await Promise.all([first, second]);
    assert.equal(r.status().active, 0);
    assert.equal(r.status().queued, 0);
  } finally {
    await r.close();
  }
});

test('queue wait timeout rejects with BUSY and does not leak a slot', async () => {
  const r = new Renderer({ maxConcurrent: 1, maxQueue: 5, queueTimeoutMs: 1, publicUrl: 'https://docforge.test' });
  try {
    const first = r.pdf({ html: '<p>1</p>' });
    await rejectsCode(r.pdf({ html: '<p>2</p>' }), 'BUSY');
    await first;
    assert.equal(r.queueLength, 0);
    assert.equal(r.status().active, 0);
    assert.ok(isPdf(await r.pdf({ html: '<p>3</p>' })));
    assert.equal(r.status().connected, true);
  } finally {
    await r.close();
  }
});

test('pathological documents hit the deadline or the page cap', async () => {
  const r = new Renderer({ maxConcurrent: 1, deadlineMs: 2000, publicUrl: 'https://docforge.test' });
  try {
    const html = '<div style="break-after:page">x</div>'.repeat(20000);
    await rejectsCode(r.pdf({ html, raw: true, maxPages: 20 }), ['RENDER_TIMEOUT', 'TOO_MANY_PAGES']);
  } finally {
    await r.close();
  }
});

test('iframes and non-asset requests are blocked and reported', async () => {
  const html = '<iframe src="https://example.com"></iframe><img src="http://127.0.0.1:1/x.png">';
  assert.match(buildHtml({ html }), /Content-Security-Policy" content="frame-src 'none'; object-src 'none'; child-src 'none'"/);
  const pdf = await renderer.pdf({ html });
  assert.ok(pdf.blockedAssets.some((u) => u.startsWith('https://example.com')), JSON.stringify(pdf.blockedAssets));
  assert.ok(pdf.blockedAssets.some((u) => u.startsWith('http://127.0.0.1')));
});

test('isPrivateIp covers link/site-local, benchmarking and embedded IPv4', () => {
  for (const ip of ['fe80::1', 'febf::1', 'fec0::1', 'fef0::1', '198.18.0.1', '198.19.255.255', '64:ff9b::a00:1',
    '64:ff9b::127.0.0.1', '2002:a9fe:a9fe::1', '2002:7f00:1::', '::ffff:10.0.0.1', '::ffff:a00:1', '::1', '::', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '198.20.0.1', '2606:4700::1111', '64:ff9b::808:808', '2002:808:808::1']) {
    assert.equal(isPrivateIp(ip), false, ip);
  }
});

test('helpers: sum, money, date, qr', () => {
  const out = (html, data = {}) => buildHtml({ html: `<i>${html}</i>`, data }).match(/<i>([\s\S]*)<\/i>/)[1];
  assert.equal(out('{{sum items "price" "qty"}}', { items: [{ price: 12 }, { price: 4, qty: 3 }] }), '24');
  assert.equal(out('{{money "1,234.50" "usd"}}'), '$1,234.50');
  assert.equal(out('{{date "2026-10-30" "medium" "en-GB"}}'), '30 Oct 2026');
  assert.equal(out('{{date d locale="en-GB" tz="UTC"}}', { d: 1793318400 }), '30 Oct 2026');
  assert.equal(out('{{date missing}}'), '');
  assert.match(out('{{qr "https://docforge.test" size=1000}}'), /^<svg[^>]*width="400"/);
});

test('footer_html with page numbers renders', async () => {
  const pdf = await renderer.pdf({
    html: '<p>{{name}}</p>',
    data: { name: 'Ali' },
    options: { footer_html: '<div style="font-size:8px">{{name}} <span class="pageNumber"></span>/<span class="totalPages"></span></div>' },
  });
  assert.ok(isPdf(pdf));
  await rejectsCode(renderer.pdf({ html: '<p>x</p>', options: { footer_html: 'x'.repeat(17 * 1024) } }), 'INVALID_OPTION');
});

test('raw skips handlebars; css is not html-escaped', () => {
  assert.match(buildHtml({ html: '<p>{{x}}</p>', raw: true, data: { x: 1 } }), /<p>\{\{x\}\}<\/p>/);
  const doc = buildHtml({ html: '<p>x</p>', css: 'body{font-family:{{font}} }', data: { font: '"Inter", sans-serif' } });
  assert.match(doc, /font-family:"Inter", sans-serif/);
  assert.doesNotMatch(buildHtml({ html: '<p>x</p>', css: '{{x}}', data: { x: '</style><script>' } }), /<\/style><script>/);
});

test('full documents get css and base injected in the head', () => {
  const doc = buildHtml({ html: '<html lang="en"><head><title>t</title></head><body>x</body></html>', css: 'p{}', baseUrl: 'https://cdn.example/a"b/' });
  assert.match(doc, /<head><meta http-equiv="Content-Security-Policy"[^>]*><base href="https:\/\/cdn\.example\/a&quot;b\/"><title>t<\/title><style>p\{\}<\/style><\/head>/);
  assert.match(buildHtml({ html: '<html><body>$&x</body></html>', css: 'a{}' }), /^<html><meta[^>]*><style>a\{\}<\/style><body>\$&x/);
});

test('formats: letter works, unknown format is INVALID_OPTION', async () => {
  assert.equal(FORMATS.letter, 'Letter');
  const pdf = await renderer.pdf({ html: '<p>x</p>', options: { format: 'LETTER' } });
  const [page] = (await PDFDocument.load(pdf)).getPages();
  assert.equal(Math.round(page.getWidth()), 612);
  await rejectsCode(renderer.pdf({ html: '<p>x</p>', options: { format: 'foo' } }), 'INVALID_OPTION');
});

test('remote assets: redirects to disallowed URLs are not followed', async () => {
  const http = require('node:http');
  const hits = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url === '/r') { res.writeHead(302, { location: '/secret.png' }); return res.end(); }
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  // Pretend only the first hop is public; the redirect target stays forbidden.
  const r = new Renderer({ maxConcurrent: 1, urlAllowed: async (u) => u === `${base}/r` || u === `${base}/ok.png` });
  try {
    const pdf = await r.pdf({ html: `<img src="${base}/r"><img src="${base}/ok.png">` });
    assert.ok(isPdf(pdf));
    assert.ok(!hits.includes('/secret.png'), JSON.stringify(hits));
    assert.ok(hits.includes('/r') && hits.includes('/ok.png'), JSON.stringify(hits));
    assert.ok(pdf.blockedAssets.includes(`${base}/secret.png`), JSON.stringify(pdf.blockedAssets));
    assert.ok(!pdf.blockedAssets.includes(`${base}/ok.png`));
  } finally {
    await r.close();
    srv.close();
  }
});
