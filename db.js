// db.js - SQLite database voor leads + queue + settings
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

function resolveDbPath() {
  const preferred = process.env.DB_PATH || '/data/leads.db';
  const dir = path.dirname(preferred);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    console.log(`✓ Database pad: ${preferred}`);
    return preferred;
  } catch (err) {
    const fallback = path.join(__dirname, 'leads.db');
    console.warn(`⚠ Kan niet schrijven naar ${dir} (${err.code}), gebruik fallback: ${fallback}`);
    return fallback;
  }
}

const dbPath = resolveDbPath();
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS branches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS cities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_name TEXT NOT NULL,
    city_name TEXT NOT NULL,
    last_run DATETIME,
    last_status TEXT,
    next_run DATETIME,
    leads_found INTEGER DEFAULT 0,
    error_count INTEGER DEFAULT 0,
    UNIQUE(branch_name, city_name)
  );
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS searches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    query TEXT NOT NULL,
    location TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    total_results INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running',
    auto INTEGER DEFAULT 0
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
    branch_name TEXT,
    city_name TEXT,
    analyzed INTEGER DEFAULT 0,
    replacement_score INTEGER,
    issues TEXT,
    has_https INTEGER,
    is_mobile_friendly INTEGER,
    has_cms INTEGER,
    cms_type TEXT,
    has_viewport_meta INTEGER,
    has_open_graph INTEGER,
    pagespeed_score INTEGER,
    copyright_year INTEGER,
    last_modified TEXT,
    tech_stack TEXT,
    analysis_error TEXT,
    emails TEXT,
    contacted INTEGER DEFAULT 0,
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (search_id) REFERENCES searches(id),
    UNIQUE(name, address)
  );
  CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(replacement_score DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_search ON leads(search_id);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_queue_next ON queue(next_run);
`);

function addColumnIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) {}
  }
}
addColumnIfMissing('leads', 'branch_name', 'TEXT');
addColumnIfMissing('leads', 'city_name', 'TEXT');
addColumnIfMissing('leads', 'emails', 'TEXT');
addColumnIfMissing('searches', 'auto', 'INTEGER DEFAULT 0');

function seedDefaults() {
  const branchCount = db.prepare(`SELECT COUNT(*) AS c FROM branches`).get().c;
  if (branchCount === 0) {
    const branches = [
      'kozijnbedrijf', 'kunststof kozijnen', 'aluminium kozijnen', 'houten kozijnen',
      'dakkapel installateur', 'zonwering bedrijf', 'rolluiken bedrijf',
      'gevelbekleding bedrijf', 'serrebouwer', 'glaszetter',
      'horren specialist', 'schuifpui leverancier',
    ];
    const stmt = db.prepare(`INSERT OR IGNORE INTO branches (name) VALUES (?)`);
    for (const b of branches) stmt.run(b);
    console.log(`✓ ${branches.length} default branches geseed`);
  }
  const cityCount = db.prepare(`SELECT COUNT(*) AS c FROM cities`).get().c;
  if (cityCount === 0) {
    const cities = [
      'Amsterdam', 'Rotterdam', 'Den Haag', 'Utrecht', 'Eindhoven',
      'Groningen', 'Tilburg', 'Almere', 'Breda', 'Nijmegen',
      'Apeldoorn', 'Haarlem', 'Enschede', 'Arnhem', 'Amersfoort',
      'Zaanstad', 'Den Bosch', 'Haarlemmermeer', 'Zwolle', 'Zoetermeer',
      'Leeuwarden', 'Leiden', 'Maastricht', 'Dordrecht', 'Alphen aan den Rijn',
      'Alkmaar', 'Delft', 'Venlo', 'Deventer', 'Sittard',
      'Helmond', 'Hilversum', 'Heerlen', 'Oss', 'Amstelveen',
      'Hoofddorp', 'Roosendaal', 'Purmerend', 'Vlaardingen', 'Capelle aan den IJssel',
      'Nieuwegein', 'Bergen op Zoom', 'Spijkenisse', 'Hengelo', 'Roermond',
      'Almelo', 'Gouda', 'Lelystad', 'Schiedam', 'Veenendaal',
    ];
    const stmt = db.prepare(`INSERT OR IGNORE INTO cities (name) VALUES (?)`);
    for (const c of cities) stmt.run(c);
    console.log(`✓ ${cities.length} default cities geseed`);
  }
  const defaults = {
    autopilot_enabled: '0',
    searches_per_hour: '3',
    max_results_per_search: '20',
    repeat_interval_days: '14',
    night_mode: '1',
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(k, v);
  }
}
seedDefaults();

function syncQueue() {
  const branches = db.prepare(`SELECT name FROM branches WHERE enabled = 1`).all();
  const cities = db.prepare(`SELECT name FROM cities WHERE enabled = 1`).all();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO queue (branch_name, city_name, next_run)
    VALUES (?, ?, datetime('now'))
  `);
  let added = 0;
  for (const b of branches) {
    for (const c of cities) {
      const r = insert.run(b.name, c.name);
      if (r.changes > 0) added++;
    }
  }
  if (added > 0) console.log(`✓ Queue sync: ${added} nieuwe combinaties toegevoegd`);
  return added;
}

