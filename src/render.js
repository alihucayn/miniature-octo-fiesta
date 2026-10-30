const Handlebars = require('handlebars');
const { chromium } = require('playwright-core');
const dns = require('node:dns').promises;
const net = require('node:net');

const hb = Handlebars.create();

function toNumber(v) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

// Last positional argument of a Handlebars helper is always the options hash.
const args = (list) => Array.prototype.slice.call(list, 0, -1);

hb.registerHelper({
  money(amount, currency, locale) {
    const cur = typeof currency === 'string' ? currency : 'USD';
    const loc = typeof locale === 'string' ? locale : 'en-US';
    try {
      return new Intl.NumberFormat(loc, { style: 'currency', currency: cur }).format(toNumber(amount));
    } catch {
      return `${toNumber(amount).toFixed(2)} ${cur}`;
    }
  },
  fixed(value, decimals) {
    return toNumber(value).toFixed(typeof decimals === 'number' ? decimals : 2);
  },
  date(value, style) {
    const d = value ? new Date(value) : new Date();
    if (Number.isNaN(d.getTime())) return String(value);
    const dateStyle = typeof style === 'string' ? style : 'medium';
    return new Intl.DateTimeFormat('en-US', { dateStyle, timeZone: 'UTC' }).format(d);
  },
  add() { return args(arguments).reduce((a, b) => a + toNumber(b), 0); },
  sub(a, b) { return toNumber(a) - toNumber(b); },
  mul() { return args(arguments).reduce((a, b) => a * toNumber(b), 1); },
  div(a, b) { return toNumber(b) === 0 ? 0 : toNumber(a) / toNumber(b); },
  // {{sum items "price" "qty"}} -> sum of price*qty across items
  sum(list, ...rest) {
    const fields = rest.slice(0, -1);
    if (!Array.isArray(list)) return 0;
    return list.reduce((total, item) => {
      if (!fields.length) return total + toNumber(item);
      return total + fields.reduce((p, f) => p * toNumber(item?.[f]), 1);
    }, 0);
  },
  percent(value, pct) { return (toNumber(value) * toNumber(pct)) / 100; },
  eq(a, b) { return a === b; },
  gt(a, b) { return toNumber(a) > toNumber(b); },
  upper(s) { return String(s ?? '').toUpperCase(); },
  lower(s) { return String(s ?? '').toLowerCase(); },
  default(v, fallback) { return v === undefined || v === null || v === '' ? fallback : v; },
  inc(i) { return toNumber(i) + 1; },
});

const compiled = new Map();
function compile(source) {
  let fn = compiled.get(source);
  if (!fn) {
    fn = hb.compile(source, { strict: false });
    if (compiled.size > 500) compiled.clear();
    compiled.set(source, fn);
  }
  return fn;
}

function buildHtml({ html, css = '', data = {}, watermark = false }) {
  const body = compile(html)(data);
  css = css ? compile(css)(data) : '';
  const mark = watermark
    ? `<div style="position:fixed;bottom:4mm;right:6mm;font:9px/1 system-ui,sans-serif;color:#9ca3af">Generated with DocForge — free plan</div>`
    : '';
  if (/<html[\s>]/i.test(body)) {
    // Full documents: inject css/watermark without restructuring the author's markup.
    return body
      .replace(/<\/head>/i, `<style>${css}</style></head>`)
      .replace(/<\/body>/i, `${mark}</body>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}${mark}</body></html>`;
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

// Templates may pull logos/fonts over https, but never from internal networks
// (SSRF into the host's metadata service or private services).
async function allowUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (url.protocol === 'data:' || url.protocol === 'about:') return true;
  if (url.protocol !== 'https:') return false;
  try {
    const addrs = await dns.lookup(url.hostname, { all: true });
    return addrs.length > 0 && addrs.every((a) => !isPrivateIp(a.address));
  } catch {
    return false;
  }
}

class Renderer {
  constructor({ maxConcurrent = Number(process.env.RENDER_CONCURRENCY) || 4, timeoutMs = 20000 } = {}) {
    this.maxConcurrent = maxConcurrent;
    this.timeoutMs = timeoutMs;
    this.active = 0;
    this.queue = [];
    this.browser = null;
  }

  async getBrowser() {
    if (this.browser?.isConnected()) return this.browser;
    if (!this.launching) {
      const executablePath = process.env.CHROMIUM_PATH || undefined;
      this.launching = chromium
        .launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
        .then((b) => { this.browser = b; return b; })
        .finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  async slot() {
    if (this.active < this.maxConcurrent) { this.active++; return; }
    await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
  }

  release() {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  async pdf({ html, css, data, options = {}, watermark = false }) {
    const doc = buildHtml({ html, css, data, watermark });
    await this.slot();
    let context;
    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({ javaScriptEnabled: false });
      const page = await context.newPage();
      await page.route('**/*', async (route) => {
        if (await allowUrl(route.request().url())) return route.continue();
        return route.abort('blockedbyclient');
      });
      await page.setContent(doc, { waitUntil: 'load', timeout: this.timeoutMs });
      const margin = options.margin || {};
      return await page.pdf({
        format: ['A4', 'Letter', 'Legal', 'A5', 'A3'].includes(options.format) ? options.format : 'A4',
        landscape: Boolean(options.landscape),
        printBackground: options.printBackground !== false,
        margin: {
          top: margin.top || '0', right: margin.right || '0', bottom: margin.bottom || '0', left: margin.left || '0',
        },
        preferCSSPageSize: Boolean(options.preferCSSPageSize),
        timeout: this.timeoutMs,
      });
    } finally {
      if (context) await context.close().catch(() => {});
      this.release();
    }
  }

  async close() {
    if (this.browser) await this.browser.close();
  }
}

module.exports = { Renderer, buildHtml, isPrivateIp, allowUrl };
