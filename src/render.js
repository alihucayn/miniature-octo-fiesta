const Handlebars = require('handlebars');
const QRCode = require('qrcode');
const dns = require('node:dns').promises;
const net = require('node:net');
const { Worker, isMainThread, workerData, parentPort } = require('node:worker_threads');

const hb = Handlebars.create();

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(typeof v === 'string' ? v.replace(/[,\s]/g, '') : v);
  return Number.isFinite(n) ? n : 0;
}

// Last positional argument of a Handlebars helper is always the options hash.
const args = (list) => Array.prototype.slice.call(list, 0, -1);
const str = (v) => (typeof v === 'string' && v ? v : undefined);

function toDate(value) {
  if (value === 'now') return new Date();
  let v = value;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v);
  // Stripe & friends send unix seconds; JS timestamps are milliseconds.
  if (typeof v === 'number') return new Date(v < 1e12 ? v * 1000 : v);
  return new Date(v);
}

function qrSvg(value, size) {
  const { modules } = QRCode.create(String(value), { errorCorrectionLevel: 'M' });
  const n = modules.size;
  const q = 2; // quiet zone, in modules
  const total = n + q * 2;
  let rects = '';
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (!modules.get(y, x)) continue;
      let w = 1;
      while (x + w < n && modules.get(y, x + w)) w++;
      rects += `<rect x="${x + q}" y="${y + q}" width="${w}" height="1"/>`;
      x += w - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects}</g></svg>`;
}

hb.registerHelper({
  money(amount, currency, locale) {
    const cur = typeof currency === 'string' && currency ? currency.toUpperCase() : 'USD';
    const loc = typeof locale === 'string' && locale ? locale : 'en-US';
    try {
      return new Intl.NumberFormat(loc, { style: 'currency', currency: cur }).format(toNumber(amount));
    } catch {
      return `${toNumber(amount).toFixed(2)} ${cur}`;
    }
  },
  fixed(value, decimals) {
    return toNumber(value).toFixed(typeof decimals === 'number' ? decimals : 2);
  },
  // {{date value "long" "en-GB" "Asia/Karachi"}} or {{date value locale="en-GB" tz="Asia/Karachi"}}
  date(...list) {
    const opts = list[list.length - 1] || {};
    const [value, style, locale, timeZone] = list.slice(0, -1);
    if (value === undefined || value === null || value === '') return '';
    const d = toDate(value);
    if (Number.isNaN(d.getTime())) return String(value);
    const hash = opts.hash || {};
    const dateStyle = str(style) || 'medium';
    const loc = str(locale) || str(hash.locale) || 'en-US';
    const tz = str(timeZone) || str(hash.tz) || 'UTC';
    try {
      return new Intl.DateTimeFormat(loc, { dateStyle, timeZone: tz }).format(d);
    } catch {
      try {
        return new Intl.DateTimeFormat('en-US', { dateStyle, timeZone: 'UTC' }).format(d);
      } catch {
        return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeZone: 'UTC' }).format(d);
      }
    }
  },
  add() { return args(arguments).reduce((a, b) => a + toNumber(b), 0); },
  sub(a, b) { return toNumber(a) - toNumber(b); },
  mul() { return args(arguments).reduce((a, b) => a * toNumber(b), 1); },
  div(a, b) { return toNumber(b) === 0 ? 0 : toNumber(a) / toNumber(b); },
  // {{sum items "price" "qty"}} -> sum of price*qty across items; a missing field counts as 1.
  sum(list, ...rest) {
    const fields = rest.slice(0, -1);
    if (!Array.isArray(list)) return 0;
    return list.reduce((total, item) => {
      if (!fields.length) return total + toNumber(item);
      return total + fields.reduce((p, f) => {
        const v = item?.[f];
        return p * (v === undefined || v === null || v === '' ? 1 : toNumber(v));
      }, 1);
    }, 0);
  },
  percent(value, pct) { return (toNumber(value) * toNumber(pct)) / 100; },
  eq(a, b) { return a === b; },
  gt(a, b) { return toNumber(a) > toNumber(b); },
  upper(s) { return String(s ?? '').toUpperCase(); },
  lower(s) { return String(s ?? '').toLowerCase(); },
  default(v, fallback) { return v === undefined || v === null || v === '' ? fallback : v; },
  inc(i) { return toNumber(i) + 1; },
  // {{qr payment_url size=120}} -> inline SVG QR code
  qr(value, options) {
    if (value === undefined || value === null || value === '') return '';
    const size = Math.min(400, Math.max(32, Math.round(toNumber(options?.hash?.size) || 96)));
    return new hb.SafeString(qrSvg(value, size));
  },
});

const compiled = new Map();
function compile(source, { prefix = 'h:', noEscape = false, cacheable = true } = {}) {
  const key = prefix + source;
  let fn = cacheable ? compiled.get(key) : undefined;
  if (!fn) {
    fn = hb.compile(source, { strict: false, noEscape });
    if (cacheable) {
      if (compiled.size > 500) compiled.clear();
      compiled.set(key, fn);
    }
  }
  return fn;
}

function run(source, data, opts) {
  try {
    return compile(source, opts)(data);
  } catch (e) {
    if (!e.code) e.code = 'TEMPLATE_ERROR';
    throw e;
  }
}

const MAX_OUTPUT = 5 * 1024 * 1024;
const CSP = `<meta http-equiv="Content-Security-Policy" content="frame-src 'none'; object-src 'none'; child-src 'none'">`;
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Template -> full HTML document (+ compiled header/footer). Runs in the build worker for
// renders and synchronously through buildHtml() for tests and the gallery.
function build({ html = '', css = '', data = {}, raw = false, baseUrl, header, footer, cacheable = true }) {
  const ctx = data ?? {};
  const body = raw ? String(html) : run(String(html), ctx, { prefix: 'h:', cacheable });
  css = css ? (raw ? String(css) : run(String(css), ctx, { prefix: 'c:', noEscape: true, cacheable })) : '';
  css = css.replace(/<\/style/gi, '<\\/style');
  const hf = (s) => (s ? (raw ? s : run(s, ctx, { prefix: 'hf:', cacheable })) : '');
  const headerHtml = hf(header);
  const footerHtml = hf(footer);

  const meta = CSP + (baseUrl ? `<base href="${escAttr(baseUrl)}">` : '');
  const style = `<style>${css}</style>`;
  let doc;
  if (/<html[\s>]/i.test(body)) {
    // Full documents: inject css without restructuring the author's markup.
    const headOpen = /<head(\s[^>]*)?>/i;
    const htmlOpen = /<html(\s[^>]*)?>/i;
    if (headOpen.test(body)) {
      doc = body.replace(headOpen, (m) => m + meta);
      doc = /<\/head>/i.test(doc) ? doc.replace(/<\/head>/i, () => `${style}</head>`) : doc.replace(headOpen, (m) => m + style);
    } else if (htmlOpen.test(body)) {
      doc = body.replace(htmlOpen, (m) => m + meta + style);
    } else {
      doc = meta + style + body;
    }
  } else {
    doc = `<!doctype html><html><head><meta charset="utf-8">${meta}${style}</head><body>${body}</body></html>`;
  }
  if (doc.length + headerHtml.length + footerHtml.length > MAX_OUTPUT) {
    throw fail('TEMPLATE_TOO_EXPENSIVE', 'Rendered HTML is larger than 5MB');
  }
  return { doc, headerHtml, footerHtml };
}

function buildHtml({ html, css = '', data = {}, raw = false, baseUrl } = {}) {
  return build({ html, css, data, raw, baseUrl }).doc;
}

// ---- Handlebars isolation: the build runs in a worker thread with its own heap and a hard
// time limit, so `{{#each}}` bombs can't freeze the API process.
if (!isMainThread && workerData && workerData.docforgeBuild) {
  parentPort.on('message', ({ id, job }) => {
    try {
      parentPort.postMessage({ id, out: build(job) });
    } catch (e) {
      parentPort.postMessage({ id, error: { message: String(e.message), code: e.code || 'TEMPLATE_ERROR' } });
    }
  });
}

class BuildPool {
  constructor({ timeoutMs = 3000, maxIdle = 4 } = {}) {
    this.timeoutMs = timeoutMs;
    this.maxIdle = maxIdle;
    this.idle = [];
    this.seq = 0;
  }

  spawn() {
    const w = new Worker(__filename, { workerData: { docforgeBuild: true }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    w.unref();
    w.on('message', (msg) => {
      const p = w.pending;
      if (!p || p.id !== msg.id) return;
      this.settle(w, msg.error ? Object.assign(new Error(msg.error.message), { code: msg.error.code }) : null, msg.out);
      if (!w.dead && this.idle.length < this.maxIdle) this.idle.push(w);
      else this.kill(w);
    });
    w.on('error', (e) => {
      w.dead = true;
      this.settle(w, e.code === 'ERR_WORKER_OUT_OF_MEMORY'
        ? fail('TEMPLATE_TOO_EXPENSIVE', 'Template used too much memory while rendering')
        : e);
    });
    w.on('exit', () => {
      w.dead = true;
      this.idle = this.idle.filter((x) => x !== w);
      this.settle(w, fail('TEMPLATE_TOO_EXPENSIVE', 'Template build stopped unexpectedly'));
    });
    return w;
  }

  settle(w, err, out) {
    const p = w.pending;
    if (!p) return;
    w.pending = null;
    clearTimeout(p.timer);
    if (err) p.reject(err);
    else p.resolve(out);
  }

  kill(w) {
    w.dead = true;
    w.terminate().catch(() => {});
  }

  run(job) {
    let w;
    while ((w = this.idle.pop()) && w.dead);
    if (!w) w = this.spawn();
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      w.pending = {
        id, resolve, reject,
        timer: setTimeout(() => {
          this.settle(w, fail('TEMPLATE_TOO_EXPENSIVE', `Template took longer than ${this.timeoutMs}ms to build; simplify loops or reduce data`));
          this.kill(w);
        }, this.timeoutMs),
      };
      w.postMessage({ id, job });
    });
  }

  close() {
    for (const w of this.idle.splice(0)) this.kill(w);
  }
}

// ---- SSRF guard

function v4Private(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224
  );
}

function expandV6(ip) {
  let v = ip;
  const dotted = v.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    v = `${v.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = v.includes('::') ? Array(8 - h.length - t.length).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

const v4From = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function isPrivateIp(ip) {
  let v = String(ip).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (net.isIPv4(v)) return v4Private(v);
  if (v.startsWith('::ffff:') && net.isIPv4(v.slice(7))) return v4Private(v.slice(7));
  if (!net.isIPv6(v)) return true; // not an address: fail closed
  const h = expandV6(v);
  const zero = (from, to) => h.slice(from, to).every((x) => x === 0);
  if (zero(0, 8)) return true; // ::
  if (zero(0, 7) && h[7] === 1) return true; // ::1
  if (zero(0, 5) && h[5] === 0xffff) return v4Private(v4From(h[6], h[7])); // ::ffff:a.b.c.d
  if (zero(0, 6)) return v4Private(v4From(h[6], h[7])); // ::a.b.c.d (deprecated compat)
  if (h[0] === 0x64 && h[1] === 0xff9b && zero(2, 6)) return v4Private(v4From(h[6], h[7])); // NAT64 64:ff9b::/96
  if (h[0] === 0x64 && h[1] === 0xff9b && h[2] === 1) return true; // local-use NAT64 64:ff9b:1::/48
  if (h[0] === 0x2002) return v4Private(v4From(h[1], h[2])); // 6to4 2002::/16
  if (h[0] === 0x2001 && h[1] === 0) return true; // Teredo
  if (h[0] === 0x2001 && h[1] === 0xdb8) return true; // documentation
  if ((h[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if (h[0] >= 0xfe80 && h[0] <= 0xfeff) return true; // fe80::/10 link-local, fec0::/10 site-local
  if ((h[0] & 0xff00) === 0xff00) return true; // multicast
  return false;
}

// Templates may pull logos/fonts over https, but never from internal networks
// (SSRF into the host's metadata service or private services).
async function allowUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === 'data:' || url.protocol === 'about:') return true;
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) return !isPrivateIp(host);
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

// ---- Page options

const FORMATS = { a4: 'A4', letter: 'Letter', legal: 'Legal', a5: 'A5', a3: 'A3', tabloid: 'Tabloid', ledger: 'Ledger' };
// Paper sizes in inches (width, height), used to estimate page counts.
const PAPER = { A4: [8.27, 11.69], Letter: [8.5, 11], Legal: [8.5, 14], A5: [5.83, 8.27], A3: [11.69, 16.54], Tabloid: [11, 17], Ledger: [17, 11] };
const UNIT_PX = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4 };
const DEFAULT_MARGIN = { top: '14mm', right: '12mm', bottom: '16mm', left: '12mm' };
const MAX_HF = 16 * 1024;

function toPx(v, what) {
  if (v === undefined || v === null || v === '') return 0;
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  const m = typeof v === 'string' && v.trim().match(/^(\d+(?:\.\d+)?)\s*(px|in|cm|mm)?$/i);
  if (!m) throw fail('INVALID_OPTION', `options.${what} must be a number or a string with px, in, cm or mm (got ${JSON.stringify(v)})`);
  return Number(m[1]) * UNIT_PX[(m[2] || 'px').toLowerCase()];
}

function pageOptions(options = {}) {
  if (typeof options !== 'object' || options === null) throw fail('INVALID_OPTION', 'options must be an object');
  const out = {
    landscape: Boolean(options.landscape),
    printBackground: options.printBackground !== false,
    preferCSSPageSize: Boolean(options.preferCSSPageSize),
  };
  let paper;
  if (options.format !== undefined && options.format !== null && options.format !== '') {
    const key = String(options.format).toLowerCase();
    if (!Object.hasOwn(FORMATS, key)) {
      throw fail('INVALID_OPTION', `Unknown options.format "${options.format}". Use one of: ${Object.keys(FORMATS).join(', ')}`);
    }
    out.format = FORMATS[key];
    paper = PAPER[out.format].map((x) => x * 96);
  } else if (options.width || options.height) {
    if (options.width) out.width = options.width;
    if (options.height) out.height = options.height;
    paper = [toPx(options.width, 'width') || PAPER.A4[0] * 96, toPx(options.height, 'height') || PAPER.A4[1] * 96];
  } else {
    out.format = 'A4';
    paper = PAPER.A4.map((x) => x * 96);
  }
  if (out.landscape) paper = [paper[1], paper[0]];

  for (const k of ['header_html', 'footer_html']) {
    const v = options[k];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v !== 'string') throw fail('INVALID_OPTION', `options.${k} must be a string`);
    if (v.length > MAX_HF) throw fail('INVALID_OPTION', `options.${k} must be at most 16KB`);
  }
  const header = options.header_html || '';
  const footer = options.footer_html || '';

  let margin;
  const given = options.margin !== undefined && options.margin !== null && options.margin !== '';
  if (given) {
    if (typeof options.margin === 'object') {
      const m = options.margin;
      margin = { top: m.top || '0', right: m.right || '0', bottom: m.bottom || '0', left: m.left || '0' };
    } else {
      const v = String(options.margin);
      margin = { top: v, right: v, bottom: v, left: v };
    }
  } else if (out.preferCSSPageSize) {
    margin = { top: '0', right: '0', bottom: '0', left: '0' };
  } else {
    margin = { ...DEFAULT_MARGIN };
  }
  const px = {};
  for (const side of ['top', 'right', 'bottom', 'left']) px[side] = toPx(margin[side], `margin.${side}`);
  if ((header || footer) && !given) {
    const min = 15 * UNIT_PX.mm;
    if (px.top < min) { margin.top = '15mm'; px.top = min; }
    if (px.bottom < min) { margin.bottom = '15mm'; px.bottom = min; }
  }
  out.margin = margin;
  if (header || footer) out.displayHeaderFooter = true;

  const printable = {
    width: Math.max(50, Math.round(paper[0] - px.left - px.right)),
    height: Math.max(50, paper[1] - px.top - px.bottom),
  };
  return { pdf: out, header, footer, printable };
}

// ---- Free-plan watermark, stamped onto the finished PDF (CSS in the template can't hide it).

async function stamp(bytes, { demo, host, publicUrl }) {
  const { PDFDocument, StandardFonts, rgb, degrees, PDFString } = require('pdf-lib');
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const gray = rgb(0x9c / 255, 0xa3 / 255, 0xaf / 255);
  const text = `Made with DocForge · ${host}`;
  const size = 8;
  const textWidth = font.widthOfTextAtSize(text, size);
  const link = `${publicUrl}/?ref=${demo ? 'demo' : 'pdf'}`;
  const sample = 'SAMPLE · DocForge demo';

  for (const page of doc.getPages()) {
    const { width, height } = page.getSize();
    const x = Math.max(4, width - textWidth - 24);
    const y = 12;
    page.drawText(text, { x, y, size, font, color: gray });
    const annot = doc.context.register(doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [x - 2, y - 3, x + textWidth + 2, y + size + 2],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of(link) },
    }));
    page.node.addAnnot(annot);

    if (demo) {
      const angle = Math.atan2(height, width);
      const big = Math.min(width, height) / 9;
      const w = font.widthOfTextAtSize(sample, big);
      const cx = width / 2 - (Math.cos(angle) * w) / 2 + (Math.sin(angle) * big) / 3;
      const cy = height / 2 - (Math.sin(angle) * w) / 2 - (Math.cos(angle) * big) / 3;
      page.drawText(sample, { x: cx, y: cy, size: big, font, color: gray, opacity: 0.18, rotate: degrees((angle * 180) / Math.PI) });
    }
  }
  doc.setProducer('DocForge free');
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

// ---- Renderer

const BLOCKABLE_OK = new Set(['image', 'font', 'stylesheet']);
const RECYCLE_AFTER = 500;

class Renderer {
  constructor({
    maxConcurrent = Number(process.env.RENDER_CONCURRENCY) || 2,
    maxQueue = Number(process.env.RENDER_MAX_QUEUE) || 50,
    queueTimeoutMs = 15000,
    deadlineMs = Number(process.env.RENDER_DEADLINE_MS) || 30000,
    publicUrl = process.env.PUBLIC_URL || 'http://localhost:3000',
    urlAllowed = allowUrl, // injectable for tests only
  } = {}) {
    this.allowUrl = urlAllowed;
    this.maxConcurrent = maxConcurrent;
    this.maxQueue = maxQueue;
    this.queueTimeoutMs = queueTimeoutMs;
    this.deadlineMs = deadlineMs;
    this.publicUrl = String(publicUrl).replace(/\/+$/, '');
    try { this.host = new URL(this.publicUrl).host; } catch { this.host = 'localhost:3000'; }
    this.active = 0;
    this.queue = [];
    this.browser = null;
    this.completed = 0;
    this.lastLaunchError = null;
    this.builder = new BuildPool({ maxIdle: Math.max(2, maxConcurrent) });
  }

  get queueLength() {
    return this.queue.length;
  }

  status() {
    return {
      connected: Boolean(this.browser?.isConnected()),
      lastLaunchError: this.lastLaunchError,
      active: this.active,
      queued: this.queue.length,
    };
  }

  async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      const { chromium } = require('playwright-core');
      const executablePath = process.env.CHROMIUM_PATH || undefined;
      this.launching = chromium
        .launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
        .then((b) => {
          this.browser = b;
          this.lastLaunchError = null;
          b.on('disconnected', () => { if (this.browser === b) this.browser = null; });
          return b;
        })
        .catch((e) => {
          this.lastLaunchError = String(e.message).split('\n')[0];
          throw e;
        })
        .finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  async slot() {
    if (this.active < this.maxConcurrent) { this.active++; return; }
    if (this.queue.length >= this.maxQueue) throw fail('BUSY', 'Render queue is full, retry shortly');
    await new Promise((resolve, reject) => {
      const entry = {
        // release() hands its slot straight to us, so `active` is not touched here.
        resolve: () => { clearTimeout(entry.timer); resolve(); },
        timer: setTimeout(() => {
          const i = this.queue.indexOf(entry);
          if (i !== -1) this.queue.splice(i, 1);
          reject(fail('BUSY', 'Timed out waiting for a render slot, retry shortly'));
        }, this.queueTimeoutMs),
      };
      this.queue.push(entry);
    });
  }

  release() {
    this.completed++;
    const next = this.queue.shift();
    if (next) return next.resolve();
    this.active--;
    // Long-lived Chromium processes slowly leak; recycle when idle.
    if (this.active === 0 && this.completed >= RECYCLE_AFTER && this.browser) {
      const b = this.browser;
      this.browser = null;
      this.completed = 0;
      b.close().catch(() => {});
    }
  }

  async pdf({ html, css, data, options = {}, watermark = false, raw = false, baseUrl, maxPages = 500, cacheable }) {
    const page$ = pageOptions(options || {});
    if (baseUrl) {
      let ok = false;
      try { ok = new URL(baseUrl).protocol === 'https:'; } catch {}
      if (!ok) throw fail('INVALID_OPTION', 'base_url must be an https URL');
    }
    const job = {
      html: html ?? '', css: css ?? '', data: data ?? {}, raw: Boolean(raw), baseUrl,
      header: page$.header, footer: page$.footer,
      cacheable: raw ? false : cacheable ?? String(html ?? '').length < 64 * 1024,
    };

    await this.slot();
    let context;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      context?.close().catch(() => {});
    }, this.deadlineMs);
    try {
      const { doc, headerHtml, footerHtml } = await this.builder.run(job);
      if (timedOut) throw fail('RENDER_TIMEOUT', 'Render deadline exceeded');
      const browser = await this.getBrowser();
      if (timedOut) throw fail('RENDER_TIMEOUT', 'Render deadline exceeded');
      context = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { width: page$.printable.width, height: 800 },
      });
      if (timedOut) { context.close().catch(() => {}); throw fail('RENDER_TIMEOUT', 'Render deadline exceeded'); }

      const blocked = [];
      const block = (url) => {
        if (blocked.length < 10 && !blocked.includes(url.slice(0, 200))) blocked.push(url.slice(0, 200));
      };
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        const req = route.request();
        const url = req.url();
        if (url === 'about:blank' || url.startsWith('data:')) return route.continue();
        if (BLOCKABLE_OK.has(req.resourceType()) && (await this.allowUrl(url))) {
          // Never route.continue(): Chromium would follow 3xx hops itself without
          // re-checking them (SSRF via redirect to 169.254.169.254 / 10.x / http).
          // Fetch from Node with redirects off and re-check every Location by hand.
          let target = url;
          try {
            for (let hop = 0; hop <= 3; hop++) {
              const resp = await route.fetch({ url: target, maxRedirects: 0, timeout: 8000 });
              const s = resp.status();
              if (s < 300 || s >= 400) return await route.fulfill({ response: resp });
              const loc = resp.headers()['location'];
              if (!loc || hop === 3) break;
              target = new URL(loc, target).href;
              if (!(await this.allowUrl(target))) { block(target); break; }
            }
          } catch { /* fall through to block */ }
          block(url);
          return route.abort('blockedbyclient').catch(() => {});
        }
        block(url);
        return route.abort('blockedbyclient').catch(() => {});
      });
      await page.emulateMedia({ media: 'print' });
      try {
        await page.setContent(doc, { waitUntil: 'load', timeout: 10000 });
      } catch (e) {
        // A slow remote asset shouldn't fail the whole document; print what has loaded.
        if (e.name !== 'TimeoutError' || timedOut) throw e;
      }

      const probe = await page.evaluate(({ pageHeight, maxPages: limit }) => {
        const root = document.documentElement;
        const h = Math.max(root ? root.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
        // Frames/objects are refused by the CSP before any request is made; report them too.
        const embeds = [];
        for (const el of document.querySelectorAll('iframe[src], frame[src], embed[src], object[data]')) {
          if (embeds.length >= 10) break;
          embeds.push(el.src || el.data || '');
        }
        let breaks = 0;
        if (Math.ceil(h / pageHeight) <= limit) {
          const forced = /^(page|left|right|recto|verso)$/;
          const els = document.body ? document.body.getElementsByTagName('*') : [];
          for (let i = 0; i < els.length && breaks <= limit; i++) {
            const s = getComputedStyle(els[i]);
            if (forced.test(s.breakBefore)) breaks++;
            if (forced.test(s.breakAfter)) breaks++;
          }
        }
        return { h, breaks, embeds };
      }, { pageHeight: page$.printable.height, maxPages });
      for (const u of probe.embeds) if (u) block(u);
      const estimate = Math.ceil(probe.h / page$.printable.height) + probe.breaks;
      if (estimate > maxPages) {
        throw fail('TOO_MANY_PAGES', `Document would be about ${estimate} pages; the limit on this plan is ${maxPages}`);
      }

      const pdfOpts = { ...page$.pdf };
      if (pdfOpts.displayHeaderFooter) {
        pdfOpts.headerTemplate = headerHtml || '<span></span>';
        pdfOpts.footerTemplate = footerHtml || '<span></span>';
      }
      let buf = await page.pdf(pdfOpts);
      if (timedOut) throw fail('RENDER_TIMEOUT', 'Render deadline exceeded');
      if (watermark) {
        buf = await stamp(buf, { demo: watermark === 'demo', host: this.host, publicUrl: this.publicUrl });
      }
      Object.defineProperty(buf, 'blockedAssets', { value: blocked, enumerable: false });
      return buf;
    } catch (e) {
      if (timedOut && e.code !== 'TOO_MANY_PAGES' && e.code !== 'TEMPLATE_TOO_EXPENSIVE' && e.code !== 'TEMPLATE_ERROR') {
        throw fail('RENDER_TIMEOUT', `Render took longer than ${Math.round(this.deadlineMs / 1000)}s`);
      }
      throw e;
    } finally {
      clearTimeout(deadline);
      if (context) await context.close().catch(() => {});
      this.release();
    }
  }

  async close() {
    this.builder.close();
    const b = this.browser;
    this.browser = null;
    if (b) await b.close();
  }
}

module.exports = { Renderer, buildHtml, isPrivateIp, allowUrl, FORMATS };