const stmts = {
  getSetting: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  setSetting: db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`),
  getAllSettings: db.prepare(`SELECT key, value FROM settings`),
  getBranches: db.prepare(`SELECT * FROM branches ORDER BY enabled DESC, name`),
  insertBranch: db.prepare(`INSERT OR IGNORE INTO branches (name) VALUES (?)`),
  toggleBranch: db.prepare(`UPDATE branches SET enabled = ? WHERE id = ?`),
  deleteBranch: db.prepare(`DELETE FROM branches WHERE id = ?`),
  getCities: db.prepare(`SELECT * FROM cities ORDER BY enabled DESC, name`),
  insertCity: db.prepare(`INSERT OR IGNORE INTO cities (name) VALUES (?)`),
  toggleCity: db.prepare(`UPDATE cities SET enabled = ? WHERE id = ?`),
  deleteCity: db.prepare(`DELETE FROM cities WHERE id = ?`),
  getQueueStats: db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN last_run IS NULL THEN 1 ELSE 0 END) AS never_run,
      SUM(CASE WHEN last_run IS NOT NULL THEN 1 ELSE 0 END) AS run_at_least_once,
      SUM(CASE WHEN next_run <= datetime('now') THEN 1 ELSE 0 END) AS due_now
    FROM queue
  `),
  pickNextQueueItem: db.prepare(`
    SELECT * FROM queue
    WHERE next_run <= datetime('now') AND error_count < 5
    ORDER BY
      CASE WHEN last_run IS NULL THEN 0 ELSE 1 END,
      next_run ASC, RANDOM()
    LIMIT 1
  `),
  updateQueueItem: db.prepare(`
    UPDATE queue SET
      last_run = datetime('now'),
      last_status = ?,
      next_run = datetime('now', '+' || ? || ' days'),
      leads_found = leads_found + ?,
      error_count = CASE WHEN ? = 'error' THEN error_count + 1 ELSE 0 END
    WHERE id = ?
  `),
  rescheduleQueueItem: db.prepare(`
    UPDATE queue SET next_run = datetime('now', '+' || ? || ' minutes') WHERE id = ?
  `),
  getRecentQueueRuns: db.prepare(`
    SELECT * FROM queue WHERE last_run IS NOT NULL ORDER BY last_run DESC LIMIT 20
  `),
  createSearch: db.prepare(`INSERT INTO searches (query, location, auto) VALUES (?, ?, ?)`),
  updateSearchStatus: db.prepare(`UPDATE searches SET status = ?, total_results = ? WHERE id = ?`),
  insertLead: db.prepare(`
    INSERT OR IGNORE INTO leads
    (search_id, name, address, phone, website, google_maps_url, rating, review_count, category, branch_name, city_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateLeadAnalysis: db.prepare(`
    UPDATE leads SET
      analyzed = 1, replacement_score = ?, issues = ?,
      has_https = ?, is_mobile_friendly = ?, has_cms = ?, cms_type = ?,
      has_viewport_meta = ?, has_open_graph = ?, pagespeed_score = ?,
      copyright_year = ?, last_modified = ?, tech_stack = ?,
      analysis_error = ?, emails = ?
    WHERE id = ?
  `),
  getSearches: db.prepare(`
    SELECT s.*,
      (SELECT COUNT(*) FROM leads WHERE search_id = s.id) AS lead_count,
      (SELECT COUNT(*) FROM leads WHERE search_id = s.id AND analyzed = 1) AS analyzed_count
    FROM searches s ORDER BY created_at DESC LIMIT 100
  `),
  getLeadsBySearch: db.prepare(`
    SELECT * FROM leads WHERE search_id = ?
    ORDER BY replacement_score DESC NULLS LAST, created_at ASC
  `),
  getAllLeads: db.prepare(`
    SELECT * FROM leads
    WHERE (?1 IS NULL OR replacement_score >= ?1)
      AND (?2 IS NULL OR contacted = ?2)
      AND (?3 IS NULL OR branch_name = ?3)
      AND (?4 IS NULL OR city_name = ?4)
    ORDER BY replacement_score DESC NULLS LAST, created_at DESC
    LIMIT ?5
  `),
  getNewLeadsToday: db.prepare(`
    SELECT * FROM leads WHERE created_at >= datetime('now', '-1 day')
    ORDER BY replacement_score DESC NULLS LAST LIMIT 50
  `),
  getLead: db.prepare(`SELECT * FROM leads WHERE id = ?`),
  getUnanalyzedLeads: db.prepare(`
    SELECT * FROM leads WHERE search_id = ? AND analyzed = 0 AND website IS NOT NULL AND website != ''
  `),
  markContacted: db.prepare(`UPDATE leads SET contacted = ? WHERE id = ?`),
  updateNotes: db.prepare(`UPDATE leads SET notes = ? WHERE id = ?`),
  deleteSearch: db.prepare(`DELETE FROM searches WHERE id = ?`),
  deleteLeadsBySearch: db.prepare(`DELETE FROM leads WHERE search_id = ?`),
  getDashboardStats: db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM leads) AS total_leads,
      (SELECT COUNT(*) FROM leads WHERE analyzed = 1) AS analyzed_leads,
      (SELECT COUNT(*) FROM leads WHERE replacement_score >= 60) AS high_score_leads,
      (SELECT COUNT(*) FROM leads WHERE created_at >= datetime('now', '-1 day')) AS leads_today,
      (SELECT COUNT(*) FROM leads WHERE contacted = 1) AS contacted,
      (SELECT COUNT(DISTINCT branch_name) FROM leads) AS unique_branches,
      (SELECT COUNT(DISTINCT city_name) FROM leads) AS unique_cities
  `),
};

