// server.js - Express API + scheduler + sequence engine + auth
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { scrapeGoogleMaps } = require('./scraper');
const { analyzeWebsite, scrapeEmailsForUrl, enrichWithVisual } = require('./analyzer');
const { takeScreenshot, getScreenshotDir } = require('./lib/screenshot');
const { render, listAvailableVars } = require('./lib/template-renderer');
const { sendEmail } = require('./lib/email-sender');
const { sendWhatsApp, buildWhatsAppLink, normalizePhone } = require('./lib/whatsapp-sender');
const sequenceEngine = require('./lib/sequence-engine');
const auth = require('./lib/auth');
const db = require('./db');
const scheduler = require('./scheduler');
const imapWatcher = require('./lib/imap-watcher');
const autoSend = require('./lib/auto-send');
const briefingClient = require('./lib/briefing-client');
const leadSync = require('./lib/lead-sync');
const briefingSync = require('./lib/briefing-sync');
const sendWindow = require('./lib/send-window');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // Belangrijk: voor secure cookies achter Traefik
app.use(cors());
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({
  limit: '2mb',
  verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); },
}));
app.use(cookieParser());

// === LOGIN PAGES (PUBLIC) ===
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Health (public)
app.get('/health', (_, res) => res.json({ ok: true }));

// === CAL.COM WEBHOOK (PUBLIC, HMAC-verified) ===
app.post('/api/webhook/calcom', (req, res) => {
  const crypto = require('crypto');
  const secret = process.env.CALCOM_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('Cal.com webhook: CALCOM_WEBHOOK_SECRET niet gezet, weiger payload');
    return res.status(503).json({ error: 'webhook not configured' });
  }
  const sig = req.headers['x-cal-signature-256'] || req.headers['x-signature-256'] || '';
  const expected = crypto.createHmac('sha256', secret).update(req.rawBody || '').digest('hex');
  if (sig !== expected) {
    console.warn('Cal.com webhook: ongeldige signature, geweigerd');
    return res.status(403).json({ error: 'invalid signature' });
  }
  const event = req.body || {};
  const trigger = event.triggerEvent || event.event || '';
  const p = event.payload || {};

  const attendee = (p.attendees || [])[0] || {};
  const attendeeEmail = (attendee.email || '').toLowerCase();
  let leadId = null;
  if (attendeeEmail) {
    const lead = db.findLeadByEmail(attendeeEmail);
    if (lead) leadId = lead.id;
  }
  const meetUrl = p.metadata?.videoCallUrl || p.location || '';
  const uid = p.uid || p.bookingId || `noid-${Date.now()}`;

  if (trigger === 'BOOKING_CREATED' || trigger === 'BOOKING_RESCHEDULED') {
    db.upsertBooking({
      lead_id: leadId,
      calcom_uid: uid,
      event_type: p.type || p.eventTypeId || '',
      scheduled_at: p.startTime || null,
      end_at: p.endTime || null,
      attendee_email: attendeeEmail,
      attendee_name: attendee.name || '',
      meet_url: meetUrl,
      location: typeof p.location === 'string' ? p.location : '',
      status: 'confirmed',
      raw_payload: JSON.stringify(event).slice(0, 50000),
    });
    if (leadId) {
      db.advanceLeadStage(leadId, 'meeting_planned');
      const when = p.startTime ? new Date(p.startTime).toLocaleString('nl-NL', { dateStyle: 'long', timeStyle: 'short' }) : 'onbekend';
      db.logCommunication({
        lead_id: leadId,
        type: 'booking',
        direction: 'inbound',
        subject: `📅 Meeting geboekt: ${p.title || p.type || 'gesprek'}`,
        body: `Datum: ${when}\nMet: ${attendee.name || attendeeEmail}\nMeet-link: ${meetUrl || '(niet beschikbaar)'}\n\nGeboekt via Cal.com.`,
        recipient: attendeeEmail,
        status: 'received',
      });
    }
    console.log(`📅 Booking ${trigger}: ${attendee.name || attendeeEmail} ${p.startTime || ''}${leadId ? ` → lead #${leadId}` : ' (geen lead-match)'}`);
    if (leadId) leadSync.syncLeadAsync(leadId);
  } else if (trigger === 'BOOKING_CANCELLED') {
    db.setBookingStatus(uid, 'cancelled');
    if (leadId) {
      db.logCommunication({
        lead_id: leadId,
        type: 'booking',
        direction: 'inbound',
        subject: '❌ Meeting geannuleerd',
        body: `Lead heeft de afspraak geannuleerd via Cal.com.`,
        recipient: attendeeEmail,
        status: 'received',
      });
      leadSync.syncLeadAsync(leadId);
    }
    console.log(`📅 Booking CANCELLED: ${uid}`);
  } else {
    console.log(`Cal.com webhook: onbekend event ${trigger}, genegeerd`);
  }
  res.json({ ok: true });
});

// === WEBSITE-FORM WEBHOOK (PUBLIC, bearer-token-verified) ===
// Inbound leads vanuit aitomade.nl hero-formulier (en eventueel andere bureau-sites).
// Bearer-token = BRIEFING_API_TOKEN (zelfde token als die de briefing-app gebruikt voor
// inkomende sync vanuit deze app — bidirectioneel hergebruikt).
//
// Body (form-encoded of JSON):
//   token         — bearer-auth, verplicht
//   name          — bedrijfsnaam, verplicht
//   email         — verplicht
//   phone         — optioneel
//   website       — huidige website-URL, optioneel
//   source        — herkomst-label, default 'aitomade-form'
//   note          — opmerking voor in notes, default 'Mockup aangevraagd via website'
app.post('/api/webhook/website-form', (req, res) => {
  const expected = process.env.BRIEFING_API_TOKEN;
  if (!expected) {
    console.warn('Website-form webhook: BRIEFING_API_TOKEN niet gezet, weiger payload');
    return res.status(503).json({ error: 'webhook not configured' });
  }
  const token = req.body?.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token !== expected) {
    return res.status(403).json({ error: 'invalid token' });
  }
  const name = String(req.body?.name || '').trim();
  const email = String(req.body?.email || '').trim().toLowerCase();
  const phone = String(req.body?.phone || '').trim();
  const website = String(req.body?.website || '').trim();
  const source = String(req.body?.source || 'aitomade-form').trim();
  const note = String(req.body?.note || 'Mockup aangevraagd via website').trim();

  if (!name || !email) {
    return res.status(400).json({ error: 'name en email zijn verplicht' });
  }

  try {
    const result = db.addWebsiteLead({ name, email, phone, website, source, noteLine: note });
    // Log een inbound-communication zodat 't in de lead-tijdlijn verschijnt
    db.logCommunication({
      lead_id: result.id,
      type: 'website-form',
      direction: 'inbound',
      subject: `📩 ${note}`,
      body: `Naam: ${name}\nEmail: ${email}\nTelefoon: ${phone || '(niet opgegeven)'}\nHuidige website: ${website || '(niet opgegeven)'}\n\nBron: ${source}`,
      recipient: email,
      status: 'received',
    });
    console.log(`📩 Website-form lead ${result.action}: ${name} <${email}> → #${result.id} (source=${source})`);
    res.json({ ok: true, lead_id: result.id, action: result.action, stage: 'engaged' });
  } catch (err) {
    console.error('Website-form webhook error:', err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// === BRIEFING → LEADGEN STATUS-SYNC WEBHOOK ===
// Briefing-app post een status-wijziging hier naartoe (via update_client_status).
// Auth: BRIEFING_API_TOKEN bearer.
// Body: token, briefing_slug, briefing_status, source (optioneel)
app.post('/api/webhook/briefing-status', (req, res) => {
  const expected = process.env.BRIEFING_API_TOKEN;
  if (!expected) {
    return res.status(503).json({ error: 'webhook not configured' });
  }
  const token = req.body?.token || (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (token !== expected) {
    return res.status(403).json({ error: 'invalid token' });
  }
  const slug = String(req.body?.briefing_slug || req.body?.ref || '').trim().toLowerCase();
  const briefingStatus = String(req.body?.briefing_status || req.body?.status || '').trim().toLowerCase();
  if (!slug || !briefingStatus) {
    return res.status(400).json({ error: 'briefing_slug en briefing_status zijn vereist' });
  }
  try {
    const result = briefingSync.applyBriefingStatusToLead(slug, briefingStatus);
    if (result.ok && result.newStage) {
      console.log(`📥 briefing-sync: ${slug}:${briefingStatus} → lead#${result.leadId} stage ${result.oldStage} → ${result.newStage}`);
    } else if (result.skipped) {
      console.log(`📥 briefing-sync: ${slug}:${briefingStatus} skipped (${result.skipped})`);
    }
    res.json(result);
  } catch (err) {
    console.error('briefing-status webhook error:', err);
    res.status(500).json({ error: 'internal error', detail: err.message });
  }
});

// === AUTH ENDPOINTS ===
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  message: { error: 'Te veel pogingen, probeer later opnieuw' },
  standardHeaders: true,
});

app.post('/api/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username en wachtwoord vereist' });
  }
  try {
    const session = await auth.login(username, password);
    res.cookie('session', session.token, {
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });
    res.json({ ok: true, username: session.username });
  } catch (err) {
    // Vertraag respons om timing attacks te bemoeilijken
    await new Promise(r => setTimeout(r, 300 + Math.random() * 400));
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  const token = req.cookies?.session;
  if (token) auth.logout(token);
  res.clearCookie('session');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  if (!auth.isAuthEnabled()) {
    return res.json({ authenticated: true, username: 'guest', authDisabled: true });
  }
  const session = auth.validateSession(req.cookies?.session);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: session.username });
});

