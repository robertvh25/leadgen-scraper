// lib/whatsapp-sender.js - WhatsApp via Twilio
const db = require('../db');

let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) return null;
  try {
    twilioClient = require('twilio')(sid, token);
    return twilioClient;
  } catch (err) {
    console.error('Twilio init error:', err.message);
    return null;
  }
}

function normalizePhone(phone) {
  if (!phone) return null;
  // Strip alles behalve cijfers en +
  let p = phone.replace(/[^\d+]/g, '');
  // NL-formaat: 06... → +316...
  if (/^06\d{8}$/.test(p)) p = '+31' + p.substring(1);
  if (/^0[1-9]\d{7,8}$/.test(p)) p = '+31' + p.substring(1);
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

async function sendWhatsApp({ to, body, leadId }) {
  const fromNumber = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // Twilio sandbox

  const phone = normalizePhone(to);
  if (!phone) throw new Error('Geen geldig telefoonnummer');

  const client = getTwilioClient();
  if (!client) {
    throw new Error('Twilio niet geconfigureerd. Voeg TWILIO_ACCOUNT_SID en TWILIO_AUTH_TOKEN toe.');
  }

  try {
    const msg = await client.messages.create({
      from: fromNumber,
      to: `whatsapp:${phone}`,
      body,
    });
    db.logCommunication({
      lead_id: leadId, type: 'whatsapp', direction: 'outbound',
      body, recipient: phone, status: 'sent',
    });
    return { ok: true, sid: msg.sid };
  } catch (err) {
    db.logCommunication({
      lead_id: leadId, type: 'whatsapp', direction: 'outbound',
      body, recipient: phone, status: 'failed', error: err.message,
    });
    throw err;
  }
}

// Genereer een wa.me link (manual fallback)
function buildWhatsAppLink(phone, message) {
  const p = normalizePhone(phone);
  if (!p) return null;
  return `https://wa.me/${p.replace(/^\+/, '')}?text=${encodeURIComponent(message)}`;
}

module.exports = { sendWhatsApp, normalizePhone, buildWhatsAppLink };
