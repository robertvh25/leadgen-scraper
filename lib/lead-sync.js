// lib/lead-sync.js - Sync lead-context naar briefing-app (idempotent)
const db = require('../db');
const briefingClient = require('./briefing-client');

async function syncLeadToBriefing(leadId) {
  const lead = db.getLead(leadId);
  if (!lead) return;
  if (!lead.briefing_slug) return; // Geen briefing aangemaakt, niks te syncen

  // Parse JSON-kolommen op lead
  for (const key of ['issues', 'tech_stack', 'emails']) {
    try { lead[key] = lead[key] ? (typeof lead[key] === 'string' ? JSON.parse(lead[key]) : lead[key]) : []; } catch { lead[key] = []; }
  }

  const communications = db.getLeadCommunications(leadId).reverse(); // oudst-eerst
  const bookings = db.getLeadBookings(leadId);
  const proto = process.env.SCREENSHOT_BASE_URL || 'https://leads.aitomade.nl';
  const screenshotUrl = lead.screenshot_path
    ? (lead.screenshot_path.startsWith('http') ? lead.screenshot_path : proto + lead.screenshot_path)
    : null;

  try {
    await briefingClient.syncLeadContext({
      slug: lead.briefing_slug,
      payload: {
        lead: {
          name: lead.name,
          address: lead.address,
          phone: lead.phone,
          website: lead.website,
          emails: lead.emails,
          branch_name: lead.branch_name,
          city_name: lead.city_name,
          replacement_score: lead.replacement_score,
          stage: lead.stage,
          issues: lead.issues,
          notes: lead.notes,
        },
        communications: communications.map(c => ({
          direction: c.direction,
          type: c.type,
          subject: c.subject,
          body: c.body,
          recipient: c.recipient,
          sent_at: c.sent_at,
          status: c.status,
        })),
        bookings: bookings.map(b => ({
          event_type: b.event_type,
          scheduled_at: b.scheduled_at,
          end_at: b.end_at,
          meet_url: b.meet_url,
          status: b.status,
        })),
        screenshot_url: screenshotUrl,
      },
    });
    return true;
  } catch (err) {
    console.error(`Lead-sync naar briefing-app faalde voor lead #${leadId}:`, err.message);
    return false;
  }
}

// Fire-and-forget variant — niet wachten, errors loggen
function syncLeadAsync(leadId) {
  syncLeadToBriefing(leadId).catch(err => console.error('Lead-sync async error:', err.message));
}

module.exports = { syncLeadToBriefing, syncLeadAsync };
