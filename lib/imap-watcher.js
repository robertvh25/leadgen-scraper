// lib/imap-watcher.js - Pollt Gmail label voor nieuwe replies
const db = require('../db');
const aiReply = require('./ai-reply');

const POLL_INTERVAL_MS = 60 * 1000;
const REPLY_DELAY_MINUTES = parseInt(process.env.REPLY_DELAY_MINUTES || '5');

let running = false;
let pollTimer = null;

let resolvedLabelPath = null;
let labelListLogged = false;

async function resolveLabelPath(client, requestedLabel) {
  if (resolvedLabelPath) return resolvedLabelPath;
  const boxes = await client.list();
  if (!labelListLogged) {
    console.log('📂 IMAP mailboxes beschikbaar:');
    for (const b of boxes) console.log(`   - ${b.path}${b.specialUse ? '  ['+b.specialUse+']' : ''}`);
    labelListLogged = true;
  }
  // Direct match
  let match = boxes.find(b => b.path === requestedLabel);
  if (match) { resolvedLabelPath = match.path; return match.path; }
  // Case-insensitive of als sub-label
  match = boxes.find(b => b.path.toLowerCase() === requestedLabel.toLowerCase());
  if (match) { resolvedLabelPath = match.path; return match.path; }
  match = boxes.find(b => b.name && b.name.toLowerCase() === requestedLabel.toLowerCase());
  if (match) { resolvedLabelPath = match.path; return match.path; }
  // Probeer Gmail-specific paths
  const candidates = [`[Gmail]/${requestedLabel}`, `INBOX/${requestedLabel}`, `INBOX.${requestedLabel}`];
  for (const c of candidates) {
    if (boxes.find(b => b.path === c)) { resolvedLabelPath = c; return c; }
  }
  return null;
}

async function pollOnce() {
  const host = process.env.IMAP_HOST || 'imap.gmail.com';
  const port = parseInt(process.env.IMAP_PORT || '993');
  const user = process.env.IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.IMAP_PASSWORD || process.env.SMTP_PASSWORD;
  const label = process.env.IMAP_LABEL || 'Leads';

  if (!user || !pass) return;

  const { ImapFlow } = require('imapflow');
  const { simpleParser } = require('mailparser');

  const client = new ImapFlow({
    host, port, secure: true,
    auth: { user, pass },
    logger: false,
  });

  try {
    await client.connect();
    const path = await resolveLabelPath(client, label);
    if (!path) {
      console.error(`IMAP: label "${label}" niet gevonden in mailbox-lijst. Check Gmail label-naam.`);
      return;
    }
    let lock = await client.getMailboxLock(path);
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      if (!uids || uids.length === 0) return;
      console.log(`📬 IMAP: ${uids.length} nieuwe reply(s) in ${path}`);

      for (const uid of uids) {
        try {
          const message = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
          const parsed = await simpleParser(message.source);
          await handleReply(parsed);
        } catch (e) {
          console.error(`IMAP parse error voor UID ${uid}:`, e.message);
        }
        await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
      }
    } finally {
      lock.release();
    }
  } catch (err) {
    console.error(`IMAP error: ${err.message}${err.code ? ' (code: '+err.code+')' : ''}${err.responseText ? ' — '+err.responseText : ''}`);
  } finally {
    try { await client.logout(); } catch {}
  }
}

async function handleReply(parsed) {
  const fromAddr = parsed.from?.value?.[0]?.address?.toLowerCase();
  const fromName = parsed.from?.value?.[0]?.name || '';
  if (!fromAddr) return;

  // Skip automated mails
  const subject = parsed.subject || '';
  if (/auto[- ]?reply|out of office|delivery (failure|status)|undeliverable|mailer-daemon/i.test(subject)) {
    console.log(`  ↪ Skip auto-reply van ${fromAddr}`);
    return;
  }
  if (parsed.headers.get('auto-submitted') && parsed.headers.get('auto-submitted') !== 'no') {
    console.log(`  ↪ Skip auto-submitted van ${fromAddr}`);
    return;
  }

  // Match lead op email
  const lead = db.findLeadByEmail(fromAddr);
  if (!lead) {
    console.log(`  ↪ Geen lead match voor ${fromAddr}, mail genegeerd`);
    return;
  }

  // Log inbound communication
  const bodyText = parsed.text || (parsed.html ? parsed.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '');
  db.logCommunication({
    lead_id: lead.id,
    type: 'email',
    direction: 'inbound',
    subject,
    body: bodyText,
    recipient: parsed.to?.text || '',
    status: 'received',
  });

  // Skip als al een pending auto-reply staat voor deze lead
  const existingPending = db.getPendingActions().find(a =>
    a.lead_id === lead.id && a.type === 'email_reply' && a.status === 'pending'
  );
  if (existingPending) {
    console.log(`  ↪ Lead ${lead.id} heeft al pending auto-reply, skip`);
    return;
  }

  // Genereer AI antwoord
  let replyResult;
  try {
    replyResult = await aiReply.generateReply({ lead, inboundSubject: subject, inboundBody: bodyText });
  } catch (e) {
    console.error(`AI reply error voor lead ${lead.id}:`, e.message);
    return;
  }
  const replyBody = replyResult.body;
  if (!replyBody) {
    console.warn(`Lege AI body voor lead ${lead.id}, skip`);
    return;
  }

  // Bepaal reply subject (Re: <origineel>)
  const replySubject = /^re:/i.test(subject) ? subject : `Re: ${subject}`;

  // Schedule auto-send met delay
  const scheduledFor = new Date(Date.now() + REPLY_DELAY_MINUTES * 60 * 1000).toISOString();
  db.addPendingAction({
    lead_id: lead.id,
    type: 'email_reply',
    rendered_subject: replySubject,
    rendered_body: replyBody,
    recipient: fromAddr,
    scheduled_for: scheduledFor,
    auto_send: 1,
    in_reply_to_message_id: parsed.messageId || null,
  });

  console.log(`  ↪ Auto-reply gepland voor "${lead.name}" (${fromAddr}) over ${REPLY_DELAY_MINUTES} min`);
}

async function loop() {
  while (running) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('IMAP loop error:', e.message);
    }
    await new Promise(r => { pollTimer = setTimeout(r, POLL_INTERVAL_MS); });
  }
}

function start() {
  if (running) return;
  if (!process.env.IMAP_USER && !process.env.SMTP_USER) {
    console.log('📭 IMAP-watcher: geen credentials, niet gestart');
    return;
  }
  running = true;
  loop().catch(e => console.error('IMAP watcher crashed:', e));
  console.log('📬 IMAP-watcher gestart (label: ' + (process.env.IMAP_LABEL || 'Leads') + ')');
}

function stop() {
  running = false;
  if (pollTimer) clearTimeout(pollTimer);
}

module.exports = { start, stop, pollOnce };
