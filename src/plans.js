// Pricing is deliberately set below the incumbents (PDFMonkey €19/300 docs,
// APITemplate $19-24/3k, CraftMyPDF $29) so "cheaper with a real free tier"
// is the one-line pitch. Variant IDs map Lemon Squeezy products to plans.
const PLANS = {
  free: { name: 'Free', priceUsd: 0, monthlyRenders: 100, templates: 3, watermark: true },
  starter: { name: 'Starter', priceUsd: 9, monthlyRenders: 2000, templates: 20, watermark: false },
  pro: { name: 'Pro', priceUsd: 29, monthlyRenders: 15000, templates: 100, watermark: false },
  business: { name: 'Business', priceUsd: 79, monthlyRenders: 60000, templates: 500, watermark: false },
};

function planFromVariant(variantId) {
  const map = {
    [process.env.LS_VARIANT_STARTER]: 'starter',
    [process.env.LS_VARIANT_PRO]: 'pro',
    [process.env.LS_VARIANT_BUSINESS]: 'business',
  };
  return map[String(variantId)] || null;
}

module.exports = { PLANS, planFromVariant };
