'use strict';
// Payment settings and the place where an online payment gateway plugs in.
//
// Today: "manual" — the customer pays by UPI (QR / UPI ID) or bank transfer, types the reference (UTR), and the
// admin confirms the payment on the dashboard (Pricing → Orders), which starts the plan.
// Later: set the gateway on Pricing → Payment settings (Razorpay, Cashfree, PayU, PhonePe or Stripe), add its keys,
// and fill in that gateway's adapter in GATEWAY_ADAPTERS below: createOrder() makes the gateway order the website's
// checkout opens, and verifyWebhook() checks the gateway's server-to-server notice and returns the paid order.
// The rest (orders, confirming, starting the plan, refunds) stays as it is.

const { ApiError, text } = require('./http');
const { now } = require('./db');

const GATEWAYS = [
  { id: 'manual', name: 'UPI / bank transfer (confirmed by you)', online: false },
  { id: 'razorpay', name: 'Razorpay', online: true },
  { id: 'cashfree', name: 'Cashfree Payments', online: true },
  { id: 'payu', name: 'PayU', online: true },
  { id: 'phonepe', name: 'PhonePe Payment Gateway', online: true },
  { id: 'stripe', name: 'Stripe', online: true },
];
const METHODS = ['upi', 'card', 'netbanking', 'wallet', 'emi', 'bank_transfer'];
const METHOD_NAMES = { upi: 'UPI', card: 'Debit / credit card', netbanking: 'Net banking', wallet: 'Wallets', emi: 'EMI', bank_transfer: 'Bank transfer (NEFT / IMPS)' };

const DEFAULTS = {
  provider: 'manual', mode: 'test', methods: { upi: true, card: false, netbanking: false, wallet: false, emi: false, bank_transfer: true },
  gstRate: 18, pricesIncludeGst: true, gstin: '', invoicePrefix: 'SP', keyId: '',
  manual: { upiId: '', payeeName: 'ShortlistPrep Technologies Pvt Ltd', bankName: '', accountName: '', accountNumber: '', ifsc: '', instructions: 'After paying, enter the UPI / bank reference (UTR). We start your plan as soon as we confirm the payment, usually within a few hours.' },
};

const get = (db, key) => { const r = db.prepare('SELECT value FROM job_settings WHERE key = ?').get(key); try { return r ? JSON.parse(r.value) : null; } catch (_) { return null; } };
const put = (db, key, value, by) => db.prepare(`INSERT INTO job_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
  ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`).run(key, JSON.stringify(value), now(), by || '');

/** The payment settings (no secrets). */
function config(db) {
  const c = get(db, 'payment_config') || {};
  return { ...DEFAULTS, ...c, methods: { ...DEFAULTS.methods, ...(c.methods || {}) }, manual: { ...DEFAULTS.manual, ...(c.manual || {}) } };
}
const secrets = db => get(db, 'payment_secrets') || {};
const enabledMethods = cfg => METHODS.filter(m => cfg.methods[m]);
const isOnline = cfg => (GATEWAYS.find(g => g.id === cfg.provider) || {}).online === true && !!GATEWAY_ADAPTERS[cfg.provider];

/** For the dashboard: settings plus whether each secret is set (never the secret itself). */
function presentConfig(cfg, db) {
  const s = secrets(db);
  return { ...cfg, secrets: { keySecret: !!s.keySecret, webhookSecret: !!s.webhookSecret }, connected: isOnline(cfg),
    methodNames: METHOD_NAMES, adapterReady: Object.keys(GATEWAY_ADAPTERS) };
}

