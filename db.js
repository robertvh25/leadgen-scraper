// db.js - SQLite database voor leads
const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'leads.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    location TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_results INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER,
    name TEXT NOT NULL,
    address TEXT,
    phone TEXT,
    website TEXT,
    google_maps_url TEXT,
    rating REAL,
    review_count INTEGER,
    category TEXT,
    -- Analyse velden
    analyzed INTEGER DEFAULT 0,
    replacement_score INTEGER,
    issues TEXT,           -- JSON array
    has_https INTEGER,
    is_mobile_friendly INTEGER,
    has_cms INTEGER,
    cms_type TEXT,
    has_viewport_meta INTEGER,
    has_open_graph INTEGER,
    pagespeed_score INTEGER,
    copyright_year INTEGER,
    last_modified TEXT,
    tech_stack TEXT,       -- JSON array
    analysis_error TEXT,
    -- Tracking
    contacted INTEGER DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (search_id) REFERENCES searches(id),
    UNIQUE(search_id, name, address)
  );

  CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(replacement_score DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_search ON leads(search_id);
`);

// Prepared statements
const stmts = {
  createSearch: db.prepare(`
    INSERT INTO searches (query, location) VALUES (?, ?)
  `),
  updateSearchStatus: db.prepare(`
    UPDATE searches SET status = ?, total_results = ? WHERE id = ?
  `),
  insertLead: db.prepare(`
    INSERT OR IGNORE INTO leads
    (search_id, name, address, phone, website, google_maps_url, rating, review_count, category)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateLeadAnalysis: db.prepare(`
    UPDATE leads SET
      analyzed = 1,
      replacement_score = ?,
      issues = ?,
      has_https = ?,
      is_mobile_friendly = ?,
      has_cms = ?,
      cms_type = ?,
      has_viewport_meta = ?,
      has_open_graph = ?,
      pagespeed_score = ?,
      copyright_year = ?,
      last_modified = ?,
      tech_stack = ?,
      analysis_error = ?
    WHERE id = ?
  `),
  getSearches: db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM leads WHERE search_id = s.id) AS lead_count,
      (SELECT COUNT(*) FROM leads WHERE search_id = s.id AND analyzed = 1) AS analyzed_count
    FROM searches s
    ORDER BY created_at DESC
  `),
  getLeadsBySearch: db.prepare(`
    SELECT * FROM leads WHERE search_id = ?
    ORDER BY replacement_score DESC NULLS LAST, created_at ASC
  `),
  getLead: db.prepare(`SELECT * FROM leads WHERE id = ?`),
  getUnanalyzedLeads: db.prepare(`
    SELECT * FROM leads WHERE search_id = ? AND analyzed = 0 AND website IS NOT NULL AND website != ''
  `),
  markContacted: db.prepare(`UPDATE leads SET contacted = ? WHERE id = ?`),
  updateNotes: db.prepare(`UPDATE leads SET notes = ? WHERE id = ?`),
  deleteSearch: db.prepare(`DELETE FROM searches WHERE id = ?`),
  deleteLeadsBySearch: db.prepare(`DELETE FROM leads WHERE search_id = ?`),
};

module.exports = {
  db,
  createSearch: (query, location) => stmts.createSearch.run(query, location),
  updateSearchStatus: (id, status, total) => stmts.updateSearchStatus.run(status, total, id),
  insertLead: (lead) => stmts.insertLead.run(
    lead.search_id, lead.name, lead.address, lead.phone,
    lead.website, lead.google_maps_url, lead.rating, lead.review_count, lead.category
  ),
  updateLeadAnalysis: (id, analysis) => stmts.updateLeadAnalysis.run(
    analysis.replacement_score,
    JSON.stringify(analysis.issues || []),
    analysis.has_https ? 1 : 0,
    analysis.is_mobile_friendly ? 1 : 0,
    analysis.has_cms ? 1 : 0,
    analysis.cms_type,
    analysis.has_viewport_meta ? 1 : 0,
    analysis.has_open_graph ? 1 : 0,
    analysis.pagespeed_score,
    analysis.copyright_year,
    analysis.last_modified,
    JSON.stringify(analysis.tech_stack || []),
    analysis.error || null,
    id
  ),
  getSearches: () => stmts.getSearches.all(),
  getLeadsBySearch: (searchId) => stmts.getLeadsBySearch.all(searchId),
  getLead: (id) => stmts.getLead.get(id),
  getUnanalyzedLeads: (searchId) => stmts.getUnanalyzedLeads.all(searchId),
  markContacted: (id, contacted) => stmts.markContacted.run(contacted ? 1 : 0, id),
  updateNotes: (id, notes) => stmts.updateNotes.run(notes, id),
  deleteSearch: (id) => {
    stmts.deleteLeadsBySearch.run(id);
    stmts.deleteSearch.run(id);
  },
};
