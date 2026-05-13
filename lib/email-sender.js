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

async function sendEmail({ to, subject, body, leadId, inReplyTo }) {
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
    const mailOptions = {
      from: `${senderName} <${senderEmail}>`,
      to,
      replyTo: replyTo || undefined,
      subject: subject || '(geen onderwerp)',
      html: htmlBody,
      text: body,
    };
    if (inReplyTo) {
      mailOptions.inReplyTo = inReplyTo;
      mailOptions.references = [inReplyTo];
    }
    const result = await client.sendMail(mailOptions);

    // Sla een kopie op in Gmail "Verzonden berichten" folder via IMAP append
    // (Gmail SMTP bewaart relayed mails NIET automatisch in Sent — daarom doen we dat zelf)
    try { await appendToSentFolder(mailOptions); }
    catch (e) { console.warn('IMAP append-to-Sent faalde (niet kritiek):', e.message); }

    db.logCommunication({
      lead_id: leadId,
      type: 'email',
      direction: 'outbound',
      subject,
      body,
      recipient: to,
      status: 'sent',
    });
    // Funnel auto-progress: bij eerste outbound mail → contacted
    if (leadId) db.advanceLeadStage(leadId, 'contacted');
    // Re-sync briefing-app als deze lead daar gekoppeld is
    if (leadId) {
      try { require('./lead-sync').syncLeadAsync(leadId); } catch {}
    }
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

// Append een kopie van de verzonden mail naar Gmail's "Verzonden berichten" folder
// via IMAP. Gmail SMTP relay bewaart relayed mails niet automatisch in Sent.
async function appendToSentFolder(mailOptions) {
  const host = process.env.IMAP_HOST || 'imap.gmail.com';
  const port = parseInt(process.env.IMAP_PORT || '993');
  const user = process.env.IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.IMAP_PASSWORD || process.env.SMTP_PASSWORD;
  if (!user || !pass) return;

  // Bouw de raw MIME-message via nodemailer's stream-transport
  const nodemailer = require('nodemailer');
  const streamTransport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const composed = await new Promise((resolve, reject) => {
    streamTransport.sendMail(mailOptions, (err, info) => {
      if (err) reject(err);
      else resolve(info.message); // Buffer met RFC822-source
    });
  });

  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
  await client.connect();
  try {
    // Probeer NL eerst, dan EN naam — Gmail toont de juiste naam afhankelijk van account-taal
    const candidates = ['[Gmail]/Verzonden berichten', '[Gmail]/Sent Mail', 'Sent'];
    let appended = false;
    for (const folder of candidates) {
      try {
        await client.append(folder, composed, ['\\Seen']);
        appended = true;
        break;
      } catch { /* probeer volgende */ }
    }
    if (!appended) console.warn('IMAP append: geen Sent-folder gevonden in', candidates.join(', '));
  } finally {
    try { await client.logout(); } catch {}
  }
}

module.exports = { sendEmail };
