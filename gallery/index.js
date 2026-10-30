// Built-in starter templates. Customers render them directly with
// {"template_id": "gallery:invoice"} or copy them into their account to edit.
const base = `
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1f2937; font-size: 12px; margin: 0; }
  h1 { font-size: 28px; margin: 0; letter-spacing: -0.5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 8px 6px; }
  td { padding: 10px 6px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  tr, .totals { break-inside: avoid; }
  .r { text-align: right; }
  .muted { color: #6b7280; }
  .row { display: flex; justify-content: space-between; gap: 24px; }
  .totals { margin-left: auto; width: 260px; margin-top: 16px; }
  .totals td { border: 0; padding: 4px 6px; }
  .totals .grand td { font-size: 15px; font-weight: 700; border-top: 2px solid #111827; padding-top: 10px; }
  .brand { color: {{default accent_color "#4f46e5"}}; }
`;

// Page margins replace the old body padding so multi-page documents keep them on every page.
const margin = { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' };
const pageFooter = '<div style="font-size:9px;width:100%;text-align:center;color:#6b7280">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>';

const invoice = {
  id: 'gallery:invoice',
  name: 'Invoice',
  description: 'Invoice with line items, discount, shipping, one tax rate or several tax lines, and page numbers. Pass "total" to print your billing system\'s figure.',
  css: base,
  html: `
<div class="row">
  <div>
    {{#if company.logo_url}}<img src="{{company.logo_url}}" style="height:40px;margin-bottom:12px">{{/if}}
    <h1 class="brand">{{company.name}}</h1>
    <div class="muted">{{company.address}}<br>{{company.email}}</div>
  </div>
  <div class="r">
    <h1>INVOICE</h1>
    <div class="muted"># {{number}}</div>
    <div style="margin-top:8px">Issued: {{date issue_date "medium" locale}}<br>Due: <strong>{{date due_date "medium" locale}}</strong></div>
  </div>
</div>
<div style="margin:32px 0 20px">
  <div class="muted" style="font-size:10px;text-transform:uppercase;letter-spacing:.06em">Bill to</div>
  <strong>{{client.name}}</strong><br>{{client.address}}<br>{{client.email}}
</div>
<table>
  <thead><tr><th>Description</th><th class="r">Qty</th><th class="r">Unit price</th><th class="r">Amount</th></tr></thead>
  <tbody>
  {{#each items}}
    <tr><td>{{description}}</td><td class="r">{{qty}}</td><td class="r">{{money price ../currency ../locale}}</td><td class="r">{{money (mul qty price) ../currency ../locale}}</td></tr>
  {{/each}}
  </tbody>
</table>
<div style="break-inside:avoid">
<table class="totals">
  <tr><td>Subtotal</td><td class="r">{{money (sum items "qty" "price") currency locale}}</td></tr>
  {{#if discount}}<tr><td>Discount</td><td class="r">-{{money discount currency locale}}</td></tr>{{/if}}
  {{#if shipping}}<tr><td>Shipping</td><td class="r">{{money shipping currency locale}}</td></tr>{{/if}}
  {{#if tax_lines}}
    {{#each tax_lines}}<tr><td>{{name}}{{#if rate}} ({{rate}}%){{/if}}</td><td class="r">{{money amount ../currency ../locale}}</td></tr>{{/each}}
  {{else if tax_rate}}<tr><td>Tax ({{tax_rate}}%)</td><td class="r">{{money (percent (sub (sum items "qty" "price") discount) tax_rate) currency locale}}</td></tr>{{/if}}
  <tr class="grand"><td>Total due</td><td class="r">
    {{~#if total}}{{money total currency locale}}
    {{~else if (eq total 0)}}{{money 0 currency locale}}
    {{~else if tax_lines}}{{money (add (sub (sum items "qty" "price") discount) shipping (sum tax_lines "amount")) currency locale}}
    {{~else}}{{money (add (sub (sum items "qty" "price") discount) shipping (percent (sub (sum items "qty" "price") discount) tax_rate)) currency locale}}
    {{~/if~}}
  </td></tr>
</table>
{{#if notes}}<div style="margin-top:40px"><strong>Notes</strong><div class="muted">{{notes}}</div></div>{{/if}}
{{#if payment_instructions}}<div style="margin-top:16px"><strong>Payment</strong><div class="muted">{{payment_instructions}}</div></div>{{/if}}
</div>
`,
  sampleData: {
    number: 'INV-2026-0042',
    issue_date: '2026-10-01',
    due_date: '2026-10-31',
    currency: 'USD',
    locale: 'en-US',
    accent_color: '#4f46e5',
    company: { name: 'Acme Studio', address: '12 Market St, Lahore', email: 'billing@acme.studio' },
    client: { name: 'Globex Corp', address: '500 Fifth Ave, New York, NY', email: 'ap@globex.com' },
    items: [
      { description: 'Website redesign', qty: 1, price: 2400 },
      { description: 'Hosting (12 months)', qty: 12, price: 15 },
      { description: 'Support hours', qty: 6, price: 60 },
    ],
    discount: 100,
    tax_rate: 8,
    notes: 'Thank you for your business!',
    payment_instructions: 'Wire to IBAN PK00 ACME 0000 1234 5678 or pay online at acme.studio/pay',
  },
  options: { margin: { ...margin, bottom: '18mm' }, footer_html: pageFooter },
};

// Field names follow Stripe's invoice/charge objects: amounts are in minor units (cents),
// currency is lower-case. Zero-decimal currencies (JPY, KRW) need amounts pre-divided.
const receipt = {
  id: 'gallery:receipt',
  name: 'Receipt',
  description: 'Compact payment receipt. Accepts Stripe-style data: amount_paid and line amounts in minor units (cents).',
  css: `${base} .box { max-width: 420px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 10px; padding: 28px; } .paid { display:inline-block; background:#dcfce7; color:#166534; border-radius:999px; padding:3px 10px; font-weight:700; font-size:10px; }`,
  html: `
<div class="box">
  {{#if logo_url}}<img src="{{logo_url}}" style="height:32px;margin-bottom:12px">{{/if}}
  <div class="row"><h1 class="brand" style="font-size:20px">{{merchant}}</h1><span class="paid">PAID</span></div>
  <p class="muted">Receipt {{number}} · {{date paid_at "long" locale}}{{#if customer_email}}<br>Billed to {{customer_email}}{{/if}}</p>
  <table>
    {{#each lines}}<tr><td>{{description}}{{#if (gt quantity 1)}} × {{quantity}}{{/if}}</td><td class="r">{{money (div amount 100) ../currency ../locale}}</td></tr>{{/each}}
  </table>
  <table class="totals" style="width:100%">
    <tr class="grand"><td>Amount paid</td><td class="r">{{money (div amount_paid 100) currency locale}}</td></tr>
  </table>
  <p class="muted" style="margin-top:20px">Paid with {{payment_method}}.{{#if support_email}} Questions? {{support_email}}{{/if}}</p>
</div>`,
  sampleData: {
    merchant: 'Bookly',
    number: 'R-88213',
    paid_at: 1793268720,
    customer_email: 'jane@example.com',
    currency: 'usd',
    locale: 'en-US',
    amount_paid: 2400,
    lines: [
      { description: 'Pro plan (monthly)', amount: 1200, quantity: 1 },
      { description: 'Extra seats', amount: 1200, quantity: 3 },
    ],
    payment_method: 'Visa •••• 4242',
    support_email: 'help@bookly.app',
  },
  options: { margin },
};

const sampleLogo = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="none" stroke="#b45309" stroke-width="3"/><path d="M12 21l6 6 10-13" fill="none" stroke="#b45309" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>');

const certificate = {
  id: 'gallery:certificate',
  name: 'Certificate of completion',
  description: 'Landscape certificate for courses, workshops and events, with optional logo, signature images and a verification QR code.',
  css: `
  @page { size: A4 landscape; margin: 0; }
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; color: #1f2937; }
  .muted { color: #6b7280; }
  .frame { position: absolute; inset: 14mm; border: 3px double {{default accent_color "#b45309"}}; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20mm; }
  .logo { height: 48px; margin-bottom: 14px; }
  .kicker { letter-spacing: .3em; text-transform: uppercase; font-size: 13px; color: #6b7280; }
  .name { font-size: 46px; margin: 18px 0 8px; color: {{default accent_color "#b45309"}}; font-style: italic; }
  .course { font-size: 22px; margin: 6px 0 30px; }
  .sig { display: flex; gap: 120px; margin-top: 40px; font-family: Arial, sans-serif; font-size: 12px; align-items: flex-end; }
  .sig div { border-top: 1px solid #9ca3af; padding-top: 6px; min-width: 180px; }
  .sig img { display: block; height: 40px; margin: -46px auto 6px; }
  .verify { position: absolute; right: 8mm; bottom: 8mm; font-family: Arial, sans-serif; font-size: 9px; color: #6b7280; text-align: center; }
  `,
  html: `
<div class="frame">
  {{#if logo_url}}<img class="logo" src="{{logo_url}}" alt="">{{/if}}
  <div class="kicker">Certificate of completion</div>
  <div style="margin-top:18px">This certifies that</div>
  <div class="name">{{recipient}}</div>
  <div>has successfully completed</div>
  <div class="course"><strong>{{course}}</strong>{{#if hours}} · {{hours}} hours{{/if}}</div>
  <div class="muted">Awarded {{date date "long" locale}} · ID {{certificate_id}}</div>
  <div class="sig">
    <div>{{#if instructor_signature}}<img src="{{instructor_signature}}" alt="">{{/if}}{{instructor}}<br><span class="muted">Instructor</span></div>
    <div>{{#if issuer_signature}}<img src="{{issuer_signature}}" alt="">{{/if}}{{organization}}<br><span class="muted">Issuer</span></div>
  </div>
  {{#if verify_url}}<div class="verify">{{qr verify_url size=72}}<br>Scan to verify</div>{{/if}}
</div>`,
  sampleData: {
    recipient: 'Ayesha Khan',
    course: 'Practical Machine Learning',
    hours: 24,
    date: '2026-10-15',
    certificate_id: 'CERT-7F3K-21',
    instructor: 'Dr. Omar Siddiqui',
    organization: 'Northwind Academy',
    accent_color: '#b45309',
    logo_url: sampleLogo,
    verify_url: 'https://example.com/verify/CERT-7F3K-21',
  },
  options: { landscape: true, preferCSSPageSize: true, margin: { top: '0', right: '0', bottom: '0', left: '0' } },
};

const quote = {
  id: 'gallery:quote',
  name: 'Quote / estimate',
  description: 'Sales quote with validity date, acceptance signature block and page numbers.',
  css: base,
  html: `
<div class="row">
  <div><h1 class="brand">{{company.name}}</h1><div class="muted">{{company.email}}</div></div>
  <div class="r"><h1>QUOTE</h1><div class="muted"># {{number}}</div><div>Valid until {{date valid_until "medium" locale}}</div></div>
</div>
<p style="margin:28px 0">Prepared for <strong>{{client.name}}</strong>{{#if project}} — {{project}}{{/if}}</p>
<table>
  <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Total</th></tr></thead>
  <tbody>{{#each items}}<tr><td><strong>{{name}}</strong><div class="muted">{{details}}</div></td><td class="r">{{qty}}</td><td class="r">{{money rate ../currency ../locale}}</td><td class="r">{{money (mul qty rate) ../currency ../locale}}</td></tr>{{/each}}</tbody>
</table>
<div style="break-inside:avoid">
<table class="totals"><tr class="grand"><td>Estimated total</td><td class="r">{{money (sum items "qty" "rate") currency locale}}</td></tr></table>
<div class="row" style="margin-top:60px">
  <div style="flex:1;border-top:1px solid #9ca3af;padding-top:6px">Accepted by (signature)</div>
  <div style="flex:1;border-top:1px solid #9ca3af;padding-top:6px">Date</div>
</div>
</div>`,
  sampleData: {
    number: 'Q-1007',
    valid_until: '2026-11-30',
    currency: 'EUR',
    locale: 'en-IE',
    company: { name: 'Brightline Builders', email: 'sales@brightline.eu' },
    client: { name: 'Hotel Aurora' },
    project: 'Lobby renovation',
    items: [
      { name: 'Demolition', details: 'Remove existing flooring and fixtures', qty: 1, rate: 3200 },
      { name: 'Oak flooring', details: 'Supply and install, per m²', qty: 140, rate: 62 },
    ],
  },
  options: { margin: { ...margin, bottom: '18mm' }, footer_html: pageFooter },
};

// ship_to mirrors Shopify's shipping_address (line2 and province are optional).
const packingSlip = {
  id: 'gallery:packing-slip',
  name: 'Packing slip',
  description: 'Warehouse packing slip with SKUs, quantities and a Shopify-style ship-to address.',
  css: base,
  html: `
<div class="row">
  <div>{{#if logo_url}}<img src="{{logo_url}}" style="height:36px;margin-bottom:10px;display:block">{{/if}}<h1>Packing slip</h1></div>
  <div class="r">Order <strong>{{order_number}}</strong><br>{{date order_date "medium" locale}}</div>
</div>
<div class="row" style="margin:28px 0">
  <div><div class="muted">Ship to</div><strong>{{ship_to.name}}</strong><br>{{ship_to.line1}}{{#if ship_to.line2}}<br>{{ship_to.line2}}{{/if}}<br>{{ship_to.city}}{{#if ship_to.province}}, {{ship_to.province}}{{/if}}{{#if ship_to.zip}} {{ship_to.zip}}{{/if}}<br>{{ship_to.country}}</div>
  <div class="r"><div class="muted">Shipping method</div>{{shipping_method}}</div>
</div>
<table>
  <thead><tr><th>#</th><th>SKU</th><th>Product</th><th class="r">Qty</th><th class="r">Packed</th></tr></thead>
  <tbody>{{#each items}}<tr><td>{{inc @index}}</td><td>{{sku}}</td><td>{{name}}</td><td class="r">{{qty}}</td><td class="r">☐</td></tr>{{/each}}</tbody>
</table>
<p class="muted" style="margin-top:30px">Total units: {{sum items "qty"}}</p>`,
  sampleData: {
    order_number: '#10442',
    order_date: '2026-10-28',
    locale: 'en-US',
    shipping_method: 'DHL Express',
    ship_to: { name: 'Sara Ahmed', line1: '44 Clifton Block 5', line2: 'Apartment 3B', city: 'Karachi', province: 'Sindh', zip: '75600', country: 'Pakistan' },
    items: [
      { sku: 'TS-BLK-M', name: 'Organic T-shirt, black, M', qty: 2 },
      { sku: 'MUG-01', name: 'Ceramic mug', qty: 1 },
    ],
  },
  options: { margin },
};

const GALLERY = [invoice, receipt, certificate, quote, packingSlip];
const byId = new Map(GALLERY.map((t) => [t.id, t]));

module.exports = { GALLERY, getGalleryTemplate: (id) => byId.get(id) };