// === EVERYTHING BELOW REQUIRES AUTH ===

// Static files (login.html is al public hierboven)
app.use(express.static(path.join(__dirname, 'public'), {
  index: false, // we serven index.html handmatig met auth
}));

// Serve screenshots — alleen voor ingelogde users
app.use('/screenshots', auth.requireAuth, express.static(getScreenshotDir()));

// Hoofdpagina vereist auth
app.get('/', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.get('/index.html', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API: alle volgende endpoints achter requireAuthAPI
app.use('/api', (req, res, next) => {
  // Skip auth check voor de routes die al hierboven staan (login/logout/me)
  // Die hebben al gematcht voor deze middleware
  return auth.requireAuthAPI(req, res, next);
});

// === DASHBOARD ===
app.get('/api/dashboard', (req, res) => {
  const threshold = parseInt(db.getSetting('high_score_threshold') || '40');
  const stats = db.getDashboardStats();
  try {
    stats.high_score_leads = db.db.prepare(`SELECT COUNT(*) AS c FROM leads WHERE replacement_score >= ? AND stage = 'new' AND emails IS NOT NULL AND emails != '[]' AND emails != ''`).get(threshold).c;
  } catch {}
  res.json({
    stats,
    queue: db.getQueueStats(),
    scheduler: scheduler.getStatus(),
    settings: db.getAllSettings(),
    new_today: parseLeadList(db.getTopLeadsToday()),
    pending_count: db.countPendingActions(),
    unread_count: db.getTotalUnreadCount(),
    unread_by_lead: db.getUnreadByLead(),
    upcoming_bookings_count: db.getUpcomingBookingsCount(),
    leads_with_booking: db.getLeadIdsWithUpcomingBooking(),
    stage_stats: db.getStageStats(),
  });
});

function parseLeadList(leads) {
  for (const l of leads) {
    try { l.issues = l.issues ? JSON.parse(l.issues) : []; } catch { l.issues = []; }
    try { l.tech_stack = l.tech_stack ? JSON.parse(l.tech_stack) : []; } catch { l.tech_stack = []; }
    try { l.emails = l.emails ? JSON.parse(l.emails) : []; } catch { l.emails = []; }
  }
  return leads;
}

// === LEADS ===
app.get('/api/leads', (req, res) => {
  const filters = {
    minScore: req.query.minScore ? parseInt(req.query.minScore) : null,
    contacted: req.query.contacted !== undefined
      ? (req.query.contacted === 'true' || req.query.contacted === '1' ? 1 : 0) : null,
    branch: req.query.branch || null,
    city: req.query.city || null,
    stage: req.query.stage || null,
    allStages: req.query.allStages === 'true' || req.query.allStages === '1',
    includeNoEmail: req.query.includeNoEmail === 'true' || req.query.includeNoEmail === '1',
    includeDismissed: req.query.includeDismissed === 'true' || req.query.includeDismissed === '1',
    limit: req.query.limit ? parseInt(req.query.limit) : 500,
  };
  res.json(parseLeadList(db.getAllLeads(filters)));
});

app.get('/api/leads/:id', (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  parseLeadList([lead]);
  lead.communications = db.getLeadCommunications(lead.id);
  lead.campaigns = db.getLeadCampaigns(lead.id);
  lead.bookings = db.getLeadBookings(lead.id);
  // Mark alle inbound comms als gelezen — Robert kijkt nu naar de lead
  db.markLeadCommunicationsRead(lead.id);
  res.json(lead);
});

// === BOOKINGS ===
app.get('/api/bookings', (_, res) => {
  res.json(db.getBookings());
});

app.patch('/api/leads/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  const lead = db.getLead(id);
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  if (typeof req.body.contacted === 'boolean') db.markContacted(id, req.body.contacted);
  if (typeof req.body.dismissed === 'boolean') db.setLeadDismissed(id, req.body.dismissed);
  if (typeof req.body.notes === 'string') db.updateNotes(id, req.body.notes);
  if (Array.isArray(req.body.emails)) {
    const clean = req.body.emails
      .map(e => String(e).trim().toLowerCase())
      .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
    db.updateLeadEmails(id, clean);
  }
  let triggered = null;
  if (typeof req.body.stage === 'string') {
    const newStage = req.body.stage;
    const valid = ['new', 'contacted', 'engaged', 'mockup_creating', 'mockup_sent', 'meeting_planned', 'offerte', 'project', 'lost'];
    if (!valid.includes(newStage)) return res.status(400).json({ error: 'Ongeldige stage' });
    const stageChanged = newStage !== lead.stage;
    if (newStage === 'lost') {
      // Markeer als verloren met (optionele) reden
      const reason = typeof req.body.loss_reason === 'string' ? req.body.loss_reason.trim() : null;
      db.markLeadLost(id, reason);
    } else {
      db.updateLeadStage(id, newStage);
    }
    if (newStage !== 'new' && newStage !== 'lost' && stageChanged) {
      sequenceEngine.autoStartCampaignsForStage(id, newStage);
    }
    // Handmatig terug-/inzetten naar 'contacted' → trigger eerste outreach-mail
    if (newStage === 'contacted' && stageChanged) {
      triggered = await triggerFirstOutreach(id);
    }
    // Sync naar briefing-app (skip als update zelf van briefing-sync kwam)
    if (stageChanged) {
      const syncSource = (req.body && typeof req.body.sync_source === 'string') ? req.body.sync_source : 'leadgen-ui';
      briefingSync.pushStageToBriefing(id, newStage, syncSource).catch(() => {});
    }
  }
  res.json({ ok: true, mail: triggered });
});

// Helper: stuur "Eerste contact"-template (direct als in send-window, anders queue auto_send)
async function triggerFirstOutreach(leadId) {
  const lead = db.getLead(leadId);
  if (!lead) return null;
  parseLeadList([lead]);
  const recipient = (lead.emails || [])[0];
  if (!recipient) return { skipped: 'geen email' };
  const templates = db.getTemplates();
  const tmpl = templates.find(t => t.name === 'Eerste contact - website verouderd')
    || templates.find(t => /eerste\s*contact/i.test(t.name) && t.type === 'email');
  if (!tmpl) return { skipped: 'geen template' };
  const subject = render(tmpl.subject || '', lead);
  const body = render(tmpl.body, lead);
  const now = new Date();
  if (sendWindow.isInSendWindow(now)) {
    try { await sendEmail({ to: recipient, subject, body, leadId: lead.id }); }
    catch (e) { return { error: e.message }; }
    return { sent: true, at: 'direct' };
  } else {
    const at = sendWindow.nextSendableTime(now);
    db.addPendingAction({
      lead_id: lead.id, type: 'email', template_id: tmpl.id,
      rendered_subject: subject, rendered_body: body, recipient,
      scheduled_for: at.toISOString(), auto_send: 1,
    });
    return { queued: true, at: at.toISOString() };
  }
}

app.post('/api/leads/:id/analyze', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  if (!lead.website) return res.status(400).json({ error: 'Geen website' });
  try {
    const analysis = await analyzeWebsite(lead.website);
    try {
      const ssPath = await takeScreenshot(lead.website, lead.id);
      if (ssPath) {
        analysis.screenshot_path = ssPath;
        const absPath = path.join(getScreenshotDir(), path.basename(ssPath));
        await enrichWithVisual(analysis, absPath);
      }
    } catch (e) {}
    db.updateLeadAnalysis(lead.id, analysis);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/leads/:id/start-funnel', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  parseLeadList([lead]);
  const emails = lead.emails || [];
  const recipient = emails[0];
  if (!recipient) return res.status(400).json({ error: 'Lead heeft geen email-adres. Voeg er een toe via ✏️ aanpassen.' });
  if (lead.stage && lead.stage !== 'new') return res.status(400).json({ error: `Lead staat al op stage '${lead.stage}', niet meer 'new'` });

  // Zoek expliciet de "Eerste contact"-template op naam (robust tegen wijzigingen in sequence-volgorde)
  const templates = db.getTemplates();
  let tmpl = templates.find(t => t.name === 'Eerste contact - website verouderd');
  if (!tmpl) tmpl = templates.find(t => /eerste\s*contact/i.test(t.name) && t.type === 'email');
  if (!tmpl) return res.status(400).json({ error: 'Geen template gevonden met "Eerste contact" in de naam. Maak er een aan via Templates.' });

  // Voor follow-ups: zoek de standaard outreach sequence (zelfde trigger)
  const seqs = db.getSequences().filter(s => s.enabled && s.trigger_stage === 'contacted');
  const seq = seqs[0];

  const subject = render(tmpl.subject || '', lead);
  const body = render(tmpl.body, lead);
  const now = new Date();
  const inWindow = sendWindow.isInSendWindow(now);
  let resultMsg;

  if (inWindow) {
    try {
      await sendEmail({ to: recipient, subject, body, leadId: lead.id });
    } catch (err) {
      return res.status(500).json({ error: 'Mail-versturen faalde: ' + err.message });
    }
    resultMsg = `Eerste mail verzonden: "${tmpl.name}".`;
  } else {
    const at = sendWindow.nextSendableTime(now);
    db.addPendingAction({
      lead_id: lead.id,
      type: 'email',
      template_id: tmpl.id,
      rendered_subject: subject,
      rendered_body: body,
      recipient,
      scheduled_for: at.toISOString(),
      auto_send: 1,
    });
    // Lead alvast in funnel zodat 'ie niet meer in Nieuwe leads-overzicht staat
    db.advanceLeadStage(lead.id, 'contacted');
    resultMsg = `Mail "${tmpl.name}" ingepland — wordt verzonden bij volgende venster (${at.toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' })}).`;
  }

  if (seq) {
    db.startLeadCampaign(lead.id, seq.id);
    const camp = db.getLeadCampaigns(lead.id).find(c => c.sequence_id === seq.id);
    if (camp) db.advanceCampaign(camp.id);
  }
  res.json({ ok: true, message: resultMsg });
});

app.post('/api/leads/:id/create-briefing', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  parseLeadList([lead]);
  const emails = lead.emails || [];
  const recipient = emails[0];
  if (!recipient) return res.status(400).json({ error: 'Lead heeft geen email-adres. Voeg er een toe via ✏️ aanpassen.' });

  // Vind de briefing-template
  const templates = db.getTemplates();
  const tmpl = templates.find(t => t.name === 'Briefing-link verzenden') || templates.find(t => /briefing/i.test(t.name));
  if (!tmpl) return res.status(400).json({ error: 'Geen briefing-template gevonden in Templates' });

  // Genereer briefing-link via briefing-app API
  let briefing;
  try {
    briefing = await briefingClient.createBriefingLink({ companyName: lead.name, source: 'leadgen-manual' });
  } catch (err) {
    return res.status(500).json({ error: 'Briefing-app API faalde: ' + err.message });
  }

  // Render template met briefing_link extra var
  const subject = render(tmpl.subject || '', lead, { briefing_link: briefing.url });
  const body = render(tmpl.body, lead, { briefing_link: briefing.url });

  // Queue als pending (Robert reviewt + verstuurt). Stage advance gebeurt pas bij approve.
  const result = db.addPendingAction({
    lead_id: lead.id,
    type: 'email',
    template_id: tmpl.id,
    rendered_subject: subject,
    rendered_body: body,
    recipient,
    scheduled_for: new Date().toISOString(),
    auto_send: 0,
    intent: 'direct_start',
  });

  // Sla de slug op zodat we toekomstige mails/bookings automatisch kunnen syncen
  db.setLeadBriefingSlug(lead.id, briefingClient.slugify(lead.name));

  // Eerste sync naar briefing-app — alle bestaande historie meegeven
  leadSync.syncLeadAsync(lead.id);

  res.json({
    ok: true,
    briefing_url: briefing.url,
    existed: briefing.existed,
    pending_id: result.lastInsertRowid,
  });
});