module.exports = {
  db, syncQueue,
  getSetting: (key) => stmts.getSetting.get(key)?.value,
  setSetting: (key, value) => stmts.setSetting.run(key, String(value)),
  getAllSettings: () => {
    const rows = stmts.getAllSettings.all();
    const obj = {};
    for (const r of rows) obj[r.key] = r.value;
    return obj;
  },
  getBranches: () => stmts.getBranches.all(),
  addBranch: (name) => stmts.insertBranch.run(name.trim()),
  toggleBranch: (id, enabled) => stmts.toggleBranch.run(enabled ? 1 : 0, id),
  deleteBranch: (id) => stmts.deleteBranch.run(id),
  getCities: () => stmts.getCities.all(),
  addCity: (name) => stmts.insertCity.run(name.trim()),
  toggleCity: (id, enabled) => stmts.toggleCity.run(enabled ? 1 : 0, id),
  deleteCity: (id) => stmts.deleteCity.run(id),
  getQueueStats: () => stmts.getQueueStats.get(),
  pickNextQueueItem: () => stmts.pickNextQueueItem.get(),
  updateQueueItem: (id, status, intervalDays, leadsFound) =>
    stmts.updateQueueItem.run(status, intervalDays, leadsFound, status, id),
  rescheduleQueueItem: (id, minutes) => stmts.rescheduleQueueItem.run(minutes, id),
  getRecentQueueRuns: () => stmts.getRecentQueueRuns.all(),
  createSearch: (query, location, auto = false) =>
    stmts.createSearch.run(query, location, auto ? 1 : 0),
  updateSearchStatus: (id, status, total) => stmts.updateSearchStatus.run(status, total, id),
  insertLead: (lead) => stmts.insertLead.run(
    lead.search_id, lead.name, lead.address, lead.phone,
    lead.website, lead.google_maps_url, lead.rating, lead.review_count, lead.category,
    lead.branch_name || null, lead.city_name || null
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
    JSON.stringify(analysis.emails || []),
    id
  ),
  getSearches: () => stmts.getSearches.all(),
  getLeadsBySearch: (searchId) => stmts.getLeadsBySearch.all(searchId),
  getAllLeads: (filters = {}) => stmts.getAllLeads.all(
    filters.minScore ?? null,
    filters.contacted ?? null,
    filters.branch ?? null,
    filters.city ?? null,
    filters.limit ?? 500
  ),
  getNewLeadsToday: () => stmts.getNewLeadsToday.all(),
  getLead: (id) => stmts.getLead.get(id),
  getUnanalyzedLeads: (searchId) => stmts.getUnanalyzedLeads.all(searchId),
  markContacted: (id, contacted) => stmts.markContacted.run(contacted ? 1 : 0, id),
  updateNotes: (id, notes) => stmts.updateNotes.run(notes, id),
  deleteSearch: (id) => {
    stmts.deleteLeadsBySearch.run(id);
    stmts.deleteSearch.run(id);
  },
  getDashboardStats: () => stmts.getDashboardStats.get(),
};
