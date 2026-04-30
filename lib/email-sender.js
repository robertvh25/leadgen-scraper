// lib/email-sender.js - Verstuur emails via Resend
const db = require('../db');

let resendClient = null;

function getResendClient() {
  if (resendClient) return resendClient;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return null;
  }
  try {
    const { Resend } = require('resend');
    resendClient = new Resend(apiKey);
    return resendClient;
  } catch (err) {
    console.error('Resend init error:', err.message);
    return null;
  }
}

async function sendEmail({ to, subject, body, leadId }) {
  const settings = db.getAllSettings();
  const senderName = settings.sender_name || 'Lead Hunter';
  const senderEmail = settings.sender_email;
  const replyTo = settings.reply_to || senderEmail;

  if (!senderEmail) {
    throw new Error('Geen sender_email ingesteld in Instellingen');
  }
  if (!to) {
    throw new Error('Geen ontvanger opgegeven (lead heeft geen email gevonden)');
  }

  const client = getResendClient();
  if (!client) {
    throw new Error('Resend API key niet geconfigureerd. Voeg RESEND_API_KEY toe in Coolify env vars.');
  }

  // Convert plain-text body to simple HTML
  const htmlBody = body
    .split('\n\n')
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  try {
    const result = await client.emails.send({
      from: `${senderName} <${senderEmail}>`,
      to: [to],
      reply_to: replyTo || undefined,
      subject: subject || '(geen onderwerp)',
      html: htmlBody,
      text: body,
    });

    if (result.error) {
      throw new Error(result.error.message || 'Resend error');
    }

    db.logCommunication({
      lead_id: leadId,
      type: 'email',
      direction: 'outbound',
      subject,
      body,
      recipient: to,
      status: 'sent',
    });
    return { ok: true, id: result.data?.id };
  } catch (err) {
    db.logCommunication({
      lead_id: leadId,
      type: 'email',
      direction: 'outbound',
      subject,
      body,
      recipient: to,
      status: 'failed',
      error: err.message,
    });
    throw err;
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

module.exports = { sendEmail };