app.get('/api/admin/pending-diag', (req, res) => {
  // Diagnose hulp: laat zien wat in pending_actions staat
  const total = db.db.prepare(`SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending'`).get().c;
  const due = db.db.prepare(`SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending' AND scheduled_for <= datetime('now')`).get().c;
  const auto_due = db.db.prepare(`SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending' AND auto_send = 1 AND scheduled_for <= datetime('now')`).get().c;
  const sample = db.db.prepare(`SELECT id, type, auto_send, scheduled_for, recipient FROM pending_actions WHERE status = 'pending' ORDER BY scheduled_for ASC LIMIT 5`).all();
  const sent = db.db.prepare(`SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'sent'`).get().c;
  const failed = db.db.prepare(`SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'failed'`).get().c;
  const now_utc = new Date().toISOString();
  const sqlite_now = db.db.prepare(`SELECT datetime('now') AS n`).get().n;
  res.json({ total_pending: total, due_now: due, auto_due_now: auto_due, sent, failed, server_now_iso: now_utc, sqlite_now, sample });
});

// Rescrape emails voor leads zonder gevonden email-adres.
// Loopt in batches; per request ~50 leads (kost ~5-10 min). Robert kan herhalen.
let rescrapeInProgress = false;
let rescrapeStats = { running: false, processed: 0, found: 0, totalQueued: 0, lastError: null, startedAt: null };
app.post('/api/admin/rescrape-emails', async (req, res) => {
  if (rescrapeInProgress) return res.json({ ok: true, alreadyRunning: true, stats: rescrapeStats });
  const limit = Math.min(parseInt(req.body?.limit || '50'), 200);
  const leads = db.getLeadsWithoutEmail(limit);
  if (leads.length === 0) return res.json({ ok: true, processed: 0, found: 0, message: 'Alle leads met website hebben al een email-adres' });

  rescrapeInProgress = true;
  rescrapeStats = { running: true, processed: 0, found: 0, totalQueued: leads.length, lastError: null, startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true, totalQueued: leads.length, message: `Email-scan gestart voor ${leads.length} leads — check status via /api/admin/rescrape-emails/status` });

  (async () => {
    try {
      for (const lead of leads) {
        try {
          const emails = await scrapeEmailsForUrl(lead.website);
          if (emails && emails.length > 0) {
            db.updateLeadEmails(lead.id, emails);
            rescrapeStats.found++;
          }
        } catch (e) {
          rescrapeStats.lastError = `lead ${lead.id}: ${e.message}`;
        }
        rescrapeStats.processed++;
        await new Promise(r => setTimeout(r, 500)); // throttle iets
      }
    } finally {
      rescrapeStats.running = false;
      rescrapeInProgress = false;
    }
  })();
});

app.get('/api/admin/rescrape-emails/status', (_, res) => {
  res.json(rescrapeStats);
});

