// lib/email-sender.js - Verstuur emails via Gmail / Google Workspace SMTP
const db = require('../db');

let transporter = null;

function getTransporter() {
  if (transporter) return transporter;
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587');
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASSWORD;
  if (!host || !user || !pass) {
    return null;
  }
  try {
    const nodemailer = require('nodemailer');
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465, // 465 = SSL, 587 = STARTTLS
      auth: { user, pass },
    });
    return transporter;
  } catch (err) {
    console.error('Nodemailer init error:', err.message);
    return null;
  }
}

async function sendEmail({ to, subject, body, leadId }) {
  const settings = db.getAllSettings();
  const senderName = settings.sender_name || 'Lead Hunter';
  const senderEmail = settings.sender_email || process.env.SMTP_USER;
  const replyTo = settings.reply_to || senderEmail;

  if (!senderEmail) {
    throw new Error('Geen sender_email ingesteld in Instellingen');
  }
  if (!to) {
    throw new Error('Geen ontvanger opgegeven (lead heeft geen email gevonden)');
  }

  const client = getTransporter();
  if (!client) {
    throw new Error('SMTP niet geconfigureerd. Zet SMTP_HOST/SMTP_USER/SMTP_PASSWORD in Coolify env vars.');
  }

  // Convert plain-text body to simple HTML
  const htmlBody = body
    .split('\n\n')
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  try {
    const result = await client.sendMail({
      from: `${senderName} <${senderEmail}>`,
      to,
      replyTo: replyTo || undefined,
      subject: subject || '(geen onderwerp)',
      html: htmlBody,
      text: body,
    });

    db.logCommunication({
      lead_id: leadId,
      type: 'email',
      direction: 'outbound',
      subject,
      body,
      recipient: to,
      status: 'sent',
    });
    return { ok: true, id: result.messageId };
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
