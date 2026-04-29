// server.js - Express API server
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { scrapeGoogleMaps } = require('./scraper');
const { analyzeWebsite } = require('./analyzer');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// In-memory storage van actieve jobs (voor SSE progress)
const jobProgress = new Map();

function emitProgress(searchId, data) {
  const listeners = jobProgress.get(searchId) || [];
  for (const res of listeners) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }
}

// === API ROUTES ===

// Start een nieuwe zoekopdracht (async)
app.post('/api/search', async (req, res) => {
  const { query, location, max_results = 30, auto_analyze = true } = req.body;

  if (!query || query.trim().length < 2) {
    return res.status(400).json({ error: 'Zoekopdracht is verplicht' });
  }

  const result = db.createSearch(query.trim(), (location || '').trim() || null);
  const searchId = result.lastInsertRowid;

  res.json({ search_id: searchId, status: 'started' });

  // Achtergrond proces
  (async () => {
    try {
      const onProgress = (data) => emitProgress(searchId, { type: 'scrape', ...data });

      const businesses = await scrapeGoogleMaps(query, location, max_results, onProgress);

      for (const biz of businesses) {
        try {
          db.insertLead({ search_id: searchId, ...biz });
        } catch (e) {
          console.error('Insert lead error:', e.message);
        }
      }

      db.updateSearchStatus(searchId, 'analyzing', businesses.length);
      emitProgress(searchId, {
        type: 'scrape_done',
        message: `${businesses.length} bedrijven opgeslagen`,
        count: businesses.length,
      });

      if (auto_analyze) {
        const leads = db.getUnanalyzedLeads(searchId);
        let i = 0;
        for (const lead of leads) {
          i++;
          emitProgress(searchId, {
            type: 'analyze',
            message: `Analyse ${i}/${leads.length}: ${lead.name}`,
            progress: i,
            total: leads.length,
          });

          try {
            const analysis = await analyzeWebsite(lead.website);
            db.updateLeadAnalysis(lead.id, analysis);
          } catch (err) {
            console.error(`Analyse error voor ${lead.name}:`, err.message);
            db.updateLeadAnalysis(lead.id, {
              replacement_score: null,
              issues: [],
              error: err.message,
            });
          }
        }
      }

      db.updateSearchStatus(searchId, 'done', businesses.length);
      emitProgress(searchId, { type: 'done', message: 'Klaar!' });
    } catch (err) {
      console.error('Job error:', err);
      db.updateSearchStatus(searchId, 'error', 0);
      emitProgress(searchId, { type: 'error', message: err.message });
    } finally {
      // Cleanup listeners
      setTimeout(() => jobProgress.delete(searchId), 5000);
    }
  })();
});

// Server-Sent Events endpoint voor live progress
app.get('/api/search/:id/stream', (req, res) => {
  const searchId = parseInt(req.params.id);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('data: {"type":"connected"}\n\n');

  if (!jobProgress.has(searchId)) jobProgress.set(searchId, []);
  jobProgress.get(searchId).push(res);

  req.on('close', () => {
    const listeners = jobProgress.get(searchId) || [];
    const idx = listeners.indexOf(res);
    if (idx >= 0) listeners.splice(idx, 1);
  });
});

// Lijst alle zoekopdrachten
app.get('/api/searches', (req, res) => {
  res.json(db.getSearches());
});

// Krijg leads voor een zoekopdracht
app.get('/api/searches/:id/leads', (req, res) => {
  const leads = db.getLeadsBySearch(parseInt(req.params.id));
  // Parse JSON velden
  for (const lead of leads) {
    try { lead.issues = lead.issues ? JSON.parse(lead.issues) : []; } catch { lead.issues = []; }
    try { lead.tech_stack = lead.tech_stack ? JSON.parse(lead.tech_stack) : []; } catch { lead.tech_stack = []; }
  }
  res.json(leads);
});

// Re-analyse van een specifieke lead
app.post('/api/leads/:id/analyze', async (req, res) => {
  const lead = db.getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead niet gevonden' });
  if (!lead.website) return res.status(400).json({ error: 'Geen website' });

  try {
    const analysis = await analyzeWebsite(lead.website);
    db.updateLeadAnalysis(lead.id, analysis);
    res.json({ ...lead, ...analysis, issues: analysis.issues, tech_stack: analysis.tech_stack });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark contacted
app.patch('/api/leads/:id', (req, res) => {
  const id = parseInt(req.params.id);
  if (typeof req.body.contacted === 'boolean') {
    db.markContacted(id, req.body.contacted);
  }
  if (typeof req.body.notes === 'string') {
    db.updateNotes(id, req.body.notes);
  }
  res.json({ ok: true });
});

// Verwijder zoekopdracht
app.delete('/api/searches/:id', (req, res) => {
  db.deleteSearch(parseInt(req.params.id));
  res.json({ ok: true });
});

// CSV export
app.get('/api/searches/:id/export.csv', (req, res) => {
  const leads = db.getLeadsBySearch(parseInt(req.params.id));
  const headers = [
    'name', 'address', 'phone', 'website', 'rating', 'review_count',
    'replacement_score', 'has_https', 'is_mobile_friendly', 'cms_type',
    'pagespeed_score', 'copyright_year', 'issues', 'contacted',
  ];
  const escape = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const rows = [headers.join(',')];
  for (const lead of leads) {
    let issues = '';
    try { issues = (JSON.parse(lead.issues || '[]')).join(' | '); } catch {}
    rows.push(headers.map(h => {
      if (h === 'issues') return escape(issues);
      return escape(lead[h]);
    }).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-${req.params.id}.csv"`);
  res.send(rows.join('\n'));
});

// Health check
app.get('/health', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`🚀 Lead-gen scraper draait op poort ${PORT}`);
});
