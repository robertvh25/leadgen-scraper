// lib/sequence-engine.js - Verwerkt actieve campagnes en plant pending acties
const db = require('../db');
const { render } = require('./template-renderer');

let processing = false;

/**
 * Loop door alle actieve campaigns en check of de volgende stap
 * gepland moet worden in de pending_actions queue.
 */
function processCampaigns() {
  if (processing) return;
  processing = true;

  try {
    const active = db.getActiveCampaigns();

    for (const camp of active) {
      const lead = db.getLead(camp.lead_id);
      if (!lead) continue;

      // Stop campaign als lead in 'lost' of 'project' stage zit
      if (['lost', 'project', 'signed'].includes(lead.stage)) {
        db.completeCampaign(camp.id);
        continue;
      }

      const steps = db.getSequenceSteps(camp.sequence_id);
      const nextStepIndex = camp.current_step;

      if (nextStepIndex >= steps.length) {
        db.completeCampaign(camp.id);
        continue;
      }

      const step = steps[nextStepIndex];

      // Check of deze stap al een pending action heeft
      const existing = db.db.prepare(
        `SELECT * FROM pending_actions WHERE campaign_id = ? AND step_id = ?`
      ).get(camp.id, step.id);
      if (existing) continue;

      // Bereken scheduled_for
      const baseTime = camp.last_action_at
        ? new Date(camp.last_action_at + 'Z').getTime()
        : new Date(camp.started_at + 'Z').getTime();
      const scheduledFor = new Date(baseTime + (step.delay_days * 24 * 60 * 60 * 1000));

      // Render template
      const tmpl = db.getTemplate(step.template_id);
      if (!tmpl) continue;

      const renderedSubject = tmpl.subject ? render(tmpl.subject, lead) : null;
      const renderedBody = render(tmpl.body, lead);

      // Bepaal recipient
      let recipient = null;
      if (tmpl.type === 'email') {
        try {
          const emails = lead.emails ? JSON.parse(lead.emails) : [];
          recipient = emails[0] || null;
        } catch {}
      } else if (tmpl.type === 'whatsapp') {
        recipient = lead.phone;
      }

      db.addPendingAction({
        lead_id: camp.lead_id,
        campaign_id: camp.id,
        step_id: step.id,
        type: tmpl.type,
        template_id: tmpl.id,
        rendered_subject: renderedSubject,
        rendered_body: renderedBody,
        recipient,
        scheduled_for: scheduledFor.toISOString(),
        // Respecteer per-step require_approval flag: 0 = auto-send, 1 = wacht op review
        auto_send: step.require_approval ? 0 : 1,
      });
    }
  } catch (err) {
    console.error('Campaign processor error:', err);
  } finally {
    processing = false;
  }
}

/**
 * Start campaign voor lead (handmatig of bij stage change)
 */
function startCampaignForLead(leadId, sequenceId) {
  const result = db.startLeadCampaign(leadId, sequenceId);
  if (result.changes > 0) {
    processCampaigns();
    return true;
  }
  return false;
}

/**
 * Auto-start campaigns wanneer lead naar bepaalde stage gaat
 */
function autoStartCampaignsForStage(leadId, stage) {
  const seqs = db.db.prepare(
    `SELECT id FROM sequences WHERE enabled = 1 AND trigger_stage = ?`
  ).all(stage);

  for (const seq of seqs) {
    db.startLeadCampaign(leadId, seq.id);
  }
  processCampaigns();
}

let intervalHandle = null;
function startEngine() {
  if (intervalHandle) return;
  // Process elke 60 sec
  intervalHandle = setInterval(processCampaigns, 60 * 1000);
  console.log('✓ Sequence engine gestart (60s interval)');
}

function stopEngine() {
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = null;
}

module.exports = {
  processCampaigns,
  startCampaignForLead,
  autoStartCampaignsForStage,
  startEngine,
  stopEngine,
};
