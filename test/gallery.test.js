const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildHtml } = require('../src/render');
const { GALLERY, getGalleryTemplate } = require('../gallery');

const build = (tpl, data) => buildHtml({ html: tpl.html, css: tpl.css, data });
const body = (doc) => doc.slice(doc.indexOf('<body>'));

test('gallery ids are stable', () => {
  assert.deepEqual(GALLERY.map((t) => t.id), ['gallery:invoice', 'gallery:receipt', 'gallery:certificate', 'gallery:quote', 'gallery:packing-slip']);
  for (const t of GALLERY) assert.equal(getGalleryTemplate(t.id), t);
});

for (const tpl of GALLERY) {
  test(`${tpl.id} renders its sample data cleanly`, () => {
    const doc = build(tpl, tpl.sampleData);
    assert.doesNotMatch(doc, />\s*(true|false)\s*</, 'boolean leaked into output');
    assert.doesNotMatch(doc, /NaN/);
    assert.doesNotMatch(doc, /\[object Object\]/);
    assert.doesNotMatch(doc, /undefined/);
    assert.doesNotMatch(doc, /padding:\s*40px 48px/);
    assert.ok(tpl.options && tpl.options.margin, 'every gallery template sets an explicit margin');
  });
}

test('receipt prints quantities and minor-unit amounts', () => {
  const tpl = getGalleryTemplate('gallery:receipt');
  const doc = body(build(tpl, tpl.sampleData));
  assert.match(doc, /Extra seats × 3/);
  assert.doesNotMatch(doc, /Pro plan \(monthly\) ×/);
  assert.match(doc, /\$24\.00/);
  assert.match(doc, /\$12\.00/);
  assert.match(doc, /jane@example\.com/);
});

test('invoice: shipping, tax_lines and supplied total', () => {
  const tpl = getGalleryTemplate('gallery:invoice');
  const data = {
    ...tpl.sampleData,
    items: [{ description: 'Plan', qty: 2, price: 100 }],
    discount: 0,
    shipping: 15,
    tax_lines: [{ name: 'GST', rate: 5, amount: 10 }, { name: 'QST', rate: 9.975, amount: 19.95 }],
  };
  const calc = body(build(tpl, data));
  assert.match(calc, /Shipping<\/td><td class="r">\$15\.00/);
  assert.match(calc, /GST \(5%\)/);
  assert.match(calc, /QST \(9\.975%\)/);
  assert.doesNotMatch(calc, /Tax \(8%\)/, 'tax_lines replace the tax_rate row');
  assert.match(calc, /Total due<\/td><td class="r">\$244\.95</);

  const supplied = body(build(tpl, { ...data, total: 250.5 }));
  assert.match(supplied, /Total due<\/td><td class="r">\$250\.50</);

  const zero = body(build(tpl, { ...data, total: 0 }));
  assert.match(zero, /Total due<\/td><td class="r">\$0\.00</);

  const sample = body(build(tpl, tpl.sampleData));
  // (2400 + 180 + 360 - 100) * 1.08
  assert.match(sample, /Total due<\/td><td class="r">\$3,067\.20</);
  assert.match(sample, /Tax \(8%\)/);
});

test('invoice and quote ship a page-number footer; certificate stays full-bleed', () => {
  for (const id of ['gallery:invoice', 'gallery:quote']) {
    const { options } = getGalleryTemplate(id);
    assert.match(options.footer_html, /pageNumber/);
    assert.match(options.footer_html, /totalPages/);
    assert.equal(options.margin.bottom, '18mm');
  }
  const cert = getGalleryTemplate('gallery:certificate');
  assert.deepEqual(cert.options.margin, { top: '0', right: '0', bottom: '0', left: '0' });
  const doc = build(cert, cert.sampleData);
  assert.match(doc, /<svg[^>]*width="72"/);
  assert.match(doc, /class="logo" src="data:image\/svg\+xml/);
});

test('packing slip prints the optional address lines', () => {
  const tpl = getGalleryTemplate('gallery:packing-slip');
  const doc = body(build(tpl, tpl.sampleData));
  assert.match(doc, /Apartment 3B/);
  assert.match(doc, /Karachi, Sindh 75600/);
  const minimal = body(build(tpl, { ...tpl.sampleData, ship_to: { name: 'A', line1: 'B', city: 'C', country: 'D' } }));
  assert.match(minimal, /B<br>C<br>D/);
});
