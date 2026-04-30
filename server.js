// server.js - Express API + scheduler
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeGoogleMaps } = require('./scraper');
const { analyzeWebsite } = require('./analyzer');
const db = require('./db');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// === DASHBOARD ===
app.get('/api/dashboard', (req, res) => {
  res.json({
    stats: db.getDashboardStats(),
    queue: db.getQueueStats(),
    scheduler: scheduler.getStatus(),
    settings: db.getAllSettings(),
    new_today: db.getNewLeadsToday().slice(0, 10),
  });
});

// === LEADS (master view) ===
app.get('/api/leads', (req, res) => {
  const filters = {
    minScore: req.query.minScore ? parseInt(req.query.minScore) : null,
    contacted: req.query.contacted !== undefined
      ? (req.query.contacted === 'true' || req.query.contacted === '1' ? 1 : 0) : null,
    branch: req.query.branch || null,
    city: req.query.city || null,
    limit: req.query.limit ? parseInt(req.query.limit) : 500,
  };
  const leads = db.getAllLeads(filters);
  for (const l of leads) {
    try { l.issues = l.issues ? JSON.parse(l.issues) : []; } catch { l.issues = []; }
    try { l.tech_stack = l.tech_stack ? JSON.parse(l.tech_stack) : []; } catch { l.tech_stack = []; }
    try { l.emails = l.emails ? JSON.parse(l.emails) : []; } catch { l.emails = []; }
  }
  res.json(leads);
});

// === BRANCHES ===
app.get('/api/branches', (_, res) => res.json(db.getBranches()));
app.post('/api/branches', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Naam vereist' });
  db.addBranch(name);
  db.syncQueue();
  res.json({ ok: true });
});
app.patch('/api/branches/:id', (req, res) => {
  if (typeof req.body.enabled === 'boolean') {
    db.toggleBranch(parseInt(req.params.id), req.body.enabled);
  }
  res.json({ ok: true });
});
app.delete('/api/branches/:id', (req, res) => {
  db.deleteBranch(parseInt(req.params.id));
  res.json({ ok: true });
});

// === CITIES ===
app.get('/api/cities', (_, res) => res.json(db.getCities()));
app.post('/api/cities', (req, res) => {
  const { name } = req.body;
  if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Naam vereist' });
  db.addCity(name);
  db.syncQueue();
  res.json({ ok: true });
});
app.patch('/api/cities/:id', (req, res) => {
  if (typeof req.body.enabled === 'boolean') {
    db.toggleCity(parseInt(req.params.id), req.body.enabled);
  }
  res.json({ ok: true });
});
app.delete('/api/cities/:id', (req, res) => {
  db.deleteCity(parseInt(req.params.id));
  res.json({ ok: true });
});

// === SETTINGS ===
app.get('/api/settings', (_, res) => res.json(db.getAllSettings()));
app.post('/api/settings', (req, res) => {
  const allowedKeys = ['autopilot_enabled', 'searches_per_hour', 'max_results_per_search', 'repeat_interval_days', 'night_mode'];
  for (const k of Object.keys(req.body)) {
    if (allowedKeys.includes(k)) {
      db.setSetting(k, req.body[k]);
    }
  }
  res.json({ ok: true, settings: db.getAllSettings() });
});

// === SCHEDULER CONTROL ===
app.get('/api/scheduler/status', (_, res) => res.json(scheduler.getStatus()));
app.post('/api/scheduler/run-now', async (_, res) => {
  // Trigger 1 job direct
  scheduler.runOneJob().catch(err => console.error('Manual run error:', err));
  res.json({ ok: true });
});
app.post('/api/queue/sync', (_, res) => {
  const added = db.syncQueue();
  res.json({ ok: true, added });
});

// === HANDMATIGE SEARCH (oud, nog steeds beschikbaar) ===
app.post('/api/search', async (req, res) => {
  const { query, location, max_results = 30, auto_analyze = true } = req.body;
  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Zoekopdracht vereist' });
  }
  const result = db.createSearch(query.trim(), (location || '').trim() || null);
  const searchId = result.lastInsertRowid;
  res.json({ search_id: searchId, status: 'started' });

  (async () => {
    try {
      const businesses = await scrapeGoogleMaps(query, location, max_results);
      for (const biz of businesses) {
        try {
          db.insertLead({
            search_id: searchId, ...biz,
            branch_name: query.trim(), city_name: (location || '').trim() || null,
          });
        } catch (e) {}
      }
      db.updateSearchStatus(searchId, 'analyzing', businesses.length);

      if (auto_analyze) {
        const leads = db.getUnanalyzedLeads(searchId);
        for (const lead of leads) {
          try {
            const analysis = await analyzeWebsite(lead.website);
            db.updateLeadAnalysis(lead.id, analysis);
          } catch (err) {
            db.updateLeadAnalysis(lead.id, { replacement_score: null, issues: [], error: err.message });
          }
        }
      }
      db.updateSearchStatus(searchId, 'done', businesses.length);
    } catch (err) {
      console.error('Search error:', err);
      db.updateSearchStatus(searchId, 'error', 0);
    }
  })();
});

// === LEADS / SEARCHES (oud) ===
app.get('/api/searches', (_, res) => res.json(db.getSearches()));
app.get('/api/searches/:id/leads', (req, res) => {
  const leads = db.getLeadsBySearch(parseInt(req.params.id));
  for (const l of leads) {
    try { l.issues = l.issues ? JSON.parse(l.issues) : []; } catch { l.issues = []; }
    try { l.tech_stack = l.tech_stack ? JSON.parse(l.tech_stack) : []; } catch { l.tech_stack = []; }
    try { l.emails = l.emails ? JSON.parse(l.emails) : []; } catch { l.emails = []; }
  }
  res.json(leads);
});

app.post('/api/leads/:id/analyze', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Niet gevonden' });
  if (!lead.website) return res.status(400).json({ error: 'Geen website' });
  try {
    const analysis = await analyzeWebsite(lead.website);
    db.updateLeadAnalysis(lead.id, analysis);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (typeof req.body.contacted === 'boolean') db.markContacted(id, req.body.contacted);
  if (typeof req.body.notes === 'string') db.updateNotes(id, req.body.notes);
  res.json({ ok: true });
});

app.delete('/api/searches/:id', (req, res) => {
  db.deleteSearch(parseInt(req.params.id));
  res.json({ ok: true });
});

// === EXPORT ===
app.get('/api/export.csv', (req, res) => {
  const filters = {
    minScore: req.query.minScore ? parseInt(req.query.minScore) : null,
    contacted: req.query.contacted !== undefined
      ? (req.query.contacted === 'true' ? 1 : 0) : null,
    branch: req.query.branch || null,
    city: req.query.city || null,
    limit: 10000,
  };
  const leads = db.getAllLeads(filters);
  const headers = [
    'name', 'address', 'phone', 'website', 'emails', 'rating', 'review_count',
    'replacement_score', 'has_https', 'is_mobile_friendly', 'cms_type',
    'pagespeed_score', 'copyright_year', 'branch_name', 'city_name',
    'issues', 'contacted', 'created_at',
  ];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const rows = [headers.join(',')];
  for (const lead of leads) {
    let issues = '';
    let emails = '';
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

app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`🚀 Lead Hunter draait op poort ${PORT}`);
  // Start scheduler (zelf checkt of autopilot_enabled = 1)
  scheduler.start();
});
