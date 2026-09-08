// api/create-payment.js
//
// This is what your "Checkout" button calls. It takes whatever is in the
// customer's cart, builds a valid PayFast payment request server-side
// (so your passphrase and the signature-generation logic never touch the
// browser), and hands back the exact fields the front-end needs to send
// the customer to PayFast.
//
// SETUP REQUIRED (in Vercel -> Settings -> Environment Variables):
// - PAYFAST_MERCHANT_ID     (Config is fine - this is shown publicly anyway)
// - PAYFAST_MERCHANT_KEY    (Secret)
// - PAYFAST_PASSPHRASE      (Secret - you should already have this from before)
// - PAYFAST_MODE            (Config - "sandbox" or "live", already set)
//
// Your Merchant ID and Merchant Key are the ones shown on your PayFast
// Developer Settings page (the screenshot you shared earlier).

import crypto from 'crypto';

function generateSignature(fields, passphrase) {
  let pairs = [];
  for (const key in fields) {
    if (fields[key] === undefined || fields[key] === '') continue;
    pairs.push(`${key}=${encodeURIComponent(String(fields[key]).trim()).replace(/%20/g, '+')}`);
  }
  let paramString = pairs.join('&');
  if (passphrase) {
    paramString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }
  return crypto.createHash('md5').update(paramString).digest('hex');
}

function formatAmount(amount) {
  return Number(amount).toFixed(2);
}

// Builds a short, PayFast-safe summary of the cart for item_name / item_description.
function summarizeCart(items) {
  const itemName =
    items.length === 1
      ? items[0].name.slice(0, 100)
      : `Storm 2020 Order (${items.reduce((s, i) => s + i.qty, 0)} items)`;

  const lines = items.map((i) => {
    const bits = [i.name];
    if (i.size) bits.push(`Size ${i.size}`);
    if (i.print) bits.push(i.print);
    return `${bits.join(', ')} x${i.qty}`;
  });
  lines.push('Shipping x1');
  const itemDescription = lines.join(' | ').slice(0, 255);

  return { itemName, itemDescription };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const { items, shipping } = req.body || {};

  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: 'Cart is empty' });
    return;
  }

  if (!shipping || !shipping.nameFirst || !shipping.nameLast || !shipping.email || !shipping.address1 || !shipping.city || !shipping.postalCode) {
    res.status(400).json({ error: 'Missing delivery details' });
    return;
  }

  // NOTE: this trusts the price/qty sent from the browser, since this site
  // doesn't currently have a server-side product database to check prices
  // against. If you ever want extra protection against a tampered total,
  // the fix is to keep a copy of your product prices on the server and
  // recompute the total here instead of trusting the client - happy to help
  // with that later if you want it.
  const SHIPPING_FEE = 150;
  const subtotal = items.reduce((sum, i) => sum + Number(i.price) * Number(i.qty), 0);
  const total = subtotal + SHIPPING_FEE;
  if (!(subtotal > 0)) {
    res.status(400).json({ error: 'Invalid cart total' });
    return;
  }

  const merchantId = process.env.PAYFAST_MERCHANT_ID;
  const merchantKey = process.env.PAYFAST_MERCHANT_KEY;
  const passphrase = process.env.PAYFAST_PASSPHRASE || '';
  const mode = process.env.PAYFAST_MODE || 'live';

  if (!merchantId || !merchantKey) {
    console.error('Missing PAYFAST_MERCHANT_ID or PAYFAST_MERCHANT_KEY env vars');
    res.status(500).json({ error: 'Payment configuration missing' });
    return;
  }

  const siteUrl = 'https://storm2020.co.za';
  const mPaymentId = `STORM-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { itemName, itemDescription } = summarizeCart(items);

  // PayFast has no native shipping-address field, so we pack it into the
  // custom_str fields it does support - these get echoed back to us in the
  // Notify URL (ITN) callback, so the address travels with the order.
  const addressLine = [shipping.address1, shipping.address2].filter(Boolean).join(', ');
  const cityLine = [shipping.city, shipping.province, shipping.postalCode, shipping.country].filter(Boolean).join(', ');

  const fields = {
    merchant_id: merchantId,
    merchant_key: merchantKey,
    return_url: `${siteUrl}/order-success.html`,
    cancel_url: `${siteUrl}/order-cancelled.html`,
    notify_url: `${siteUrl}/api/payfast-notify`,
    name_first: shipping.nameFirst,
    name_last: shipping.nameLast,
    email_address: shipping.email,
    m_payment_id: mPaymentId,
    amount: formatAmount(total),
    item_name: itemName,
    item_description: itemDescription,
    custom_str1: shipping.phone || '',
    custom_str2: addressLine.slice(0, 255),
    custom_str3: cityLine.slice(0, 255),
  };

  const signature = generateSignature(fields, passphrase);

  const actionUrl =
    mode === 'sandbox'
      ? 'https://sandbox.payfast.co.za/eng/process'
      : 'https://www.payfast.co.za/eng/process';

  console.log('Created PayFast payment request:', { m_payment_id: mPaymentId, amount: fields.amount });

  res.status(200).json({ actionUrl, fields: { ...fields, signature } });
}
