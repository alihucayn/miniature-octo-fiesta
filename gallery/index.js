// Built-in starter templates. Customers render them directly with
// {"template_id": "gallery:invoice"} or copy them into their account to edit.
const base = `
  * { box-sizing: border-box; }
  body { font-family: "Helvetica Neue", Arial, sans-serif; color: #1f2937; font-size: 12px; margin: 0; padding: 40px 48px; }
  h1 { font-size: 28px; margin: 0; letter-spacing: -0.5px; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #6b7280; border-bottom: 2px solid #e5e7eb; padding: 8px 6px; }
  td { padding: 10px 6px; border-bottom: 1px solid #f3f4f6; vertical-align: top; }
  .r { text-align: right; }
  .muted { color: #6b7280; }
  .row { display: flex; justify-content: space-between; gap: 24px; }
  .totals { margin-left: auto; width: 260px; margin-top: 16px; }
  .totals td { border: 0; padding: 4px 6px; }
  .totals .grand td { font-size: 15px; font-weight: 700; border-top: 2px solid #111827; padding-top: 10px; }
  .brand { color: {{default accent_color "#4f46e5"}}; }
`;

const invoice = {
  id: 'gallery:invoice',
  name: 'Invoice',
  description: 'Classic invoice with line items, tax, discount and payment details.',
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
    <div style="margin-top:8px">Issued: {{date issue_date}}<br>Due: <strong>{{date due_date}}</strong></div>
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
    <tr><td>{{description}}</td><td class="r">{{qty}}</td><td class="r">{{money price ../currency}}</td><td class="r">{{money (mul qty price) ../currency}}</td></tr>
  {{/each}}
  </tbody>
</table>
<table class="totals">
  <tr><td>Subtotal</td><td class="r">{{money (sum items "qty" "price") currency}}</td></tr>
  {{#if discount}}<tr><td>Discount</td><td class="r">-{{money discount currency}}</td></tr>{{/if}}
  {{#if tax_rate}}<tr><td>Tax ({{tax_rate}}%)</td><td class="r">{{money (percent (sub (sum items "qty" "price") discount) tax_rate) currency}}</td></tr>{{/if}}
  <tr class="grand"><td>Total due</td><td class="r">{{money (add (sub (sum items "qty" "price") discount) (percent (sub (sum items "qty" "price") discount) tax_rate)) currency}}</td></tr>
</table>
{{#if notes}}<div style="margin-top:40px"><strong>Notes</strong><div class="muted">{{notes}}</div></div>{{/if}}
{{#if payment_instructions}}<div style="margin-top:16px"><strong>Payment</strong><div class="muted">{{payment_instructions}}</div></div>{{/if}}
`,
  sampleData: {
    number: 'INV-2026-0042',
    issue_date: '2026-10-01',
    due_date: '2026-10-31',
    currency: 'USD',
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
};

const receipt = {
  id: 'gallery:receipt',
  name: 'Receipt',
  description: 'Compact payment receipt for e-commerce orders and subscriptions.',
  css: `${base} body { padding: 32px; } .box { max-width: 420px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 10px; padding: 28px; } .paid { display:inline-block; background:#dcfce7; color:#166534; border-radius:999px; padding:3px 10px; font-weight:700; font-size:10px; }`,
  html: `
<div class="box">
  <div class="row"><h1 class="brand" style="font-size:20px">{{merchant}}</h1><span class="paid">PAID</span></div>
  <p class="muted">Receipt {{number}} · {{date paid_at "long"}}</p>
  <table>
    {{#each items}}<tr><td>{{name}}{{#gt qty 1}} × {{qty}}{{/gt}}</td><td class="r">{{money (mul price (default qty 1)) ../currency}}</td></tr>{{/each}}
  </table>
  <table class="totals" style="width:100%">
    <tr class="grand"><td>Total</td><td class="r">{{money (sum items "price" "qty") currency}}</td></tr>
  </table>
  <p class="muted" style="margin-top:20px">Paid with {{payment_method}}. Questions? {{support_email}}</p>
</div>`,
  sampleData: {
    merchant: 'Bookly',
    number: 'R-88213',
    paid_at: '2026-10-29T10:12:00Z',
    currency: 'USD',
    items: [
      { name: 'Pro plan (monthly)', qty: 1, price: 12 },
      { name: 'Extra seats', qty: 3, price: 4 },
    ],
    payment_method: 'Visa •••• 4242',
    support_email: 'help@bookly.app',
  },
};

const certificate = {
  id: 'gallery:certificate',
  name: 'Certificate of completion',
  description: 'Landscape certificate for courses, workshops and events. Render with {"landscape": true}.',
  css: `
  @page { size: A4 landscape; margin: 0; }
  body { margin: 0; font-family: Georgia, "Times New Roman", serif; color: #1f2937; }
  .frame { position: absolute; inset: 14mm; border: 3px double {{default accent_color "#b45309"}}; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 20mm; }
  .kicker { letter-spacing: .3em; text-transform: uppercase; font-size: 13px; color: #6b7280; }
  .name { font-size: 46px; margin: 18px 0 8px; color: {{default accent_color "#b45309"}}; font-style: italic; }
  .course { font-size: 22px; margin: 6px 0 30px; }
  .sig { display: flex; gap: 120px; margin-top: 40px; font-family: Arial, sans-serif; font-size: 12px; }
  .sig div { border-top: 1px solid #9ca3af; padding-top: 6px; min-width: 180px; }
  `,
  html: `
<div class="frame">
  <div class="kicker">Certificate of completion</div>
  <div style="margin-top:18px">This certifies that</div>
  <div class="name">{{recipient}}</div>
  <div>has successfully completed</div>
  <div class="course"><strong>{{course}}</strong>{{#if hours}} · {{hours}} hours{{/if}}</div>
  <div class="muted">Awarded {{date date "long"}} · ID {{certificate_id}}</div>
  <div class="sig"><div>{{instructor}}<br><span class="muted">Instructor</span></div><div>{{organization}}<br><span class="muted">Issuer</span></div></div>
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
  },
  options: { landscape: true, preferCSSPageSize: true },
};

const quote = {
  id: 'gallery:quote',
  name: 'Quote / estimate',
  description: 'Sales quote with validity date and acceptance signature block.',
  css: base,
  html: `
<div class="row">
  <div><h1 class="brand">{{company.name}}</h1><div class="muted">{{company.email}}</div></div>
  <div class="r"><h1>QUOTE</h1><div class="muted"># {{number}}</div><div>Valid until {{date valid_until}}</div></div>
</div>
<p style="margin:28px 0">Prepared for <strong>{{client.name}}</strong>{{#if project}} — {{project}}{{/if}}</p>
<table>
  <thead><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Total</th></tr></thead>
  <tbody>{{#each items}}<tr><td><strong>{{name}}</strong><div class="muted">{{details}}</div></td><td class="r">{{qty}}</td><td class="r">{{money rate ../currency}}</td><td class="r">{{money (mul qty rate) ../currency}}</td></tr>{{/each}}</tbody>
</table>
<table class="totals"><tr class="grand"><td>Estimated total</td><td class="r">{{money (sum items "qty" "rate") currency}}</td></tr></table>
<div class="row" style="margin-top:60px">
  <div style="flex:1;border-top:1px solid #9ca3af;padding-top:6px">Accepted by (signature)</div>
  <div style="flex:1;border-top:1px solid #9ca3af;padding-top:6px">Date</div>
</div>`,
  sampleData: {
    number: 'Q-1007',
    valid_until: '2026-11-30',
    currency: 'EUR',
    company: { name: 'Brightline Builders', email: 'sales@brightline.eu' },
    client: { name: 'Hotel Aurora' },
    project: 'Lobby renovation',
    items: [
      { name: 'Demolition', details: 'Remove existing flooring and fixtures', qty: 1, rate: 3200 },
      { name: 'Oak flooring', details: 'Supply and install, per m²', qty: 140, rate: 62 },
    ],
  },
};

const packingSlip = {
  id: 'gallery:packing-slip',
  name: 'Packing slip',
  description: 'Warehouse packing slip with SKUs, quantities and ship-to address.',
  css: base,
  html: `
<div class="row"><h1>Packing slip</h1><div class="r">Order <strong>{{order_number}}</strong><br>{{date order_date}}</div></div>
<div class="row" style="margin:28px 0">
  <div><div class="muted">Ship to</div><strong>{{ship_to.name}}</strong><br>{{ship_to.line1}}<br>{{ship_to.city}}, {{ship_to.country}}</div>
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
    shipping_method: 'DHL Express',
    ship_to: { name: 'Sara Ahmed', line1: '44 Clifton Block 5', city: 'Karachi', country: 'Pakistan' },
    items: [
      { sku: 'TS-BLK-M', name: 'Organic T-shirt, black, M', qty: 2 },
      { sku: 'MUG-01', name: 'Ceramic mug', qty: 1 },
    ],
  },
};

const GALLERY = [invoice, receipt, certificate, quote, packingSlip];
const byId = new Map(GALLERY.map((t) => [t.id, t]));

module.exports = { GALLERY, getGalleryTemplate: (id) => byId.get(id) };
