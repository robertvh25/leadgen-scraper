// server.js - Express API + scheduler + sequence engine + auth
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { scrapeGoogleMaps } = require('./scraper');
const { analyzeWebsite } = require('./analyzer');
const { takeScreenshot, getScreenshotDir } = require('./lib/screenshot');
const { render, listAvailableVars } = require('./lib/template-renderer');
const { sendEmail } = require('./lib/email-sender');
const { sendWhatsApp, buildWhatsAppLink, normalizePhone } = require('./lib/whatsapp-sender');
const sequenceEngine = require('./lib/sequence-engine');
const auth = require('./lib/auth');
const db = require('./db');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;
const COOKIE_SECURE = process.env.NODE_ENV === 'production';

app.set('trust proxy', 1); // Belangrijk: voor secure cookies achter Traefik
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());

// === LOGIN PAGES (PUBLIC) ===
app.get('/login.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Health (public)
app.get('/health', (_, res) => res.json({ ok: true }));

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
  res.json({
    stats: db.getDashboardStats(),
    queue: db.getQueueStats(),
    scheduler: scheduler.getStatus(),
    settings: db.getAllSettings(),
    new_today: parseLeadList(db.getNewLeadsToday().slice(0, 12)),
    pending_count: db.countPendingActions(),
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
  res.json(lead);
});

app.patch('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  const lead = db.getLead(id);
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  if (typeof req.body.contacted === 'boolean') db.markContacted(id, req.body.contacted);
  if (typeof req.body.notes === 'string') db.updateNotes(id, req.body.notes);
  if (typeof req.body.stage === 'string') {
    const newStage = req.body.stage;
    const valid = ['new', 'contacted', 'engaged', 'quote_sent', 'signed', 'project', 'lost'];
    if (!valid.includes(newStage)) return res.status(400).json({ error: 'Ongeldige stage' });
    db.updateLeadStage(id, newStage);
    if (newStage !== 'new' && newStage !== lead.stage) {
      sequenceEngine.autoStartCampaignsForStage(id, newStage);
    }
  }
  res.json({ ok: true });
});

app.post('/api/leads/:id/analyze', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  if (!lead.website) return res.status(400).json({ error: 'Geen website' });
  try {
    const analysis = await analyzeWebsite(lead.website);
    try {
      const ssPath = await takeScreenshot(lead.website, lead.id);
      if (ssPath) analysis.screenshot_path = ssPath;
    } catch (e) {}
    db.updateLeadAnalysis(lead.id, analysis);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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

app.post('/api/pending/:id/approve', async (req, res) => {
  const id = parseInt(req.params.id);
  const action = db.getPendingAction(id);
  if (!action) return res.status(404).json({ error: 'Niet gevonden' });
  if (action.status !== 'pending') return res.status(400).json({ error: 'Al verwerkt' });
  try {
    let recipient = action.recipient;
    if (!recipient) {
      const lead = db.getLead(action.lead_id);
      if (lead) {
        if (action.type === 'email') {
          try { const emails = lead.emails ? JSON.parse(lead.emails) : []; recipient = emails[0]; } catch {}
        } else if (action.type === 'whatsapp') { recipient = lead.phone; }
      }
    }
    if (!recipient) {
      db.updatePendingActionStatus(id, 'failed');
      return res.status(400).json({ error: 'Geen ontvanger' });
    }
    if (action.type === 'email') {
      await sendEmail({ to: recipient, subject: action.rendered_subject, body: action.rendered_body, leadId: action.lead_id });
    } else if (action.type === 'whatsapp') {
      await sendWhatsApp({ to: recipient, body: action.rendered_body, leadId: action.lead_id });
    }
    db.updatePendingActionStatus(id, 'sent');
    if (action.campaign_id) db.advanceCampaign(action.campaign_id);
    res.json({ ok: true });
  } catch (err) {
    db.updatePendingActionStatus(id, 'failed');
    res.status(500).json({ error: err.message });
  }
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
  const allowed = ['autopilot_enabled', 'searches_per_hour', 'max_results_per_search', 'repeat_interval_days', 'night_mode', 'sender_name', 'sender_email', 'reply_to', 'company_name', 'signature', 'auto_add_high_score_to_funnel', 'high_score_threshold'];
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
            try { const ssPath = await takeScreenshot(lead.website, lead.id); if (ssPath) analysis.screenshot_path = ssPath; } catch {}
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
});
