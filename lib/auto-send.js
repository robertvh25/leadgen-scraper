// lib/auto-send.js - Verstuurt pending_actions met auto_send=1 zodra scheduled_for is verstreken
const db = require('../db');
const { sendEmail } = require('./email-sender');
const sendWindow = require('./send-window');

const POLL_INTERVAL_MS = 30 * 1000;

let running = false;

async function processDue() {
  // Veiligheidsnet: stuur ALLEEN tijdens send-window (ma-vr 09-22 NL)
  if (!sendWindow.isInSendWindow(new Date())) return;
  const due = db.getDuePendingActions();
  for (const action of due) {
    // email_reply NOOIT auto-send (Robert moet altijd approven)
    if (action.type === 'email_reply') continue;
    if (action.type !== 'email') continue;
    if (!action.recipient || !action.rendered_body) {
      db.updatePendingActionStatus(action.id, 'failed');
      console.warn(`Auto-send: pending #${action.id} mist recipient of body, gemarkeerd als failed`);
      continue;
    }
    try {
      await sendEmail({
        to: action.recipient,
        subject: action.rendered_subject,
        body: action.rendered_body,
        leadId: action.lead_id,
        inReplyTo: action.in_reply_to_message_id || null,
      });
      db.updatePendingActionStatus(action.id, 'sent');
      console.log(`✓ Auto-reply verzonden naar ${action.recipient} (lead "${action.lead_name}")`);
    } catch (err) {
      db.updatePendingActionStatus(action.id, 'failed');
      console.error(`✗ Auto-send fout voor pending #${action.id}: ${err.message}`);
    }
  }
}

async function loop() {
  while (running) {
    try {
      await processDue();
    } catch (e) {
      console.error('Auto-send loop error:', e.message);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
}

function start() {
  if (running) return;
  running = true;
  loop().catch(e => console.error('Auto-send crashed:', e));
  console.log('🤖 Auto-send worker gestart (poll elke 30s)');
}

function stop() { running = false; }

module.exports = { start, stop, processDue };
