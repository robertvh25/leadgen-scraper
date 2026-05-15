// =============================================================================
// briefing-sync.js
// =============================================================================
// Bi-directionele status-sync tussen leadgen-scraper en briefing-app.
//
// Leadgen-stages → Briefing-status (push richting briefing-app)
// Briefing-status → Leadgen-stage (ontvangst van briefing-app)
//
// Loop-prevention: bij ontvangst van een wijziging die 'source' bevat met
// 'from-briefing' of 'from-leadgen', pushen we niet terug.
// =============================================================================

const db = require('../db');

const BRIEFING_BASE = process.env.BRIEFING_BASE_URL || 'https://briefing.aitomade.nl';

// Leadgen → Briefing (welke briefing-status hoort bij elke leadgen-stage)
const STAGE_TO_BRIEFING = {
  new:             'pending',
  contacted:       'submitted',
  engaged:         'submitted',
  mockup_creating: 'mockup',
  mockup_sent:     'mockup-verstuurd',
  meeting_planned: 'submitted',
  offerte:         'mockup-akkoord',
  project:         'bootstrap',
  lost:            'archived',
};

// Briefing → Leadgen (welke leadgen-stage hoort bij elke briefing-status)
const BRIEFING_TO_STAGE = {
  'pending':          'new',
  'submitted':        'engaged',
  'benaderd':         'contacted',
  'in-gesprek':       'engaged',
  'mockup':           'mockup_creating',
  'mockup-verstuurd': 'mockup_sent',
  'mockup-akkoord':   'mockup_sent',  // geen aparte 'akkoord'-stage in leadgen
  'meeting-gepland':  'meeting_planned',
  'offerte':          'offerte',
  'project':          'project',
  'bootstrap':        'project',
  'content':          'project',
  'staging':          'project',
  'live':             'project',      // leadgen heeft geen 'live'; stays project
  'on-hold':          null,           // geen mapping — skip sync
  'archived':         'lost',
};

/**
 * Push een leadgen-stage-wijziging naar briefing-app.
 * Skip als bron uit briefing-sync zelf komt (loop-prevention).
 * Fire-and-forget — fouten worden gelogd maar niet teruggegeven.
 */
async function pushStageToBriefing(leadId, leadgenStage, source = 'leadgen') {
  if (typeof source === 'string' && source.includes('from-briefing')) {
    return { skipped: 'loop-prevention', source };
  }
  const lead = db.getLead(leadId);
  if (!lead) return { skipped: 'lead-not-found' };
  if (!lead.briefing_slug) return { skipped: 'no-briefing-slug' };

  const targetStatus = STAGE_TO_BRIEFING[leadgenStage];
  if (!targetStatus) return { skipped: 'no-mapping', leadgenStage };

  const token = process.env.BRIEFING_API_TOKEN;
  if (!token) {
    console.warn('briefing-sync: BRIEFING_API_TOKEN ontbreekt — skip push');
    return { skipped: 'no-token' };
  }

  const body = new URLSearchParams({
    token,
    ref:    lead.briefing_slug,
    status: targetStatus,
    source: 'from-leadgen:' + source,
  }).toString();

  try {
    const r = await fetch(`${BRIEFING_BASE}/?action=set-status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await r.text();
    if (!r.ok) {
      console.warn(`briefing-sync: push lead#${leadId} (${leadgenStage}→${targetStatus}) HTTP ${r.status}: ${text.slice(0,200)}`);
      return { ok: false, http: r.status, body: text };
    }
    console.log(`📊 briefing-sync: lead#${leadId} ${leadgenStage} → briefing ${lead.briefing_slug}:${targetStatus}`);
    return { ok: true, leadgenStage, briefingStatus: targetStatus };
  } catch (err) {
    console.warn(`briefing-sync: push error lead#${leadId}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

/**
 * Ontvang een briefing-status-wijziging en update lead-stage.
 * Returns: { ok, leadId?, oldStage?, newStage?, skipped? }
 */
function applyBriefingStatusToLead(briefingSlug, briefingStatus) {
  const stmt = db.db.prepare(`SELECT * FROM leads WHERE briefing_slug = ? ORDER BY created_at DESC LIMIT 1`);
  const lead = stmt.get(briefingSlug);
  if (!lead) return { ok: false, skipped: 'no-lead-for-slug', slug: briefingSlug };

  const targetStage = BRIEFING_TO_STAGE[briefingStatus];
  if (!targetStage) return { ok: false, skipped: 'no-mapping', briefingStatus };

  if (lead.stage === targetStage) {
    return { ok: true, skipped: 'no-change', leadId: lead.id, stage: targetStage };
  }

  if (targetStage === 'lost') {
    db.markLeadLost(lead.id, `Briefing-status: ${briefingStatus}`);
    return { ok: true, leadId: lead.id, oldStage: lead.stage, newStage: 'lost' };
  }

  // Probeer advance (guard tegen achterwaarts gaan)
  const advanced = db.advanceLeadStage(lead.id, targetStage);
  if (advanced) {
    return { ok: true, leadId: lead.id, oldStage: lead.stage, newStage: targetStage };
  }
  // Advance weigerde (lead al verder of lost) — geen update
  return { ok: true, skipped: 'leadgen-already-past-or-lost', leadId: lead.id, currentStage: lead.stage, requestedStage: targetStage };
}

module.exports = {
  pushStageToBriefing,
  applyBriefingStatusToLead,
  STAGE_TO_BRIEFING,
  BRIEFING_TO_STAGE,
};