// Visuele-design backfill: stuurt bestaande screenshots naar Claude en
// scoort design-modernity. Async background-job; gebruikt visual_design_score
// IS NULL als selectie zodat herhalen veilig is. Spacing 1s per call om de
// Anthropic rate-limit en kosten te respecteren.
let visualBackfillInProgress = false;
let visualBackfillStats = { running: false, processed: 0, scored: 0, failed: 0, totalQueued: 0, lastError: null, startedAt: null };
app.post('/api/admin/visual-backfill', async (req, res) => {
  if (visualBackfillInProgress) return res.json({ ok: true, alreadyRunning: true, stats: visualBackfillStats });
  if (!process.env.ANTHROPIC_API_KEY) return res.status(400).json({ error: 'ANTHROPIC_API_KEY niet ingesteld' });
  const limit = Math.min(parseInt(req.body?.limit || '500'), 2000);
  const leads = db.leadsForVisualBackfill(limit);
  if (leads.length === 0) return res.json({ ok: true, processed: 0, message: 'Alle leads met screenshot zijn al gescoord op visueel design' });

  const { analyzeVisualDesign } = require('./lib/visual-analyzer');
  const { visualBonusForScore } = require('./analyzer');

  visualBackfillInProgress = true;
  visualBackfillStats = { running: true, processed: 0, scored: 0, failed: 0, totalQueued: leads.length, lastError: null, startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true, totalQueued: leads.length, message: `Visual-backfill gestart voor ${leads.length} leads — check status via /api/admin/visual-backfill/status` });

  (async () => {
    const screenshotDir = getScreenshotDir();
    try {
      for (const lead of leads) {
        try {
          const absPath = path.join(screenshotDir, path.basename(lead.screenshot_path));
          const r = await analyzeVisualDesign(absPath);
          if (r) {
            const bonus = visualBonusForScore(r.score);
            // Baseline = oude replacement_score. Bonus wordt opgeteld; clamp 0..100.
            const newScore = Math.min(100, (lead.replacement_score || 0) + bonus);
            db.updateLeadVisualDesign(lead.id, r.score, r.issues, newScore);
            visualBackfillStats.scored++;
          } else {
            visualBackfillStats.failed++;
          }
        } catch (e) {
          visualBackfillStats.failed++;
          visualBackfillStats.lastError = `lead ${lead.id}: ${e.message}`;
        }
        visualBackfillStats.processed++;
        await new Promise(r => setTimeout(r, 1000)); // 1s per call
      }
    } finally {
      visualBackfillStats.running = false;
      visualBackfillInProgress = false;
    }
  })();
});

app.get('/api/admin/visual-backfill/status', (_, res) => {
  res.json(visualBackfillStats);
});