function saveConfig(db, vault, body, by) {
  const cur = config(db);
  const provider = GATEWAYS.some(g => g.id === body.provider) ? body.provider : cur.provider;
  const methods = {};
  for (const m of METHODS) methods[m] = body.methods ? !!body.methods[m] : cur.methods[m];
  if (!Object.values(methods).some(Boolean)) throw new ApiError(400, 'Turn on at least one payment method');
  const gstRate = Number(body.gstRate == null ? cur.gstRate : body.gstRate);
  if (![0, 5, 12, 18, 28].includes(gstRate)) throw new ApiError(400, 'GST rate must be 0, 5, 12, 18 or 28 per cent');
  const gstin = text(body.gstin == null ? cur.gstin : body.gstin, 15, { field: 'GSTIN' }).toUpperCase();
  if (gstin && !/^[0-9]{2}[A-Z0-9]{13}$/.test(gstin)) throw new ApiError(400, 'GSTIN must be 15 characters (e.g. 09ABCDE1234F1Z5)');
  const m = body.manual || {};
  const upiId = text(m.upiId == null ? cur.manual.upiId : m.upiId, 60, { field: 'UPI ID' });
  if (upiId && !/^[\w.-]{2,}@[\w.-]{2,}$/.test(upiId)) throw new ApiError(400, 'UPI ID looks wrong (it is like name@bank)');
  const ifsc = text(m.ifsc == null ? cur.manual.ifsc : m.ifsc, 11, { field: 'IFSC' }).toUpperCase();
  if (ifsc && !/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) throw new ApiError(400, 'IFSC must be 11 characters (e.g. HDFC0001234)');
  const next = {
    provider, mode: body.mode === 'live' ? 'live' : 'test', methods, gstRate, pricesIncludeGst: body.pricesIncludeGst == null ? cur.pricesIncludeGst : !!body.pricesIncludeGst,
    gstin, invoicePrefix: (text(body.invoicePrefix == null ? cur.invoicePrefix : body.invoicePrefix, 8, { field: 'Invoice prefix' }).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'SP'),
    keyId: text(body.keyId == null ? cur.keyId : body.keyId, 120, { field: 'Key ID' }),
    manual: {
      upiId, payeeName: text(m.payeeName == null ? cur.manual.payeeName : m.payeeName, 80, { field: 'Payee name' }),
      bankName: text(m.bankName == null ? cur.manual.bankName : m.bankName, 80, { field: 'Bank name' }),
      accountName: text(m.accountName == null ? cur.manual.accountName : m.accountName, 80, { field: 'Account name' }),
      accountNumber: text(m.accountNumber == null ? cur.manual.accountNumber : m.accountNumber, 30, { field: 'Account number' }).replace(/\s+/g, ''),
      ifsc, instructions: text(m.instructions == null ? cur.manual.instructions : m.instructions, 500, { field: 'Instructions' }),
    },
  };
  put(db, 'payment_config', next, by);
  // secrets: kept encrypted; an empty field keeps the saved one, "clear" removes it
  const s = secrets(db);
  for (const k of ['keySecret', 'webhookSecret']) {
    if (body[k] === 'clear') delete s[k];
    else if (body[k]) s[k] = vault.encrypt(text(body[k], 300, { field: k }));
  }
  put(db, 'payment_secrets', s, by);
  return config(db);
}

/**
 * Online gateways. Each adapter: createOrder({cfg, keySecret, order, customer}) → {gatewayOrderId, checkout}
 * (what the website needs to open the gateway's checkout), and verifyWebhook({cfg, webhookSecret, body, req})
 * → {gatewayOrderId, gatewayPaymentId, paid}. None is connected yet: add one here when you sign up with a gateway.
 */
const GATEWAY_ADAPTERS = {};

/** How the customer pays for a new order. */
async function startPayment({ db, vault, cfg, order, customer }) {
  const amount = order.amount_paise / 100;
  const adapter = GATEWAY_ADAPTERS[cfg.provider];
  if (adapter) {
    const s = secrets(db);
    const out = await adapter.createOrder({ cfg, keySecret: s.keySecret ? vault.decrypt(s.keySecret) : '', order, customer });
    return { type: 'gateway', provider: cfg.provider, mode: cfg.mode, keyId: cfg.keyId, ...out };
  }
  // manual: UPI (a payment link / QR the phone's UPI app opens) and bank transfer
  const m = cfg.manual;
  const note = `${order.number} ${order.plan_name}`.slice(0, 50);
  return {
    type: 'manual', provider: 'manual', amount, currency: 'INR', number: order.number,
    gatewayNotConnected: cfg.provider !== 'manual',   // a gateway is chosen but not connected yet
    upi: cfg.methods.upi && m.upiId ? { upiId: m.upiId, payeeName: m.payeeName,
      link: `upi://pay?pa=${encodeURIComponent(m.upiId)}&pn=${encodeURIComponent(m.payeeName || 'ShortlistPrep')}&am=${amount.toFixed(2)}&cu=INR&tn=${encodeURIComponent(note)}` } : null,
    bank: cfg.methods.bank_transfer && m.accountNumber ? { bankName: m.bankName, accountName: m.accountName || m.payeeName, accountNumber: m.accountNumber, ifsc: m.ifsc } : null,
    instructions: m.instructions,
  };
}

/** A gateway's notice that a payment succeeded or failed. */
async function webhook({ db, vault, cfg, provider, body, req }) {
  const adapter = GATEWAY_ADAPTERS[provider];
  if (!GATEWAYS.some(g => g.id === provider && g.online)) throw new ApiError(404, 'Unknown payment gateway');
  if (!adapter || cfg.provider !== provider) throw new ApiError(501, 'This payment gateway is not connected yet');
  const s = secrets(db);
  const result = await adapter.verifyWebhook({ cfg, webhookSecret: s.webhookSecret ? vault.decrypt(s.webhookSecret) : '', body, req });
  return { ok: true, result };
}

module.exports = { config, saveConfig, presentConfig, enabledMethods, isOnline, startPayment, webhook, GATEWAYS, METHODS, METHOD_NAMES, GATEWAY_ADAPTERS };
