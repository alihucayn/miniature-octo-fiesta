// Shared by the landing page, docs and guides. Loaded with <script defer>, so
// window.DocForge exists before DOMContentLoaded; the plan data arrives later
// through DocForge.plansReady.
(() => {
  const PLACEHOLDER = 'https://YOUR-DOMAIN';
  const origin = location.origin;

  // (e) Signup attribution, captured once per browser session.
  function captureSource() {
    try {
      const saved = sessionStorage.getItem('df_source');
      if (saved) return saved;
      const q = new URLSearchParams(location.search);
      let ref = '';
      try { ref = document.referrer ? new URL(document.referrer).hostname : ''; } catch { ref = ''; }
      if (ref === location.hostname) ref = '';
      const source = (q.get('ref') || q.get('utm_source') || ref || 'direct').slice(0, 100);
      sessionStorage.setItem('df_source', source);
      return source;
    } catch {
      return 'direct';
    }
  }

  const DocForge = window.DocForge = { origin, plans: null, supportEmail: null, source: captureSource() };

  // (b) One /v1/plans request per page; callers await DocForge.plansReady.
  DocForge.plansReady = fetch('/v1/plans')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((body) => {
      DocForge.plans = body.plans || {};
      DocForge.supportEmail = body.support_email || null;
      return DocForge.plans;
    })
    .catch(() => {
      DocForge.plans = DocForge.plans || {};
      return DocForge.plans;
    });

  // (a) Swap the placeholder domain for the real one in code samples and links.
  function rewriteDomain(root) {
    for (const el of root.querySelectorAll('pre, code')) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.nodeValue.includes(PLACEHOLDER)) n.nodeValue = n.nodeValue.split(PLACEHOLDER).join(origin);
      }
    }
    for (const el of root.querySelectorAll('[href]')) {
      const href = el.getAttribute('href');
      if (href.includes(PLACEHOLDER)) el.setAttribute('href', href.split(PLACEHOLDER).join(origin));
    }
    for (const el of root.querySelectorAll('meta[content]')) {
      const c = el.getAttribute('content');
      if (c.includes(PLACEHOLDER)) el.setAttribute('content', c.split(PLACEHOLDER).join(origin));
    }
  }

  function ensureCanonical() {
    const url = origin + location.pathname;
    let link = document.querySelector('link[rel="canonical"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'canonical';
      document.head.appendChild(link);
    }
    if (!link.getAttribute('href') || link.getAttribute('href').includes(PLACEHOLDER)) link.setAttribute('href', url);
    const og = document.querySelector('meta[property="og:url"]');
    if (og && (!og.getAttribute('content') || og.getAttribute('content').includes(PLACEHOLDER))) og.setAttribute('content', url);
  }

  // (c) Support address: configured SUPPORT_EMAIL, else support@<host>.
  function fillSupportEmail() {
    const email = DocForge.supportEmail || `support@${location.hostname.replace(/^www\./, '')}`;
    for (const el of document.querySelectorAll('[data-support-email]')) {
      if (el.tagName === 'A') el.setAttribute('href', `mailto:${email}`);
      el.textContent = email;
    }
  }

  // (d) Prices and quotas always come from /v1/plans, never from page copy.
  function fillPlans(root = document) {
    const plans = DocForge.plans || {};
    for (const el of root.querySelectorAll('[data-plan-price]')) {
      const p = plans[el.dataset.planPrice];
      if (p) el.textContent = `$${p.priceUsd}`;
    }
    for (const el of root.querySelectorAll('[data-plan-renders]')) {
      const p = plans[el.dataset.planRenders];
      if (p) el.textContent = p.monthlyRenders.toLocaleString();
    }
    for (const el of root.querySelectorAll('[data-plan-per1k]')) {
      const p = plans[el.dataset.planPer1k];
      if (p && p.monthlyRenders) el.textContent = ((p.priceUsd / p.monthlyRenders) * 1000).toFixed(2);
    }
  }
  DocForge.fillPlans = fillPlans;

  // (f) <button data-copy="elementId"> copies that element's text. Delegated,
  // so buttons added later (the key box) work too.
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      ta.remove();
      return ok;
    }
  }
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('[data-copy]');
    if (!btn) return;
    const src = document.getElementById(btn.dataset.copy);
    if (!src) return;
    e.preventDefault();
    const label = btn.dataset.label || btn.textContent;
    btn.dataset.label = label;
    btn.textContent = (await copyText(src.textContent)) ? 'Copied' : 'Copy failed';
    setTimeout(() => { btn.textContent = label; }, 1500);
  });

  function init() {
    rewriteDomain(document);
    ensureCanonical();
    fillSupportEmail();
    DocForge.plansReady.then(() => {
      fillSupportEmail();
      fillPlans();
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
