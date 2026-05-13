// lib/sent-dedupe.js — vindt en (optioneel) verwijdert dubbele mails in de
// Verzonden-folder van Gmail/Workspace, ontstaan door de oude IMAP-append
// bovenop de auto-save van Gmail SMTP. Verplaatst naar Trash, niet EXPUNGE,
// zodat alles 30 dagen recoverable blijft.

async function findSentFolder(client) {
  const candidates = ['[Gmail]/Verzonden berichten', '[Gmail]/Sent Mail', 'Sent'];
  for (const f of candidates) {
    try { await client.mailboxOpen(f, { readOnly: true }); return f; } catch {}
  }
  return null;
}

async function findTrashFolder(client) {
  const candidates = ['[Gmail]/Prullenbak', '[Gmail]/Trash', '[Gmail]/Bin', 'Trash'];
  for (const f of candidates) {
    try { await client.status(f, { messages: true }); return f; } catch {}
  }
  return null;
}

// Vindt dubbele mails: zelfde (To, Subject) + binnen `maxSecondsBetween`
// van elkaar. De LATERE wordt als dup beschouwd, de oudste blijft staan.
// `days` = scope: alleen mails uit de laatste N dagen.
async function dedupeSentFolder({ days = 30, maxSecondsBetween = 60, apply = false }) {
  const host = process.env.IMAP_HOST || 'imap.gmail.com';
  const port = parseInt(process.env.IMAP_PORT || '993');
  const user = process.env.IMAP_USER || process.env.SMTP_USER;
  const pass = process.env.IMAP_PASSWORD || process.env.SMTP_PASSWORD;
  if (!user || !pass) throw new Error('IMAP_USER/PASSWORD niet ingesteld');

  const { ImapFlow } = require('imapflow');
  const client = new ImapFlow({ host, port, secure: true, auth: { user, pass }, logger: false });
  await client.connect();

  try {
    const sentFolder = await findSentFolder(client);
    if (!sentFolder) throw new Error('Sent-folder niet gevonden');

    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const messages = [];
    for await (const msg of client.fetch({ since }, { envelope: true, internalDate: true, uid: true })) {
      const to = ((msg.envelope?.to || []).map(t => (t.address || '').toLowerCase()).sort().join(','));
      messages.push({
        uid: msg.uid,
        subject: (msg.envelope?.subject || '').trim(),
        to,
        date: msg.internalDate || msg.envelope?.date || new Date(0),
      });
    }

    // Groepeer per (to, subject)
    const groups = new Map();
    for (const m of messages) {
      const key = `${m.to}|||${m.subject}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }

    // Vind dup-paren (consecutief in tijd, binnen maxSecondsBetween)
    const dupes = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.date - b.date);
      for (let i = 1; i < group.length; i++) {
        const diffSec = (group[i].date - group[i - 1].date) / 1000;
        if (diffSec <= maxSecondsBetween) dupes.push(group[i]);
      }
    }

    if (!apply) {
      return {
        sent_folder: sentFolder,
        scanned_in_range: messages.length,
        duplicates_found: dupes.length,
        sample: dupes.slice(0, 10).map(d => ({
          uid: d.uid,
          to: d.to,
          subject: d.subject,
          date: new Date(d.date).toISOString(),
        })),
      };
    }

    if (dupes.length === 0) {
      return { sent_folder: sentFolder, scanned_in_range: messages.length, duplicates_found: 0, moved_to_trash: 0 };
    }

    // Heropen folder schrijfbaar
    await client.mailboxClose();
    await client.mailboxOpen(sentFolder, { readOnly: false });

    const trashFolder = await findTrashFolder(client);
    if (!trashFolder) throw new Error('Trash-folder niet gevonden — niets verplaatst');

    let moved = 0;
    const uids = dupes.map(d => d.uid);
    for (let i = 0; i < uids.length; i += 100) {
      const batch = uids.slice(i, i + 100);
      try {
        const result = await client.messageMove(batch, trashFolder, { uid: true });
        moved += result?.uidMap ? result.uidMap.size : batch.length;
      } catch (e) {
        // Volgende batch proberen i.p.v. heel proces opblazen
        console.warn('dedupe-sent: batch move faalde:', e.message);
      }
    }

    return {
      sent_folder: sentFolder,
      scanned_in_range: messages.length,
      duplicates_found: dupes.length,
      moved_to_trash: moved,
      trash_folder: trashFolder,
    };
  } finally {
    try { await client.logout(); } catch {}
  }
}

module.exports = { dedupeSentFolder };
