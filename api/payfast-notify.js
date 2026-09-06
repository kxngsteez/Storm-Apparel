// api/payfast-notify.js
//
// This is your PayFast "Notify URL" (also called the ITN handler).
// PayFast's servers call this address directly — no customer ever sees it —
// to confirm a payment actually went through. This file checks that the
// notification is genuinely from PayFast before trusting it.
//
// Live URL once deployed:  https://storm2020.co.za/api/payfast-notify
//
// SETUP REQUIRED (in your Vercel project, not in this file):
// 1. Go to your Vercel project -> Settings -> Environment Variables
// 2. Add: PAYFAST_PASSPHRASE = the passphrase you set in your PayFast
//    account (Settings -> Integration -> Salt Passphrase). If you haven't
//    set one on PayFast yet, set one there first, then copy the exact
//    same value here.
// 3. Add: PAYFAST_MODE = live   (use "sandbox" while testing)
// 4. Redeploy after adding environment variables — they only apply to new
//    deployments.
//
// WHAT THIS FILE DOES:
// - Confirms the request came from a real PayFast server (IP check)
// - Confirms the data wasn't tampered with (signature check)
// - Double-checks with PayFast's own servers that the payment is real
//   (the official "validate" step PayFast requires)
// - Logs the result so you can see it in Vercel's function logs
//
// WHAT THIS FILE DOES NOT DO (yet):
// - It does not save the order anywhere (you don't have a database/order
//   system connected yet)
// - It does not email you or the customer
// - It does not check the paid amount against what the order should have
//   cost (there's currently nowhere this site records what an order
//   "should" cost, since checkout isn't wired up to PayFast yet)
//
// Once your checkout button actually submits a payment to PayFast, come
// back to this file (or ask for help) to add order-saving and email
// notifications.

import crypto from 'crypto';
import https from 'https';

// Official PayFast server IP ranges (from PayFast's developer docs).
// Only requests from these ranges are trusted.
const PAYFAST_IP_RANGES = [
  '197.97.145.144/28',
  '41.74.179.192/27',
  '102.216.36.0/28',
  '102.216.36.128/28',
  '144.126.193.139/32',
];

function ipToLong(ip) {
  return ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0) >>> 0;
}

function isIpInRange(ip, cidr) {
  const [range, bitsStr] = cidr.split('/');
  const bits = parseInt(bitsStr, 10);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  try {
    return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
  } catch {
    return false;
  }
}

function isValidPayfastIp(ip) {
  // Vercel may prefix forwarded IPs with ::ffff: — strip that if present.
  const clean = ip.replace('::ffff:', '');
  return PAYFAST_IP_RANGES.some((range) => isIpInRange(clean, range));
}

// Rebuilds PayFast's signature the same way they do: all posted fields,
// in the order they were sent, url-encoded, joined with &, with your
// passphrase appended — then MD5 hashed.
function generateSignature(fields, passphrase) {
  let pairs = [];
  for (const key in fields) {
    if (key === 'signature') continue;
    pairs.push(`${key}=${encodeURIComponent(fields[key].trim()).replace(/%20/g, '+')}`);
  }
  let paramString = pairs.join('&');
  if (passphrase) {
    paramString += `&passphrase=${encodeURIComponent(passphrase.trim()).replace(/%20/g, '+')}`;
  }
  return crypto.createHash('md5').update(paramString).digest('hex');
}

// PayFast requires you to post the data back to them so they can confirm
// it's genuine — this is their official "validate" step.
function validateWithPayfast(rawBody, mode) {
  const host = mode === 'sandbox' ? 'sandbox.payfast.co.za' : 'www.payfast.co.za';
  return new Promise((resolve) => {
    const req = https.request(
      {
        host,
        path: '/eng/query/validate',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(rawBody),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data.trim() === 'VALID'));
      }
    );
    req.on('error', () => resolve(false));
    req.write(rawBody);
    req.end();
  });
}

export const config = {
  api: {
    bodyParser: false, // we need the raw body for the validate step
  },
};

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const mode = process.env.PAYFAST_MODE || 'live';
  const passphrase = process.env.PAYFAST_PASSPHRASE || '';

  // Step 1: confirm the request came from PayFast's own servers.
  const forwarded = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
  const sourceIp = forwarded.split(',')[0].trim();
  if (mode !== 'sandbox' && !isValidPayfastIp(sourceIp)) {
    console.warn('PayFast ITN rejected: untrusted source IP', sourceIp);
    res.status(403).send('Forbidden: untrusted source IP');
    return;
  }

  const rawBody = await readRawBody(req);
  const params = new URLSearchParams(rawBody);
  const fields = {};
  for (const [key, value] of params.entries()) fields[key] = value;

  // Step 2: confirm the signature matches (data wasn't tampered with).
  const expectedSignature = generateSignature(fields, passphrase);
  if (fields.signature !== expectedSignature) {
    console.warn('PayFast ITN rejected: signature mismatch', {
      expected: expectedSignature,
      received: fields.signature,
    });
    res.status(400).send('Bad Request: invalid signature');
    return;
  }

  // Step 3: ask PayFast's own servers to confirm this notification is genuine.
  const confirmedByPayfast = await validateWithPayfast(rawBody, mode);
  if (!confirmedByPayfast) {
    console.warn('PayFast ITN rejected: failed PayFast validate check');
    res.status(400).send('Bad Request: failed validate check');
    return;
  }

  // All checks passed — this is a genuine PayFast payment notification.
  console.log('PayFast ITN verified OK:', {
    payment_status: fields.payment_status,
    m_payment_id: fields.m_payment_id,
    pf_payment_id: fields.pf_payment_id,
    amount_gross: fields.amount_gross,
    item_name: fields.item_name,
    email_address: fields.email_address,
  });

  // TODO (next step, once you're ready):
  // - Save this order somewhere (a database, a spreadsheet via an API, etc.)
  // - Send yourself and/or the customer a confirmation email
  // - Compare fields.amount_gross against what the order should have cost

  // PayFast just needs a 200 OK to know you received it.
  res.status(200).send('OK');
}