// Dedupe Gmail-Verzonden folder. Vindt mails met identieke (to, subject) die
// binnen 60s na elkaar zijn aangekomen — dat zijn de pre-v4.52 dubbele copies
// (Gmail's eigen save + onze IMAP-append). Dry-run by default; ?apply=1
// verplaatst de dubbele naar Trash (recoverable, niet expunge).
// Query: ?days=30 (scope), ?seconds=60 (max-tijd tussen dup-paren).
app.post('/api/admin/dedupe-sent', async (req, res) => {
  const days = Math.max(1, Math.min(parseInt(req.query.days || req.body?.days || '30'), 365));
  const maxSecondsBetween = Math.max(1, Math.min(parseInt(req.query.seconds || req.body?.seconds || '60'), 600));
  const apply = req.query.apply === '1' || req.body?.apply === true;
  try {
    const { dedupeSentFolder } = require('./lib/sent-dedupe');
    const result = await dedupeSentFolder({ days, maxSecondsBetween, apply });
    res.json({ ok: true, dry: !apply, days, max_seconds_between: maxSecondsBetween, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/respace-pending', (req, res) => {
  // Herverdeel alle pending email-actions met spacing van 15 sec vanaf nextSendableTime.
  // Niet voor email_reply (die handmatig).
  const SPACING_MS = 15 * 1000;
  const pending = db.db.prepare(`SELECT id FROM pending_actions WHERE status = 'pending' AND auto_send = 1 AND type = 'email' ORDER BY scheduled_for ASC`).all();
  let cursor = sendWindow.nextSendableTime(new Date());
  const upd = db.db.prepare(`UPDATE pending_actions SET scheduled_for = ? WHERE id = ?`);
  for (const p of pending) {
    cursor = sendWindow.nextSendableTime(cursor);
    upd.run(cursor.toISOString(), p.id);
    cursor = new Date(cursor.getTime() + SPACING_MS);
  }
  res.json({ ok: true, rescheduled: pending.length, last_scheduled: cursor.toISOString() });
});

// Cleanup-endpoint: trekt 'contacted'-leads die er onterecht in zitten terug
// naar stage='new'. Onterecht = score < drempel OF geen email-adres. Verder
// in funnel (briefing, replied, won, ...) wordt nooit aangeraakt. Dry-run by
// default, pas met ?apply=1 commit hij naar de DB.
//
// Voorbeeld:
//   curl -X POST .../api/admin/funnel-cleanup          → preview
//   curl -X POST .../api/admin/funnel-cleanup?apply=1  → execute
//   ?threshold=50 overschrijft default uit settings
app.post('/api/admin/funnel-cleanup', (req, res) => {
  const threshold = parseInt(
    req.query.threshold || db.getSetting('high_score_threshold') || '40'
  );
  const apply = req.query.apply === '1' || req.body?.apply === true;

  // Scope: alleen stage='contacted'. NULL-score telt NIET als "onder drempel".
  const matched = db.db.prepare(`
    SELECT id, name, replacement_score, emails,
      CASE
        WHEN emails IS NULL OR emails = '' OR emails = '[]' THEN 'no_email'
        ELSE 'low_score'
      END AS reason
    FROM leads
    WHERE stage = 'contacted'
      AND (
        emails IS NULL OR emails = '' OR emails = '[]'
        OR (replacement_score IS NOT NULL AND replacement_score < ?)
      )
    ORDER BY reason ASC, replacement_score ASC, name ASC
  `).all(threshold);

  const ids = matched.map(l => l.id);
  let pendingCount = 0;
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    pendingCount = db.db.prepare(
      `SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending' AND lead_id IN (${placeholders})`
    ).get(...ids).c;
  }

  const byReason = {
    no_email: matched.filter(l => l.reason === 'no_email').length,
    low_score: matched.filter(l => l.reason === 'low_score').length,
  };

  if (!apply) {
    return res.json({
      dry: true,
      threshold,
      scope: "stage='contacted'",
      matched_leads: matched.length,
      by_reason: byReason,
      pending_actions_to_cancel: pendingCount,
      sample: matched.slice(0, 20),
      message: matched.length === 0
        ? 'Geen onterechte leads in contacted — niets te doen.'
        : `Preview: zou ${matched.length} leads (${byReason.no_email} no-email + ${byReason.low_score} low-score) terug naar 'new' zetten en ${pendingCount} mails cancelen. Voeg ?apply=1 toe.`,
    });
  }

  const tx = db.db.transaction(() => {
    let revertedLeads = 0;
    let cancelledActions = 0;
    for (const lead of matched) {
      const r1 = db.db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'`).run(lead.id);
      cancelledActions += r1.changes;
      const r2 = db.db.prepare(`UPDATE leads SET stage = 'new' WHERE id = ? AND stage = 'contacted'`).run(lead.id);
      revertedLeads += r2.changes;
    }
    return { revertedLeads, cancelledActions };
  });
  const result = tx();

  res.json({
    dry: false,
    threshold,
    by_reason: byReason,
    reverted_leads: result.revertedLeads,
    cancelled_actions: result.cancelledActions,
    message: `${result.revertedLeads} leads terug naar 'new', ${result.cancelledActions} pending mails gecancelled.`,
  });
});

// Revert recente bulk-funnel actie: cancelt pending mails uit laatste N min
// EN zet hun leads terug naar 'new' — MAAR alleen leads die nog géén
// outbound mail succesvol verstuurd hebben (anders krijgen we orphan-state:
// lead lijkt 'new' terwijl er wel een mail uit is). Voor leads met sent
// communications cancelen we alleen hun pending follow-ups; stage blijft.
// Dry-run by default, ?apply=1 om uit te voeren. ?minutes=30 default.
app.post('/api/admin/funnel-revert-recent', (req, res) => {
  const minutes = parseInt(req.query.minutes || req.body?.minutes || '30');
  const apply = req.query.apply === '1' || req.body?.apply === true;

  const recent = db.db.prepare(`
    SELECT pa.id AS pending_id, pa.lead_id, pa.created_at, pa.scheduled_for,
           l.name, l.stage, l.replacement_score
    FROM pending_actions pa
    JOIN leads l ON l.id = pa.lead_id
    WHERE pa.status = 'pending'
      AND pa.type = 'email'
      AND pa.created_at >= datetime('now', '-' || ? || ' minutes')
    ORDER BY pa.created_at ASC
  `).all(minutes);

  const leadIds = [...new Set(recent.map(r => r.lead_id))];
  // Welke van die leads heeft al een succesvol verzonden outbound mail?
  // Die mogen NIET terug naar 'new' — alleen pending cancelen.
  let sentLeadIds = new Set();
  if (leadIds.length > 0) {
    const placeholders = leadIds.map(() => '?').join(',');
    const rows = db.db.prepare(`SELECT DISTINCT lead_id FROM communications WHERE lead_id IN (${placeholders}) AND direction = 'outbound' AND status = 'sent'`).all(...leadIds);
    sentLeadIds = new Set(rows.map(r => r.lead_id));
  }
  const revertable = leadIds.filter(id => !sentLeadIds.has(id));
  const keptStageCount = leadIds.length - revertable.length;

  if (!apply) {
    return res.json({
      dry: true,
      minutes,
      pending_to_cancel: recent.length,
      unique_leads: leadIds.length,
      revertable_to_new: revertable.length,
      kept_stage_because_already_sent: keptStageCount,
      sample: recent.slice(0, 20),
      message: recent.length === 0
        ? `Geen pending mails aangemaakt in laatste ${minutes} min.`
        : `Preview: ${recent.length} pending mails cancellen, ${revertable.length} leads terug naar 'new'. ${keptStageCount} leads houden stage (mail al succesvol verstuurd). Voeg ?apply=1 toe.`,
    });
  }

  const tx = db.db.transaction(() => {
    let cancelledActions = 0;
    let revertedLeads = 0;
    for (const r of recent) {
      const r1 = db.db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE id = ? AND status = 'pending'`).run(r.pending_id);
      cancelledActions += r1.changes;
    }
    for (const id of revertable) {
      const r2 = db.db.prepare(`UPDATE leads SET stage = 'new' WHERE id = ? AND stage = 'contacted'`).run(id);
      revertedLeads += r2.changes;
    }
    return { cancelledActions, revertedLeads };
  });
  const result = tx();

  res.json({
    dry: false,
    minutes,
    cancelled_actions: result.cancelledActions,
    reverted_leads: result.revertedLeads,
    kept_stage_because_already_sent: keptStageCount,
    message: `${result.cancelledActions} mails gecancelled, ${result.revertedLeads} leads terug naar 'new'. ${keptStageCount} leads houden stage (mail al verstuurd).`,
  });
});

// Repair-endpoint: vindt leads die in 'new' staan maar wel een succesvol
// verstuurde outbound mail hebben (orphan-state veroorzaakt door eerdere
// revert-bugs). Zet ze terug naar 'contacted'.
// Dry-run by default, ?apply=1 om uit te voeren.
app.post('/api/admin/fix-orphan-stages', (req, res) => {
  const apply = req.query.apply === '1' || req.body?.apply === true;

  const orphans = db.db.prepare(`
    SELECT l.id, l.name, l.replacement_score, MAX(c.sent_at) AS last_sent_at
    FROM leads l
    JOIN communications c ON c.lead_id = l.id
    WHERE l.stage = 'new'
      AND c.direction = 'outbound'
      AND c.status = 'sent'
    GROUP BY l.id
    ORDER BY last_sent_at DESC
  `).all();

  if (!apply) {
    return res.json({
      dry: true,
      orphans: orphans.length,
      sample: orphans.slice(0, 20),
      message: orphans.length === 0
        ? `Geen orphans gevonden — alle stages kloppen met communications.`
        : `Preview: ${orphans.length} leads staan op 'new' maar hebben wel mail gestuurd. ?apply=1 om naar 'contacted' te zetten.`,
    });
  }

  const stmt = db.db.prepare(`UPDATE leads SET stage = 'contacted' WHERE id = ? AND stage = 'new'`);
  const tx = db.db.transaction(() => {
    let fixed = 0;
    for (const o of orphans) fixed += stmt.run(o.id).changes;
    return fixed;
  });
  const fixed = tx();
  res.json({ dry: false, fixed, message: `${fixed} orphan-leads teruggezet naar 'contacted'.` });
});

// Re-render pending mails met de huidige template-content. Voor wanneer je
// een template hebt aangepast nadat mails al ingepland staan — de oude
// rendered_subject/body zijn "bevroren" in pending_actions, dit refresht ze.
// Alleen pending email-actions met een template_id worden geraakt. Replies
// en custom mails (geen template_id) blijven met rust.
// Dry-run by default, ?apply=1 om uit te voeren.
app.post('/api/admin/funnel-rerender-pending', (req, res) => {
  const apply = req.query.apply === '1' || req.body?.apply === true;

  const targets = db.db.prepare(`
    SELECT pa.id AS pending_id, pa.lead_id, pa.template_id,
           pa.rendered_subject AS old_subject, pa.rendered_body AS old_body,
           l.name AS lead_name
    FROM pending_actions pa
    JOIN leads l ON l.id = pa.lead_id
    WHERE pa.status = 'pending'
      AND pa.type = 'email'
      AND pa.template_id IS NOT NULL
    ORDER BY pa.scheduled_for ASC
  `).all();

  // Groepeer per template + cache template + lead lookups
  const templateCache = new Map();
  const getTmpl = (id) => {
    if (!templateCache.has(id)) templateCache.set(id, db.getTemplate(id));
    return templateCache.get(id);
  };

  const plan = [];
  const byTemplate = {};
  for (const t of targets) {
    const tmpl = getTmpl(t.template_id);
    if (!tmpl) { plan.push({ ...t, skip: 'template-niet-gevonden' }); continue; }
    const lead = db.getLead(t.lead_id);
    if (!lead) { plan.push({ ...t, skip: 'lead-niet-gevonden' }); continue; }
    parseLeadList([lead]);
    const newSubject = render(tmpl.subject || '', lead);
    const newBody = render(tmpl.body, lead);
    const changed = newSubject !== t.old_subject || newBody !== t.old_body;
    plan.push({
      pending_id: t.pending_id,
      lead_name: t.lead_name,
      template_name: tmpl.name,
      changed,
      new_subject: newSubject,
      new_body: newBody,
    });
    byTemplate[tmpl.name] = byTemplate[tmpl.name] || { total: 0, changed: 0 };
    byTemplate[tmpl.name].total++;
    if (changed) byTemplate[tmpl.name].changed++;
  }

  const changedCount = plan.filter(p => p.changed).length;

  if (!apply) {
    return res.json({
      dry: true,
      pending_total: targets.length,
      changed_count: changedCount,
      by_template: byTemplate,
      sample: plan.filter(p => p.changed).slice(0, 5).map(p => ({
        pending_id: p.pending_id, lead_name: p.lead_name, template_name: p.template_name,
        new_subject: p.new_subject,
      })),
      message: changedCount === 0
        ? `Alle ${targets.length} pending mails zijn al in sync met huidige templates.`
        : `Preview: ${changedCount} van ${targets.length} pending mails zouden gere-render worden. Voeg ?apply=1 toe.`,
    });
  }

  const stmt = db.db.prepare(`UPDATE pending_actions SET rendered_subject = ?, rendered_body = ? WHERE id = ? AND status = 'pending'`);
  const tx = db.db.transaction(() => {
    let updated = 0;
    for (const p of plan) {
      if (!p.changed) continue;
      const r = stmt.run(p.new_subject, p.new_body, p.pending_id);
      updated += r.changes;
    }
    return updated;
  });
  const updated = tx();

  res.json({
    dry: false,
    updated,
    by_template: byTemplate,
    message: `${updated} pending mails gere-renderd met huidige template.`,
  });
});

// Bulk-remove uit funnel: cancelt pending mails én zet leads terug naar 'new'.
// Accepteert óf body.ids (lijst) óf body.stage (alle leads in die stage).
// Geen dry-run — UI doet de confirm. Leads waarvan al een outbound mail
// succesvol verstuurd is houden hun stage (anders orphan-state); hun pending
// follow-ups worden wel gecanceld. Met body.force=true overrule je dat.
app.post('/api/leads/bulk-remove-from-funnel', (req, res) => {
  let ids = [];
  if (Array.isArray(req.body?.ids) && req.body.ids.length > 0) {
    ids = req.body.ids.map(Number).filter(Boolean);
  } else if (typeof req.body?.stage === 'string') {
    const stage = req.body.stage;
    if (['new', 'lost'].includes(stage)) return res.status(400).json({ error: `Stage '${stage}' is geen funnel-stage` });
    ids = db.db.prepare(`SELECT id FROM leads WHERE stage = ?`).all(stage).map(r => r.id);
  } else {
    return res.status(400).json({ error: 'Geef body.ids (lijst) of body.stage op' });
  }
  if (ids.length === 0) return res.json({ ok: true, reverted_leads: 0, cancelled_actions: 0, kept_stage_because_already_sent: 0, message: 'Geen leads om te verwerken.' });

  const force = req.body?.force === true;
  const placeholders = ids.map(() => '?').join(',');
  let sentLeadIds = new Set();
  if (!force) {
    const rows = db.db.prepare(`SELECT DISTINCT lead_id FROM communications WHERE lead_id IN (${placeholders}) AND direction = 'outbound' AND status = 'sent'`).all(...ids);
    sentLeadIds = new Set(rows.map(r => r.lead_id));
  }
  const revertable = ids.filter(id => !sentLeadIds.has(id));
  const keptStageCount = ids.length - revertable.length;

  const tx = db.db.transaction(() => {
    const r1 = db.db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE status = 'pending' AND lead_id IN (${placeholders})`).run(...ids);
    let revertedLeads = 0;
    if (revertable.length > 0) {
      const ph2 = revertable.map(() => '?').join(',');
      const r2 = db.db.prepare(`UPDATE leads SET stage = 'new' WHERE stage NOT IN ('new', 'lost') AND id IN (${ph2})`).run(...revertable);
      revertedLeads = r2.changes;
    }
    return { cancelledActions: r1.changes, revertedLeads };
  });
  const result = tx();
  res.json({
    ok: true,
    reverted_leads: result.revertedLeads,
    cancelled_actions: result.cancelledActions,
    kept_stage_because_already_sent: keptStageCount,
    message: keptStageCount > 0
      ? `${result.revertedLeads} leads terug naar 'new', ${result.cancelledActions} pending mails gecancelled. ${keptStageCount} lead(s) houden stage (mail al verstuurd).`
      : `${result.revertedLeads} leads terug naar 'new', ${result.cancelledActions} pending mails gecancelled.`,
  });
});

app.post('/api/leads/bulk-funnel', async (req, res) => {
  // Manueel bulk: respecteert high_score_threshold (default 40) wanneer geen
  // body.ids meegegeven — matcht de "Hoge score leads"-view die de UI toont.
  // Voor expliciete body.ids geldt de threshold NIET (caller kiest bewust).
  let candidates;
  if (Array.isArray(req.body?.ids) && req.body.ids.length > 0) {
    const ids = req.body.ids.map(Number).filter(Boolean);
    const placeholders = ids.map(() => '?').join(',');
    candidates = db.db.prepare(`SELECT id, name FROM leads WHERE id IN (${placeholders}) AND stage = 'new' AND (dismissed IS NULL OR dismissed = 0) AND emails IS NOT NULL AND emails != '[]' AND emails != ''`).all(...ids);
  } else {
    const threshold = parseInt(db.getSetting('high_score_threshold') || '40');
    candidates = db.db.prepare(`SELECT id, name FROM leads WHERE replacement_score >= ? AND stage = 'new' AND (dismissed IS NULL OR dismissed = 0) AND emails IS NOT NULL AND emails != '[]' AND emails != ''`).all(threshold);
  }
  const templates = db.getTemplates();
  const tmpl = templates.find(t => t.name === 'Eerste contact - website verouderd')
    || templates.find(t => /eerste\s*contact/i.test(t.name) && t.type === 'email');
  if (!tmpl) return res.status(400).json({ error: 'Geen "Eerste contact"-template gevonden' });

  // Spreid mails 15 sec uit elkaar; respecteer send-window
  let cursor = sendWindow.nextSendableTime(new Date());
  const SPACING_MS = 15 * 1000;
  let queued = 0;

  for (const c of candidates) {
    const lead = db.getLead(c.id);
    if (!lead || lead.stage !== 'new') continue;
    parseLeadList([lead]);
    const recipient = (lead.emails || [])[0];
    if (!recipient) continue;
    const subject = render(tmpl.subject || '', lead);
    const body = render(tmpl.body, lead);
    // Schuif cursor naar volgende sendable tijd als hij uit window glijdt
    cursor = sendWindow.nextSendableTime(cursor);
    db.addPendingAction({
      lead_id: lead.id,
      type: 'email',
      template_id: tmpl.id,
      rendered_subject: subject,
      rendered_body: body,
      recipient,
      scheduled_for: cursor.toISOString(),
      auto_send: 1,
    });
    // Direct stage naar 'contacted' zodat lead uit Hoge score leads-view verdwijnt;
    // mail wordt later verzonden door auto-send worker
    db.advanceLeadStage(lead.id, 'contacted');
    cursor = new Date(cursor.getTime() + SPACING_MS);
    queued++;
  }

  const inWindow = sendWindow.isInSendWindow(new Date());
  const msg = inWindow
    ? `${queued} mails ingepland — eerste wordt nu verzonden, daarna elke 5 minuten één`
    : `${queued} mails ingepland — eerste mail wordt verzonden bij volgende venster-opening (${sendWindow.describeWindow()})`;
  res.json({ ok: true, queued, in_window: inWindow, message: msg });
});

app.post('/api/leads/regenerate-screenshots', async (req, res) => {
  // Async — start een background-job, geef direct status terug
  const leads = db.db.prepare(`SELECT id, website FROM leads WHERE (screenshot_path IS NULL OR screenshot_path = '') AND website IS NOT NULL AND website != ''`).all();
  res.json({ ok: true, queued: leads.length, message: `Screenshot-batch gestart voor ${leads.length} leads — kost ~${Math.ceil(leads.length * 6 / 60)} min` });
  (async () => {
    let done = 0;
    for (const l of leads) {
      try {
        const ssPath = await takeScreenshot(l.website, l.id);
        if (ssPath) db.updateLeadScreenshot(l.id, ssPath);
        done++;
        if (done % 10 === 0) console.log(`Screenshot batch: ${done}/${leads.length}`);
      } catch (e) { /* skip */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    console.log(`✓ Screenshot batch klaar: ${done}/${leads.length}`);
  })();
});

app.post('/api/leads/:id/screenshot', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  if (!lead.website) return res.status(400).json({ error: 'Geen website' });
  try {
    const ssPath = await takeScreenshot(lead.website, lead.id);
    if (ssPath) {
      db.updateLeadScreenshot(lead.id, ssPath);
      return res.json({ ok: true, screenshot_path: ssPath });
    }
    res.status(500).json({ error: 'Screenshot mislukt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// === FUNNEL / DEALS ===
app.get('/api/deals', (req, res) => {
  res.json(parseLeadList(db.getDealsByStage()));
});

// === COMMUNICATIONS ===
app.get('/api/leads/:id/communications', (req, res) => {
  res.json(db.getLeadCommunications(parseInt(req.params.id)));
});

app.post('/api/leads/:id/send-email', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  const { template_id, custom_subject, custom_body, recipient } = req.body;
  let subject, body;
  if (template_id) {
    const tmpl = db.getTemplate(template_id);
    if (!tmpl) return res.status(404).json({ error: 'Template niet gevonden' });
    parseLeadList([lead]);
    subject = render(tmpl.subject || '', lead);
    body = render(tmpl.body, lead);
  } else {
    subject = custom_subject;
    body = custom_body;
  }
  let to = recipient;
  if (!to) { parseLeadList([lead]); to = (lead.emails || [])[0]; }
  if (!to) return res.status(400).json({ error: 'Geen email adres' });
  try {
    await sendEmail({ to, subject, body, leadId: lead.id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/leads/:id/send-whatsapp', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  const { template_id, custom_body, recipient } = req.body;
  let body;
  if (template_id) {
    const tmpl = db.getTemplate(template_id);
    if (!tmpl) return res.status(404).json({ error: 'Template niet gevonden' });
    parseLeadList([lead]);
    body = render(tmpl.body, lead);
  } else { body = custom_body; }
  const to = recipient || lead.phone;
  if (!to) return res.status(400).json({ error: 'Geen telefoon nummer' });
  try {
    await sendWhatsApp({ to, body, leadId: lead.id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/leads/:id/whatsapp-link', (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  const { template_id, message } = req.query;
  let body = message;
  if (template_id) {
    const tmpl = db.getTemplate(parseInt(template_id));
    if (tmpl) { parseLeadList([lead]); body = render(tmpl.body, lead); }
  }
  if (!body) return res.status(400).json({ error: 'Geen bericht' });
  const link = buildWhatsAppLink(lead.phone, body);
  if (!link) return res.status(400).json({ error: 'Ongeldig telefoonnummer' });
  res.json({ link, body });
});

// === TEMPLATES ===
app.get('/api/templates', (_, res) => res.json(db.getTemplates()));
app.get('/api/templates/:id', (req, res) => {
  const t = db.getTemplate(parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Niet gevonden' });
  res.json(t);
});
app.post('/api/templates', (req, res) => res.json({ ok: true, id: db.addTemplate(req.body) }));
app.patch('/api/templates/:id', (req, res) => {
  db.updateTemplate(parseInt(req.params.id), req.body);
  res.json({ ok: true });
});
app.delete('/api/templates/:id', (req, res) => {
  db.deleteTemplate(parseInt(req.params.id));
  res.json({ ok: true });
});
app.get('/api/template-vars', (_, res) => res.json(listAvailableVars()));

app.post('/api/templates/:id/preview', (req, res) => {
  const t = db.getTemplate(parseInt(req.params.id));
  if (!t) return res.status(404).json({ error: 'Niet gevonden' });
  const { lead_id } = req.body;
  let lead;
  if (lead_id) { lead = db.getLead(lead_id); if (lead) parseLeadList([lead]); }
  if (!lead) {
    lead = {
      name: 'Voorbeeld Kozijnen B.V.', website: 'https://voorbeeld-kozijnen.nl',
      website_short: 'voorbeeld-kozijnen.nl', first_name: 'Jan',
      branch_name: 'kozijnbedrijf', city_name: 'Rotterdam',
      pagespeed_score: 35, replacement_score: 78,
      first_issue: 'Geen viewport meta tag (niet mobiel-vriendelijk)',
      issues: [], emails: ['info@voorbeeld-kozijnen.nl'],
    };
  }
  res.json({
    subject: render(t.subject || '', lead),
    body: render(t.body, lead),
  });
});

// === SEQUENCES ===
app.get('/api/sequences', (_, res) => {
  const seqs = db.getSequences();
  for (const s of seqs) s.steps = db.getSequenceSteps(s.id);
  res.json(seqs);
});
app.post('/api/sequences', (req, res) => {
  const id = db.addSequence(req.body);
  if (req.body.steps) db.setSequenceSteps(id, req.body.steps);
  res.json({ ok: true, id });
});
app.patch('/api/sequences/:id', (req, res) => {
  const id = parseInt(req.params.id);
  db.updateSequence(id, req.body);
  if (req.body.steps) db.setSequenceSteps(id, req.body.steps);
  res.json({ ok: true });
});
app.delete('/api/sequences/:id', (req, res) => {
  db.deleteSequence(parseInt(req.params.id));
  res.json({ ok: true });
});

app.post('/api/leads/:id/start-campaign', (req, res) => {
  const ok = sequenceEngine.startCampaignForLead(parseInt(req.params.id), req.body.sequence_id);
  res.json({ ok });
});

// === ACTIVITY LOG ===
app.get('/api/activity', (_, res) => {
  const events = [];
  for (const s of db.getRecentSearches()) {
    events.push({
      at: s.created_at,
      kind: s.auto ? 'auto_scrape' : 'manual_scrape',
      icon: s.auto ? '🤖' : '🔍',
      title: s.auto ? 'Auto-pilot scrape' : 'Handmatige zoekopdracht',
      detail: `"${s.query}"${s.location ? ' in ' + s.location : ''} — ${s.total_results || 0} resultaten · ${s.status}`,
      lead_id: null,
    });
  }
  for (const c of db.getRecentCommunications()) {
    const out = c.direction === 'outbound';
    events.push({
      at: c.sent_at,
      kind: out ? 'mail_sent' : 'mail_received',
      icon: out ? '📤' : '📥',
      title: out ? 'Mail verzonden' : 'Mail ontvangen',
      detail: `${c.lead_name || c.recipient || '?'} — ${c.subject || '(geen onderwerp)'}`,
      lead_id: c.lead_id,
    });
  }
  for (const b of db.getRecentBookings()) {
    events.push({
      at: b.created_at,
      kind: b.status === 'cancelled' ? 'booking_cancelled' : 'booking_made',
      icon: b.status === 'cancelled' ? '❌' : '📅',
      title: b.status === 'cancelled' ? 'Booking geannuleerd' : 'Booking ontvangen',
      detail: `${b.lead_name || b.attendee_name || '?'} — ${b.event_type || 'meeting'}${b.scheduled_at ? ' op ' + new Date(b.scheduled_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }) : ''}`,
      lead_id: b.lead_id,
    });
  }
  events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
  res.json(events.slice(0, 200));
});

// === INBOX (combineerd ongelezen klant-mails + pending AI-voorstellen) ===
app.get('/api/inbox', (_, res) => {
  res.json({
    unread_comms: db.getUnreadInboundComms(),
    pending: db.getPendingActions(),
  });
});

// === PENDING ACTIONS ===
app.get('/api/pending', (_, res) => {
  const actions = db.getPendingActions();
  for (const a of actions) {
    if (a.type === 'email' && !a.recipient && a.lead_id) {
      const lead = db.getLead(a.lead_id);
      if (lead) {
        try {
          const emails = lead.emails ? JSON.parse(lead.emails) : [];
          a.recipient = emails[0] || null;
        } catch {}
      }
    }
  }
  res.json(actions);
});

// Internal helper: voer 1 pending action uit. Returns { ok, error? }
async function executePendingAction(id) {
  const action = db.getPendingAction(id);
  if (!action) return { ok: false, error: 'Niet gevonden' };
  if (action.status !== 'pending') return { ok: false, error: 'Al verwerkt' };
  let recipient = action.recipient;
  if (!recipient) {
    const lead = db.getLead(action.lead_id);
    if (lead) {
      if (action.type === 'email' || action.type === 'email_reply') {
        try { const emails = lead.emails ? JSON.parse(lead.emails) : []; recipient = emails[0]; } catch {}
      } else if (action.type === 'whatsapp') { recipient = lead.phone; }
    }
  }
  if (!recipient) {
    db.updatePendingActionStatus(id, 'failed');
    return { ok: false, error: 'Geen ontvanger' };
  }
  try {
    if (action.type === 'email' || action.type === 'email_reply') {
      await sendEmail({ to: recipient, subject: action.rendered_subject, body: action.rendered_body, leadId: action.lead_id, inReplyTo: action.in_reply_to_message_id || null });
    } else if (action.type === 'whatsapp') {
      await sendWhatsApp({ to: recipient, body: action.rendered_body, leadId: action.lead_id });
    }
    db.updatePendingActionStatus(id, 'sent');
    if (action.campaign_id) db.advanceCampaign(action.campaign_id);
    if (action.lead_id) {
      if (action.type === 'email_reply') {
        if (action.intent === 'meeting') db.advanceLeadStage(action.lead_id, 'meeting_planned');
        else if (action.intent === 'no_interest') db.advanceLeadStage(action.lead_id, 'lost');
      } else if (action.type === 'email' && action.intent === 'direct_start') {
        db.advanceLeadStage(action.lead_id, 'mockup_creating');
      }
    }
    return { ok: true };
  } catch (err) {
    db.updatePendingActionStatus(id, 'failed');
    return { ok: false, error: err.message };
  }
}

app.post('/api/pending/:id/approve', async (req, res) => {
  const result = await executePendingAction(parseInt(req.params.id));
  if (!result.ok) {
    const code = result.error === 'Niet gevonden' ? 404 : (result.error === 'Al verwerkt' ? 400 : 500);
    return res.status(code).json({ error: result.error });
  }
  res.json({ ok: true });
});

app.post('/api/pending/bulk-approve', async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Geen ids opgegeven' });
  const results = [];
  let sent = 0, failed = 0;
  for (const id of ids) {
    const r = await executePendingAction(id);
    results.push({ id, ...r });
    if (r.ok) sent++; else failed++;
  }
  res.json({ ok: true, sent, failed, results });
});

app.patch('/api/pending/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const action = db.getPendingAction(id);
  if (!action) return res.status(404).json({ error: 'Niet gevonden' });
  if (action.status !== 'pending') return res.status(400).json({ error: 'Al verwerkt, niet meer bewerkbaar' });
  const newSubject = typeof req.body.rendered_subject === 'string' ? req.body.rendered_subject : action.rendered_subject;
  const newBody = typeof req.body.rendered_body === 'string' ? req.body.rendered_body : action.rendered_body;
  db.updatePendingActionBody(id, newSubject, newBody);
  res.json({ ok: true });
});

app.post('/api/pending/:id/skip', (req, res) => {
  const action = db.getPendingAction(parseInt(req.params.id));
  if (!action) return res.status(404).json({ error: 'Niet gevonden' });
  db.updatePendingActionStatus(action.id, 'skipped');
  if (action.campaign_id) db.advanceCampaign(action.campaign_id);
  res.json({ ok: true });
});

app.delete('/api/pending/:id', (req, res) => {
  db.updatePendingActionStatus(parseInt(req.params.id), 'cancelled');
  res.json({ ok: true });
});

// === BRANCHES / CITIES ===
app.get('/api/branches', (_, res) => res.json(db.getBranches()));
app.post('/api/branches', (req, res) => {
  if (!req.body.name || req.body.name.trim().length < 2) return res.status(400).json({ error: 'Naam vereist' });
  db.addBranch(req.body.name);
  db.syncQueue();
  res.json({ ok: true });
});
app.patch('/api/branches/:id', (req, res) => {
  if (typeof req.body.enabled === 'boolean') db.toggleBranch(parseInt(req.params.id), req.body.enabled);
  res.json({ ok: true });
});
app.delete('/api/branches/:id', (req, res) => {
  db.deleteBranch(parseInt(req.params.id));
  res.json({ ok: true });
});

app.get('/api/cities', (_, res) => res.json(db.getCities()));
app.post('/api/cities', (req, res) => {
  if (!req.body.name || req.body.name.trim().length < 2) return res.status(400).json({ error: 'Naam vereist' });
  db.addCity(req.body.name);
  db.syncQueue();
  res.json({ ok: true });
});
app.patch('/api/cities/:id', (req, res) => {
  if (typeof req.body.enabled === 'boolean') db.toggleCity(parseInt(req.params.id), req.body.enabled);
  res.json({ ok: true });
});
app.delete('/api/cities/:id', (req, res) => {
  db.deleteCity(parseInt(req.params.id));
  res.json({ ok: true });
});

// === SETTINGS ===
app.get('/api/settings', (_, res) => res.json(db.getAllSettings()));
app.post('/api/settings', (req, res) => {
  const allowed = ['autopilot_enabled', 'searches_per_hour', 'max_results_per_search', 'repeat_interval_days', 'night_mode', 'sender_name', 'sender_email', 'reply_to', 'company_name', 'signature', 'auto_add_high_score_to_funnel', 'high_score_threshold', 'meeting_booking_url', 'send_paused'];
  for (const k of Object.keys(req.body)) {
    if (allowed.includes(k)) db.setSetting(k, req.body[k]);
  }
  res.json({ ok: true, settings: db.getAllSettings() });
});

// === SCHEDULER ===
app.get('/api/scheduler/status', (_, res) => res.json(scheduler.getStatus()));
app.post('/api/scheduler/run-now', async (_, res) => {
  scheduler.runOneJob().catch(err => console.error(err));
  res.json({ ok: true });
});
app.post('/api/queue/sync', (_, res) => {
  res.json({ ok: true, added: db.syncQueue() });
});

// === PROJECTS ===
app.get('/api/projects', (_, res) => res.json(db.getProjects()));
app.post('/api/projects', (req, res) => {
  const r = db.addProject(req.body);
  res.json({ ok: true, id: r.lastInsertRowid });
});
app.patch('/api/projects/:id', (req, res) => {
  db.updateProject(parseInt(req.params.id), req.body);
  res.json({ ok: true });
});
app.delete('/api/projects/:id', (req, res) => {
  db.deleteProject(parseInt(req.params.id));
  res.json({ ok: true });
});

// === HANDMATIGE SEARCH ===
app.post('/api/search', async (req, res) => {
  const { query, location, max_results = 30, auto_analyze = true } = req.body;
  if (!query || query.trim().length < 2) return res.status(400).json({ error: 'Zoekopdracht vereist' });
  const result = db.createSearch(query.trim(), (location || '').trim() || null);
  const searchId = result.lastInsertRowid;
  res.json({ search_id: searchId, status: 'started' });
  (async () => {
    try {
      const businesses = await scrapeGoogleMaps(query, location, max_results);
      for (const biz of businesses) {
        try { db.insertLead({ search_id: searchId, ...biz, branch_name: query.trim(), city_name: (location || '').trim() || null }); } catch (e) {}
      }
      db.updateSearchStatus(searchId, 'analyzing', businesses.length);
      if (auto_analyze) {
        const leads = db.getUnanalyzedLeads(searchId);
        for (const lead of leads) {
          try {
            const analysis = await analyzeWebsite(lead.website);
            try {
              const ssPath = await takeScreenshot(lead.website, lead.id);
              if (ssPath) {
                analysis.screenshot_path = ssPath;
                await enrichWithVisual(analysis, path.join(getScreenshotDir(), path.basename(ssPath)));
              }
            } catch {}
            db.updateLeadAnalysis(lead.id, analysis);
          } catch (err) {
            db.updateLeadAnalysis(lead.id, { replacement_score: null, issues: [], error: err.message });
          }
        }
      }
      db.updateSearchStatus(searchId, 'done', businesses.length);
    } catch (err) {
      db.updateSearchStatus(searchId, 'error', 0);
    }
  })();
});

app.get('/api/searches', (_, res) => res.json(db.getSearches()));
app.delete('/api/searches/:id', (req, res) => {
  db.deleteSearch(parseInt(req.params.id));
  res.json({ ok: true });
});

// === EXPORT ===
app.get('/api/export.csv', (req, res) => {
  const filters = {
    minScore: req.query.minScore ? parseInt(req.query.minScore) : null,
    contacted: req.query.contacted !== undefined ? (req.query.contacted === 'true' ? 1 : 0) : null,
    branch: req.query.branch || null,
    city: req.query.city || null,
    stage: req.query.stage || null,
    limit: 10000,
  };
  const leads = db.getAllLeads(filters);
  const headers = ['id', 'name', 'address', 'phone', 'website', 'emails', 'rating', 'review_count', 'replacement_score', 'has_https', 'is_mobile_friendly', 'cms_type', 'pagespeed_score', 'copyright_year', 'branch_name', 'city_name', 'stage', 'issues', 'contacted', 'created_at'];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const rows = [headers.join(',')];
  for (const lead of leads) {
    let issues = '', emails = '';
    try { issues = (JSON.parse(lead.issues || '[]')).join(' | '); } catch {}
    try { emails = (JSON.parse(lead.emails || '[]')).join(', '); } catch {}
    rows.push(headers.map(h => {
      if (h === 'issues') return escape(issues);
      if (h === 'emails') return escape(emails);
      return escape(lead[h]);
    }).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${Date.now()}.csv"`);
  res.send(rows.join('\n'));
});

// Catch-all: redirect naar login als niet ingelogd, anders naar index
app.get('*', auth.requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Lead Hunter v4 draait op poort ${PORT}`);
  auth.init();
  scheduler.start();
  sequenceEngine.startEngine();
  imapWatcher.start();
  autoSend.start();
});
