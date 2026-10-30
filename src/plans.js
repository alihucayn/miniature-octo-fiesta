// Pricing is per document, not per seat: Starter works out to $6 per 1,000
// PDFs, and every paid plan has a 10% grace band so a busy month degrades to
// a warning header instead of failed invoices. Variant IDs map Lemon Squeezy
// products (monthly and yearly) to plans.
const paid = (p) => ({ ...p, watermark: false, graceRenders: Math.round(p.monthlyRenders * 0.1) });

const PLANS = {
  free: { name: 'Free', priceUsd: 0, monthlyRenders: 100, templates: 3, watermark: true, graceRenders: 0, concurrency: 1, maxPages: 20 },
  starter: paid({ name: 'Starter', priceUsd: 15, monthlyRenders: 2500, templates: 20, concurrency: 2, maxPages: 200 }),
  pro: paid({ name: 'Pro', priceUsd: 39, monthlyRenders: 10000, templates: 100, concurrency: 3, maxPages: 500 }),
  business: paid({ name: 'Business', priceUsd: 99, monthlyRenders: 50000, templates: 500, concurrency: 4, maxPages: 500 }),
};

const VARIANT_ENV = {
  LS_VARIANT_STARTER: 'starter',
  LS_VARIANT_PRO: 'pro',
  LS_VARIANT_BUSINESS: 'business',
  LS_VARIANT_STARTER_YEARLY: 'starter',
  LS_VARIANT_PRO_YEARLY: 'pro',
  LS_VARIANT_BUSINESS_YEARLY: 'business',
};

// Read on every call so env changes (tests, admin scripts) apply immediately,
// and skip unset vars so they never become an "undefined" key.
function configuredVariants() {
  const map = {};
  for (const [envName, plan] of Object.entries(VARIANT_ENV)) {
    const v = process.env[envName];
    if (v && String(v).trim()) map[String(v).trim()] = plan;
  }
  return map;
}

function planFromVariant(variantId) {
  if (variantId === undefined || variantId === null) return null;
  return configuredVariants()[String(variantId)] || null;
}

module.exports = { PLANS, planFromVariant, configuredVariants };
