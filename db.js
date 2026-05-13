// db.js - SQLite database
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
    console.warn(`⚠ Fallback DB pad: ${fallback}`);
    return fallback;
  }
}

const dbPath = resolveDbPath();
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// === Schema ===
db.exec(`
  CREATE TABLE IF NOT EXISTS branches (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS cities (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, enabled INTEGER DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP);
  CREATE TABLE IF NOT EXISTS queue (id INTEGER PRIMARY KEY AUTOINCREMENT, branch_name TEXT NOT NULL, city_name TEXT NOT NULL, last_run DATETIME, last_status TEXT, next_run DATETIME, leads_found INTEGER DEFAULT 0, error_count INTEGER DEFAULT 0, UNIQUE(branch_name, city_name));
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS searches (id INTEGER PRIMARY KEY AUTOINCREMENT, query TEXT NOT NULL, location TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, total_results INTEGER DEFAULT 0, status TEXT DEFAULT 'running', auto INTEGER DEFAULT 0);
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    search_id INTEGER, name TEXT NOT NULL, address TEXT, phone TEXT, website TEXT,
    google_maps_url TEXT, rating REAL, review_count INTEGER, category TEXT,
    branch_name TEXT, city_name TEXT,
    analyzed INTEGER DEFAULT 0, replacement_score INTEGER, issues TEXT,
    has_https INTEGER, is_mobile_friendly INTEGER, has_cms INTEGER, cms_type TEXT,
    has_viewport_meta INTEGER, has_open_graph INTEGER, pagespeed_score INTEGER,
    copyright_year INTEGER, last_modified TEXT, tech_stack TEXT, analysis_error TEXT,
    emails TEXT, screenshot_path TEXT,
    contacted INTEGER DEFAULT 0, notes TEXT,
    stage TEXT DEFAULT 'new',
    deal_added_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(name, address)
  );
  CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(replacement_score DESC);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
  CREATE INDEX IF NOT EXISTS idx_leads_created ON leads(created_at DESC);

  CREATE TABLE IF NOT EXISTS templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'email',
    subject TEXT,
    body TEXT NOT NULL,
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sequences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    trigger_stage TEXT DEFAULT 'contacted',
    enabled INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sequence_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sequence_id INTEGER NOT NULL,
    step_order INTEGER NOT NULL,
    template_id INTEGER NOT NULL,
    delay_days INTEGER DEFAULT 0,
    require_approval INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS lead_campaigns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    sequence_id INTEGER NOT NULL,
    current_step INTEGER DEFAULT 0,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_action_at DATETIME,
    status TEXT DEFAULT 'active',
    UNIQUE(lead_id, sequence_id)
  );
  CREATE TABLE IF NOT EXISTS pending_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    campaign_id INTEGER,
    step_id INTEGER,
    type TEXT NOT NULL,
    template_id INTEGER,
    rendered_subject TEXT,
    rendered_body TEXT,
    recipient TEXT,
    scheduled_for DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_pending_status ON pending_actions(status);

  CREATE TABLE IF NOT EXISTS communications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    direction TEXT DEFAULT 'outbound',
    subject TEXT,
    body TEXT,
    recipient TEXT,
    status TEXT DEFAULT 'sent',
    error TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_comms_lead ON communications(lead_id);

  CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    name TEXT NOT NULL,
    status TEXT DEFAULT 'planning',
    notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    calcom_uid TEXT UNIQUE,
    event_type TEXT,
    scheduled_at DATETIME,
    end_at DATETIME,
    attendee_email TEXT,
    attendee_name TEXT,
    meet_url TEXT,
    location TEXT,
    status TEXT DEFAULT 'confirmed',
    raw_payload TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_lead ON bookings(lead_id);
  CREATE INDEX IF NOT EXISTS idx_bookings_scheduled ON bookings(scheduled_at);
`);

// Migration helpers
function addColumnIfMissing(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.find(c => c.name === col)) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); } catch (e) {}
  }
}
addColumnIfMissing('leads', 'screenshot_path', 'TEXT');
addColumnIfMissing('leads', 'stage', `TEXT DEFAULT 'new'`);
addColumnIfMissing('leads', 'deal_added_at', 'DATETIME');
addColumnIfMissing('pending_actions', 'auto_send', 'INTEGER DEFAULT 0');
addColumnIfMissing('pending_actions', 'in_reply_to_message_id', 'TEXT');
addColumnIfMissing('pending_actions', 'intent', 'TEXT');
addColumnIfMissing('communications', 'read', 'INTEGER DEFAULT 0');
addColumnIfMissing('leads', 'briefing_slug', 'TEXT');
addColumnIfMissing('leads', 'dismissed', 'INTEGER DEFAULT 0');
addColumnIfMissing('leads', 'loss_reason', 'TEXT');
addColumnIfMissing('leads', 'lost_at', 'DATETIME');
// Bestaande outbound communications hoeven niet "ongelezen" te staan
try { db.exec(`UPDATE communications SET read = 1 WHERE direction = 'outbound' AND (read = 0 OR read IS NULL)`); } catch {}

const STAGE_ORDER = {
  new: 0, contacted: 1, engaged: 2, meeting_planned: 3, briefing_sent: 4, project: 5,
};

// Set default stage for any lead without one (existing leads)
db.exec(`UPDATE leads SET stage = 'new' WHERE stage IS NULL OR stage = ''`);

// One-time migration v4.27: leads met pending email-action moeten stage 'contacted' hebben
try {
  const flag = db.prepare(`SELECT value FROM settings WHERE key = ?`).get('migration_v4_27_pending_to_contacted');
  if (!flag) {
    const r = db.exec(`UPDATE leads SET stage = 'contacted' WHERE stage = 'new' AND id IN (SELECT DISTINCT lead_id FROM pending_actions WHERE type = 'email' AND auto_send = 1 AND lead_id IS NOT NULL AND status = 'pending')`);
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run('migration_v4_27_pending_to_contacted', '1');
    console.log('✓ Migration v4.27: leads met pending mail naar contacted gezet');
  }
} catch (e) { console.error('Migration v4.27 error:', e.message); }

// Migration v4.37: eerste sequence-stap altijd auto-send (eerste mail zonder approval)
try {
  const r = db.exec(`UPDATE pending_actions SET auto_send = 1 WHERE status = 'pending' AND type = 'email' AND auto_send = 0 AND step_id IN (SELECT id FROM sequence_steps WHERE step_order = 1)`);
  console.log('✓ Migration v4.37: pending eerste-stap email-actions naar auto_send=1');
} catch (e) { console.error('Migration v4.37 error:', e.message); }

// Migration v4.40: ruim queue-entries op voor disabled branches/cities
try {
  const r1 = db.prepare(`DELETE FROM queue WHERE city_name IN (SELECT name FROM cities WHERE enabled = 0)`).run();
  const r2 = db.prepare(`DELETE FROM queue WHERE branch_name IN (SELECT name FROM branches WHERE enabled = 0)`).run();
  const total = (r1.changes || 0) + (r2.changes || 0);
  if (total > 0) console.log(`✓ Migration v4.40: ${total} queue-entries voor disabled branches/cities verwijderd`);
} catch (e) { console.error('Migration v4.40 error:', e.message); }

// Migration v4.44: seed "voip pbx" als interne roadmap-project (1x)
try {
  const exists = db.prepare(`SELECT id FROM projects WHERE name = ?`).get('voip pbx');
  if (!exists) {
    db.prepare(`INSERT INTO projects (lead_id, name, status, notes) VALUES (?, ?, ?, ?)`).run(
      null, 'voip pbx', 'planning',
      `Self-hosted PBX-as-a-service voor klanten. Klant koppelt VoIP-nummer en routeert naar:
- gebruiker (extensie)
- wachtrij (queue)
- keuzemenu (IVR)

Stack: FreePBX in Docker (tiredofit/freepbx). Repo: ~/Projects/voip-pbx.
Volgende stap: subdomain pbx.aitomade.nl + Hetzner firewall openen (UDP 5060, 10000-20000) + Coolify-app aanmaken.

Toekomstig migratiepad voor multi-tenant: FusionPBX.`
    );
    console.log('✓ Migration v4.44: voip pbx project toegevoegd');
  }
} catch (e) { console.error('Migration v4.44 error:', e.message); }

function seedDefaults() {
  if (db.prepare(`SELECT COUNT(*) AS c FROM branches`).get().c === 0) {
    const items = ['kozijnbedrijf', 'kunststof kozijnen', 'aluminium kozijnen', 'houten kozijnen', 'dakkapel installateur', 'zonwering bedrijf', 'rolluiken bedrijf', 'gevelbekleding bedrijf', 'serrebouwer', 'glaszetter', 'horren specialist', 'schuifpui leverancier'];
    const stmt = db.prepare(`INSERT OR IGNORE INTO branches (name) VALUES (?)`);
    for (const i of items) stmt.run(i);
  }
  if (db.prepare(`SELECT COUNT(*) AS c FROM cities`).get().c === 0) {
    const items = ['Amsterdam', 'Rotterdam', 'Den Haag', 'Utrecht', 'Eindhoven', 'Groningen', 'Tilburg', 'Almere', 'Breda', 'Nijmegen', 'Apeldoorn', 'Haarlem', 'Enschede', 'Arnhem', 'Amersfoort', 'Zaanstad', 'Den Bosch', 'Haarlemmermeer', 'Zwolle', 'Zoetermeer', 'Leeuwarden', 'Leiden', 'Maastricht', 'Dordrecht', 'Alphen aan den Rijn', 'Alkmaar', 'Delft', 'Venlo', 'Deventer', 'Sittard', 'Helmond', 'Hilversum', 'Heerlen', 'Oss', 'Amstelveen', 'Hoofddorp', 'Roosendaal', 'Purmerend', 'Vlaardingen', 'Capelle aan den IJssel', 'Nieuwegein', 'Bergen op Zoom', 'Spijkenisse', 'Hengelo', 'Roermond', 'Almelo', 'Gouda', 'Lelystad', 'Schiedam', 'Veenendaal'];
    const stmt = db.prepare(`INSERT OR IGNORE INTO cities (name) VALUES (?)`);
    for (const i of items) stmt.run(i);
  }
  const defaults = {
    autopilot_enabled: '0', searches_per_hour: '3', max_results_per_search: '20',
    repeat_interval_days: '14', night_mode: '1',
    sender_name: 'Robert van Hoof', sender_email: '', reply_to: '',
    company_name: 'Aitomade', signature: 'Met vriendelijke groet,\nRobert van Hoof\nAitomade',
    auto_add_high_score_to_funnel: '0', high_score_threshold: '70',
  };
  for (const [k, v] of Object.entries(defaults)) {
    db.prepare(`INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)`).run(k, v);
  }
  // Default email template
  if (db.prepare(`SELECT COUNT(*) AS c FROM templates`).get().c === 0) {
    db.prepare(`INSERT INTO templates (name, type, subject, body) VALUES (?, ?, ?, ?)`).run(
      'Eerste contact - website verouderd',
      'email',
      'Vraag over uw website {{lead.website_short}}',
      `Hallo,

Ik bekeek uw website {{lead.website}} tijdens onderzoek naar {{lead.branch_name}} bedrijven in {{lead.city_name}}.

Wat me opviel:
- {{lead.first_issue}}
- PageSpeed score: {{lead.pagespeed_score}}/100

Een moderne, mobiel-vriendelijke website levert tegenwoordig 30-50% meer aanvragen op. Ik help kozijnbedrijven met websites die echt werken.

Heeft u 10 minuten voor een vrijblijvend gesprek?

{{settings.signature}}`
    );
    db.prepare(`INSERT INTO templates (name, type, subject, body) VALUES (?, ?, ?, ?)`).run(
      'Follow-up 1 - na 3 dagen',
      'email',
      'RE: uw website {{lead.website_short}}',
      `Hallo,

Ik mailde u onlangs over de website van {{lead.name}}. Wellicht is mijn bericht in spam beland of niet doorgekomen.

Korte vraag: bent u tevreden met het aantal aanvragen via {{lead.website_short}}?

Als het antwoord "kan beter" is, laat me dan vrijblijvend zien hoe een nieuwe website het verschil kan maken.

{{settings.signature}}`
    );
    db.prepare(`INSERT INTO templates (name, type, body) VALUES (?, ?, ?)`).run(
      'WhatsApp - eerste contact', 'whatsapp',
      `Hallo, ik bekeek uw website {{lead.website_short}} en heb een idee waarmee {{lead.name}} meer aanvragen kan krijgen. Mag ik u 10 min daarover spreken? - {{settings.sender_name}}, {{settings.company_name}}`
    );
  }
  // Default sequence
  if (db.prepare(`SELECT COUNT(*) AS c FROM sequences`).get().c === 0) {
    const seqRes = db.prepare(`INSERT INTO sequences (name, description, trigger_stage) VALUES (?, ?, ?)`).run(
      'Standaard outreach', 'Email + WhatsApp follow-up sequence', 'contacted'
    );
    const seqId = seqRes.lastInsertRowid;
    const templates = db.prepare(`SELECT id, name FROM templates ORDER BY id`).all();
    if (templates.length >= 1) {
      db.prepare(`INSERT INTO sequence_steps (sequence_id, step_order, template_id, delay_days, require_approval) VALUES (?, ?, ?, ?, ?)`).run(seqId, 1, templates[0].id, 0, 1);
    }
    if (templates.length >= 2) {
      db.prepare(`INSERT INTO sequence_steps (sequence_id, step_order, template_id, delay_days, require_approval) VALUES (?, ?, ?, ?, ?)`).run(seqId, 2, templates[1].id, 3, 1);
    }
    if (templates.length >= 3) {
      db.prepare(`INSERT INTO sequence_steps (sequence_id, step_order, template_id, delay_days, require_approval) VALUES (?, ?, ?, ?, ?)`).run(seqId, 3, templates[2].id, 5, 1);
    }
  }
}
seedDefaults();

// Idempotent: zorg dat de briefing-template altijd bestaat, ook in installs van vóór v4.12
(function ensureBriefingTemplate() {
  const exists = db.prepare(`SELECT id FROM templates WHERE name = ?`).get('Briefing-link verzenden');
  if (exists) return;
  db.prepare(`INSERT INTO templates (name, type, subject, body) VALUES (?, ?, ?, ?)`).run(
    'Briefing-link verzenden',
    'email',
    'Uw persoonlijke briefing-link — {{settings.company_name}}',
`Hallo,

Bedankt voor uw interesse. Hieronder vindt u uw persoonlijke briefing-link:

{{briefing_link}}

Op deze pagina kiest u uw pakket en vult u stap voor stap de gegevens van uw bedrijf in. U ziet meteen welke prijs daarbij hoort — geen verborgen kosten. Tussentijds afsluiten kan, uw antwoorden worden bewaard.

Vragen? Reageer op deze mail of stuur me uw telefoonnummer, dan bel ik u even.

{{settings.signature}}`
  );
  console.log("✓ Default briefing-template aangemaakt ('Briefing-link verzenden')");
})();

function syncQueue() {
  const branches = db.prepare(`SELECT name FROM branches WHERE enabled = 1`).all();
  const cities = db.prepare(`SELECT name FROM cities WHERE enabled = 1`).all();
  const insert = db.prepare(`INSERT OR IGNORE INTO queue (branch_name, city_name, next_run) VALUES (?, ?, datetime('now'))`);
  let added = 0;
  for (const b of branches) for (const c of cities) {
    const r = insert.run(b.name, c.name);
    if (r.changes > 0) added++;
  }
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
  getQueueStats: db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN last_run IS NULL THEN 1 ELSE 0 END) AS never_run, SUM(CASE WHEN last_run IS NOT NULL THEN 1 ELSE 0 END) AS run_at_least_once, SUM(CASE WHEN next_run <= datetime('now') THEN 1 ELSE 0 END) AS due_now FROM queue`),
  pickNextQueueItem: db.prepare(`SELECT q.* FROM queue q
    INNER JOIN branches b ON b.name = q.branch_name AND b.enabled = 1
    INNER JOIN cities  c ON c.name = q.city_name   AND c.enabled = 1
    WHERE q.next_run <= datetime('now') AND q.error_count < 5
    ORDER BY CASE WHEN q.last_run IS NULL THEN 0 ELSE 1 END, q.next_run ASC, RANDOM()
    LIMIT 1`),
  deleteQueueByCity:   db.prepare(`DELETE FROM queue WHERE city_name = ?`),
  deleteQueueByBranch: db.prepare(`DELETE FROM queue WHERE branch_name = ?`),
  updateQueueItem: db.prepare(`UPDATE queue SET last_run = datetime('now'), last_status = ?, next_run = datetime('now', '+' || ? || ' days'), leads_found = leads_found + ?, error_count = CASE WHEN ? = 'error' THEN error_count + 1 ELSE 0 END WHERE id = ?`),
  rescheduleQueueItem: db.prepare(`UPDATE queue SET next_run = datetime('now', '+' || ? || ' minutes') WHERE id = ?`),
  createSearch: db.prepare(`INSERT INTO searches (query, location, auto) VALUES (?, ?, ?)`),
  updateSearchStatus: db.prepare(`UPDATE searches SET status = ?, total_results = ? WHERE id = ?`),
  insertLead: db.prepare(`INSERT OR IGNORE INTO leads (search_id, name, address, phone, website, google_maps_url, rating, review_count, category, branch_name, city_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateLeadAnalysis: db.prepare(`UPDATE leads SET analyzed = 1, replacement_score = ?, issues = ?, has_https = ?, is_mobile_friendly = ?, has_cms = ?, cms_type = ?, has_viewport_meta = ?, has_open_graph = ?, pagespeed_score = ?, copyright_year = ?, last_modified = ?, tech_stack = ?, analysis_error = ?, emails = ?, screenshot_path = ? WHERE id = ?`),
  updateLeadScreenshot: db.prepare(`UPDATE leads SET screenshot_path = ? WHERE id = ?`),
  updateLeadEmails: db.prepare(`UPDATE leads SET emails = ? WHERE id = ?`),
  getLeadsWithoutEmail: db.prepare(`SELECT id, name, website FROM leads WHERE website IS NOT NULL AND website != '' AND (emails IS NULL OR emails = '[]' OR emails = '') AND (dismissed IS NULL OR dismissed = 0) ORDER BY replacement_score DESC NULLS LAST, created_at DESC LIMIT ?`),
  setLeadDismissed: db.prepare(`UPDATE leads SET dismissed = ? WHERE id = ?`),
  updateLeadBriefingSlug: db.prepare(`UPDATE leads SET briefing_slug = ? WHERE id = ?`),
  updateLeadStage: db.prepare(`UPDATE leads SET stage = ?, deal_added_at = CASE WHEN ? != 'new' AND deal_added_at IS NULL THEN datetime('now') ELSE deal_added_at END WHERE id = ?`),
  markLeadLost: db.prepare(`UPDATE leads SET stage = 'lost', loss_reason = ?, lost_at = datetime('now') WHERE id = ?`),
  getAllLeads: db.prepare(`SELECT * FROM leads WHERE (? IS NULL OR replacement_score >= ?) AND (? IS NULL OR contacted = ?) AND (? IS NULL OR branch_name = ?) AND (? IS NULL OR city_name = ?) AND (? IS NULL OR stage = ?) AND (? = 1 OR (emails IS NOT NULL AND emails != '[]' AND emails != '')) AND (? = 1 OR dismissed IS NULL OR dismissed = 0) ORDER BY replacement_score DESC, created_at DESC LIMIT ?`),
  getNewLeadsToday: db.prepare(`SELECT * FROM leads WHERE created_at >= datetime('now', '-1 day') ORDER BY replacement_score DESC NULLS LAST LIMIT 50`),
  getTopLeadsToday: db.prepare(`SELECT * FROM leads WHERE created_at >= datetime('now', '-1 day') AND replacement_score IS NOT NULL ORDER BY replacement_score DESC, created_at DESC LIMIT 20`),
  getLead: db.prepare(`SELECT * FROM leads WHERE id = ?`),
  getUnanalyzedLeads: db.prepare(`SELECT * FROM leads WHERE search_id = ? AND analyzed = 0 AND website IS NOT NULL AND website != ''`),
  markContacted: db.prepare(`UPDATE leads SET contacted = ? WHERE id = ?`),
  updateNotes: db.prepare(`UPDATE leads SET notes = ? WHERE id = ?`),
  // Funnel
  getDealsByStage: db.prepare(`SELECT * FROM leads WHERE stage NOT IN ('new', 'lost') ORDER BY deal_added_at DESC NULLS LAST`),
  getStageStats: db.prepare(`SELECT stage, COUNT(*) AS count FROM leads GROUP BY stage`),
  // Templates
  getTemplates: db.prepare(`SELECT * FROM templates ORDER BY type, name`),
  getTemplate: db.prepare(`SELECT * FROM templates WHERE id = ?`),
  insertTemplate: db.prepare(`INSERT INTO templates (name, type, subject, body, enabled) VALUES (?, ?, ?, ?, ?)`),
  updateTemplate: db.prepare(`UPDATE templates SET name = ?, type = ?, subject = ?, body = ?, enabled = ? WHERE id = ?`),
  deleteTemplate: db.prepare(`DELETE FROM templates WHERE id = ?`),
  // Sequences
  getSequences: db.prepare(`SELECT * FROM sequences ORDER BY name`),
  getSequence: db.prepare(`SELECT * FROM sequences WHERE id = ?`),
  insertSequence: db.prepare(`INSERT INTO sequences (name, description, trigger_stage, enabled) VALUES (?, ?, ?, ?)`),
  updateSequence: db.prepare(`UPDATE sequences SET name = ?, description = ?, trigger_stage = ?, enabled = ? WHERE id = ?`),
  deleteSequence: db.prepare(`DELETE FROM sequences WHERE id = ?`),
  getSequenceSteps: db.prepare(`SELECT s.*, t.name AS template_name, t.type AS template_type FROM sequence_steps s LEFT JOIN templates t ON s.template_id = t.id WHERE sequence_id = ? ORDER BY step_order`),
  insertSequenceStep: db.prepare(`INSERT INTO sequence_steps (sequence_id, step_order, template_id, delay_days, require_approval) VALUES (?, ?, ?, ?, ?)`),
  deleteSequenceSteps: db.prepare(`DELETE FROM sequence_steps WHERE sequence_id = ?`),
  // Lead campaigns
  startLeadCampaign: db.prepare(`INSERT OR IGNORE INTO lead_campaigns (lead_id, sequence_id) VALUES (?, ?)`),
  getActiveCampaigns: db.prepare(`SELECT * FROM lead_campaigns WHERE status = 'active'`),
  getLeadCampaigns: db.prepare(`SELECT lc.*, s.name AS sequence_name FROM lead_campaigns lc JOIN sequences s ON lc.sequence_id = s.id WHERE lc.lead_id = ?`),
  advanceCampaign: db.prepare(`UPDATE lead_campaigns SET current_step = current_step + 1, last_action_at = datetime('now') WHERE id = ?`),
  completeCampaign: db.prepare(`UPDATE lead_campaigns SET status = 'completed', last_action_at = datetime('now') WHERE id = ?`),
  // Pending actions
  insertPendingAction: db.prepare(`INSERT INTO pending_actions (lead_id, campaign_id, step_id, type, template_id, rendered_subject, rendered_body, recipient, scheduled_for, auto_send, in_reply_to_message_id, intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getPendingActions: db.prepare(`SELECT pa.*, l.name AS lead_name, l.website AS lead_website, l.replacement_score FROM pending_actions pa LEFT JOIN leads l ON pa.lead_id = l.id WHERE pa.status = 'pending' AND datetime(pa.scheduled_for) <= datetime('now') ORDER BY pa.scheduled_for ASC LIMIT 50`),
  getDuePendingActions: db.prepare(`SELECT pa.*, l.name AS lead_name FROM pending_actions pa LEFT JOIN leads l ON pa.lead_id = l.id WHERE pa.status = 'pending' AND pa.auto_send = 1 AND datetime(pa.scheduled_for) <= datetime('now') AND (l.stage IS NULL OR l.stage != 'lost') ORDER BY pa.scheduled_for ASC LIMIT 20`),
  cancelPendingForLead: db.prepare(`UPDATE pending_actions SET status = 'cancelled' WHERE lead_id = ? AND status = 'pending'`),
  cancelCampaignsForLead: db.prepare(`UPDATE lead_campaigns SET status = 'cancelled' WHERE lead_id = ? AND status = 'active'`),
  getPendingAction: db.prepare(`SELECT * FROM pending_actions WHERE id = ?`),
  updatePendingActionStatus: db.prepare(`UPDATE pending_actions SET status = ? WHERE id = ?`),
  updatePendingActionBody: db.prepare(`UPDATE pending_actions SET rendered_subject = ?, rendered_body = ? WHERE id = ?`),
  countPendingActions: db.prepare(`SELECT COUNT(*) AS c FROM pending_actions WHERE status = 'pending' AND datetime(scheduled_for) <= datetime('now')`),
  findLeadByEmail: db.prepare(`SELECT * FROM leads WHERE emails IS NOT NULL AND emails LIKE '%' || ? || '%' ORDER BY created_at DESC LIMIT 1`),
  // Communications
  insertCommunication: db.prepare(`INSERT INTO communications (lead_id, type, direction, subject, body, recipient, status, error, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  getLeadCommunications: db.prepare(`SELECT * FROM communications WHERE lead_id = ? ORDER BY sent_at DESC LIMIT 100`),
  markCommunicationRead: db.prepare(`UPDATE communications SET read = 1 WHERE id = ?`),
  markLeadCommunicationsRead: db.prepare(`UPDATE communications SET read = 1 WHERE lead_id = ? AND direction = 'inbound' AND read = 0`),
  getTotalUnreadCount: db.prepare(`SELECT COUNT(*) AS c FROM communications WHERE direction = 'inbound' AND read = 0`),
  getUnreadByLead: db.prepare(`SELECT lead_id, COUNT(*) AS c FROM communications WHERE direction = 'inbound' AND read = 0 GROUP BY lead_id`),
  getUnreadInboundComms: db.prepare(`SELECT c.*, l.name AS lead_name, l.replacement_score FROM communications c LEFT JOIN leads l ON c.lead_id = l.id WHERE c.direction = 'inbound' AND c.read = 0 ORDER BY c.sent_at DESC LIMIT 50`),
  // Activity log: combineer searches + communications + bookings
  getRecentSearches: db.prepare(`SELECT * FROM searches ORDER BY created_at DESC LIMIT 60`),
  getRecentCommunications: db.prepare(`SELECT c.*, l.name AS lead_name FROM communications c LEFT JOIN leads l ON c.lead_id = l.id ORDER BY c.sent_at DESC LIMIT 100`),
  getRecentBookings: db.prepare(`SELECT b.*, l.name AS lead_name FROM bookings b LEFT JOIN leads l ON b.lead_id = l.id ORDER BY b.created_at DESC LIMIT 50`),
  insertBooking: db.prepare(`INSERT OR REPLACE INTO bookings (lead_id, calcom_uid, event_type, scheduled_at, end_at, attendee_email, attendee_name, meet_url, location, status, raw_payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateBookingStatus: db.prepare(`UPDATE bookings SET status = ? WHERE calcom_uid = ?`),
  getBookings: db.prepare(`SELECT b.*, l.name AS lead_name, l.replacement_score, l.stage FROM bookings b LEFT JOIN leads l ON b.lead_id = l.id ORDER BY b.scheduled_at DESC LIMIT 200`),
  getLeadBookings: db.prepare(`SELECT * FROM bookings WHERE lead_id = ? ORDER BY scheduled_at DESC`),
  getUpcomingBookingsCount: db.prepare(`SELECT COUNT(*) AS c FROM bookings WHERE status = 'confirmed' AND scheduled_at >= datetime('now')`),
  getBookingByUid: db.prepare(`SELECT * FROM bookings WHERE calcom_uid = ?`),
  getLeadsWithUpcomingBooking: db.prepare(`SELECT DISTINCT lead_id FROM bookings WHERE status = 'confirmed' AND scheduled_at >= datetime('now') AND lead_id IS NOT NULL`),
  // Projects
  getProjects: db.prepare(`SELECT p.*, l.name AS lead_name, l.website AS lead_website FROM projects p LEFT JOIN leads l ON p.lead_id = l.id ORDER BY p.created_at DESC`),
  insertProject: db.prepare(`INSERT INTO projects (lead_id, name, status, notes) VALUES (?, ?, ?, ?)`),
  updateProject: db.prepare(`UPDATE projects SET name = ?, status = ?, notes = ? WHERE id = ?`),
  deleteProject: db.prepare(`DELETE FROM projects WHERE id = ?`),
  // Stats
  getDashboardStats: db.prepare(`SELECT
    (SELECT COUNT(*) FROM leads) AS total_leads,
    (SELECT COUNT(*) FROM leads WHERE analyzed = 1) AS analyzed_leads,
    (SELECT COUNT(*) FROM leads WHERE replacement_score >= 40 AND stage = 'new' AND emails IS NOT NULL AND emails != '[]' AND emails != '' AND (dismissed IS NULL OR dismissed = 0)) AS high_score_leads,
    (SELECT COUNT(*) FROM leads WHERE replacement_score >= 80 AND stage = 'new' AND emails IS NOT NULL AND emails != '[]' AND emails != '' AND (dismissed IS NULL OR dismissed = 0)) AS very_high_score_leads,
    (SELECT COUNT(*) FROM leads WHERE created_at >= datetime('now', '-1 day')) AS leads_today,
    (SELECT COUNT(*) FROM leads WHERE contacted = 1) AS contacted,
    (SELECT COUNT(*) FROM leads WHERE stage NOT IN ('new', 'lost')) AS in_funnel,
    (SELECT COUNT(DISTINCT branch_name) FROM leads) AS unique_branches,
    (SELECT COUNT(DISTINCT city_name) FROM leads) AS unique_cities`),
  deleteSearch: db.prepare(`DELETE FROM searches WHERE id = ?`),
  deleteLeadsBySearch: db.prepare(`DELETE FROM leads WHERE search_id = ?`),
  getSearches: db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM leads WHERE search_id = s.id) AS lead_count FROM searches s ORDER BY created_at DESC LIMIT 100`),
};

module.exports = {
  db, syncQueue,
  getSetting: (k) => stmts.getSetting.get(k)?.value,
  setSetting: (k, v) => stmts.setSetting.run(k, String(v ?? '')),
  getAllSettings: () => { const r = stmts.getAllSettings.all(); const o = {}; for (const x of r) o[x.key] = x.value; return o; },
  getBranches: () => stmts.getBranches.all(),
  addBranch: (n) => stmts.insertBranch.run(n.trim()),
  toggleBranch: (id, e) => {
    const r = stmts.toggleBranch.run(e ? 1 : 0, id);
    if (!e) {
      const b = db.prepare(`SELECT name FROM branches WHERE id = ?`).get(id);
      if (b) stmts.deleteQueueByBranch.run(b.name);
    }
    return r;
  },
  deleteBranch: (id) => {
    const b = db.prepare(`SELECT name FROM branches WHERE id = ?`).get(id);
    if (b) stmts.deleteQueueByBranch.run(b.name);
    return stmts.deleteBranch.run(id);
  },
  getCities: () => stmts.getCities.all(),
  addCity: (n) => stmts.insertCity.run(n.trim()),
  toggleCity: (id, e) => {
    const r = stmts.toggleCity.run(e ? 1 : 0, id);
    if (!e) {
      const c = db.prepare(`SELECT name FROM cities WHERE id = ?`).get(id);
      if (c) stmts.deleteQueueByCity.run(c.name);
    }
    return r;
  },
  deleteCity: (id) => {
    const c = db.prepare(`SELECT name FROM cities WHERE id = ?`).get(id);
    if (c) stmts.deleteQueueByCity.run(c.name);
    return stmts.deleteCity.run(id);
  },
  getQueueStats: () => stmts.getQueueStats.get(),
  pickNextQueueItem: () => stmts.pickNextQueueItem.get(),
  updateQueueItem: (id, status, days, found) => stmts.updateQueueItem.run(status, days, found, status, id),
  rescheduleQueueItem: (id, mins) => stmts.rescheduleQueueItem.run(mins, id),
  createSearch: (q, l, auto = false) => stmts.createSearch.run(q, l, auto ? 1 : 0),
  updateSearchStatus: (id, s, t) => stmts.updateSearchStatus.run(s, t, id),
  insertLead: (lead) => stmts.insertLead.run(lead.search_id, lead.name, lead.address, lead.phone, lead.website, lead.google_maps_url, lead.rating, lead.review_count, lead.category, lead.branch_name || null, lead.city_name || null),
  updateLeadAnalysis: (id, a) => stmts.updateLeadAnalysis.run(
    a.replacement_score, JSON.stringify(a.issues || []),
    a.has_https ? 1 : 0, a.is_mobile_friendly ? 1 : 0,
    a.has_cms ? 1 : 0, a.cms_type,
    a.has_viewport_meta ? 1 : 0, a.has_open_graph ? 1 : 0,
    a.pagespeed_score, a.copyright_year, a.last_modified,
    JSON.stringify(a.tech_stack || []), a.error || null,
    JSON.stringify(a.emails || []), a.screenshot_path || null,
    id
  ),
  updateLeadScreenshot: (id, path) => stmts.updateLeadScreenshot.run(path, id),
  updateLeadEmails: (id, emails) => stmts.updateLeadEmails.run(JSON.stringify(emails || []), id),
  getLeadsWithoutEmail: (limit = 500) => stmts.getLeadsWithoutEmail.all(limit),
  setLeadBriefingSlug: (id, slug) => stmts.updateLeadBriefingSlug.run(slug, id),
  setLeadDismissed: (id, dismissed) => stmts.setLeadDismissed.run(dismissed ? 1 : 0, id),
  updateLeadStage: (id, stage) => stmts.updateLeadStage.run(stage, stage, id),
  markLeadLost: (id, reason) => {
    stmts.markLeadLost.run(reason || null, id);
    stmts.cancelPendingForLead.run(id);
    stmts.cancelCampaignsForLead.run(id);
  },
  advanceLeadStage: (id, targetStage) => {
    const lead = stmts.getLead.get(id);
    if (!lead) return false;
    if (lead.stage === 'lost') return false;
    const cur = STAGE_ORDER[lead.stage || 'new'] ?? 0;
    const tgt = STAGE_ORDER[targetStage] ?? -1;
    if (tgt <= cur) return false;
    stmts.updateLeadStage.run(targetStage, targetStage, id);
    return true;
  },
  getAllLeads: (f = {}) => {
    const minScore = f.minScore ?? null;
    const contacted = f.contacted ?? null;
    const branch = f.branch ?? null;
    const city = f.city ?? null;
    let stage = f.stage ?? null;
    if (stage === null && !f.allStages) stage = 'new';
    const includeNoEmail = f.includeNoEmail ? 1 : 0;
    const includeDismissed = f.includeDismissed ? 1 : 0;
    const limit = f.limit ?? 500;
    return stmts.getAllLeads.all(
      minScore, minScore,
      contacted, contacted,
      branch, branch,
      city, city,
      stage, stage,
      includeNoEmail,
      includeDismissed,
      limit
    );
  },
  getNewLeadsToday: () => stmts.getNewLeadsToday.all(),
  getTopLeadsToday: () => stmts.getTopLeadsToday.all(),
  getLead: (id) => stmts.getLead.get(id),
  getUnanalyzedLeads: (sid) => stmts.getUnanalyzedLeads.all(sid),
  markContacted: (id, c) => stmts.markContacted.run(c ? 1 : 0, id),
  updateNotes: (id, n) => stmts.updateNotes.run(n, id),
  // Funnel
  getDealsByStage: () => stmts.getDealsByStage.all(),
  getStageStats: () => stmts.getStageStats.all(),
  // Templates
  getTemplates: () => stmts.getTemplates.all(),
  getTemplate: (id) => stmts.getTemplate.get(id),
  addTemplate: (t) => stmts.insertTemplate.run(t.name, t.type || 'email', t.subject || null, t.body, t.enabled !== false ? 1 : 0).lastInsertRowid,
  updateTemplate: (id, t) => stmts.updateTemplate.run(t.name, t.type || 'email', t.subject || null, t.body, t.enabled !== false ? 1 : 0, id),
  deleteTemplate: (id) => stmts.deleteTemplate.run(id),
  // Sequences
  getSequences: () => stmts.getSequences.all(),
  getSequence: (id) => stmts.getSequence.get(id),
  addSequence: (s) => stmts.insertSequence.run(s.name, s.description || '', s.trigger_stage || 'contacted', s.enabled !== false ? 1 : 0).lastInsertRowid,
  updateSequence: (id, s) => stmts.updateSequence.run(s.name, s.description || '', s.trigger_stage || 'contacted', s.enabled !== false ? 1 : 0, id),
  deleteSequence: (id) => stmts.deleteSequence.run(id),
  getSequenceSteps: (id) => stmts.getSequenceSteps.all(id),
  setSequenceSteps: (id, steps) => {
    stmts.deleteSequenceSteps.run(id);
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      stmts.insertSequenceStep.run(id, i + 1, s.template_id, s.delay_days || 0, s.require_approval !== false ? 1 : 0);
    }
  },
  // Campaigns
  startLeadCampaign: (leadId, seqId) => stmts.startLeadCampaign.run(leadId, seqId),
  getActiveCampaigns: () => stmts.getActiveCampaigns.all(),
  getLeadCampaigns: (id) => stmts.getLeadCampaigns.all(id),
  advanceCampaign: (id) => stmts.advanceCampaign.run(id),
  completeCampaign: (id) => stmts.completeCampaign.run(id),
  // Pending
  addPendingAction: (a) => stmts.insertPendingAction.run(a.lead_id, a.campaign_id || null, a.step_id || null, a.type, a.template_id || null, a.rendered_subject || null, a.rendered_body, a.recipient || null, a.scheduled_for || new Date().toISOString(), a.auto_send ? 1 : 0, a.in_reply_to_message_id || null, a.intent || null),
  getPendingActions: () => stmts.getPendingActions.all(),
  getDuePendingActions: () => stmts.getDuePendingActions.all(),
  getPendingAction: (id) => stmts.getPendingAction.get(id),
  updatePendingActionStatus: (id, s) => stmts.updatePendingActionStatus.run(s, id),
  updatePendingActionBody: (id, subject, body) => stmts.updatePendingActionBody.run(subject, body, id),
  countPendingActions: () => stmts.countPendingActions.get().c,
  findLeadByEmail: (email) => stmts.findLeadByEmail.get(email.toLowerCase()),
  // Communications
  logCommunication: (c) => {
    const dir = c.direction || 'outbound';
    const isRead = dir === 'outbound' ? 1 : 0;
    return stmts.insertCommunication.run(c.lead_id, c.type, dir, c.subject || null, c.body || null, c.recipient || null, c.status || 'sent', c.error || null, isRead);
  },
  getLeadCommunications: (id) => stmts.getLeadCommunications.all(id),
  markCommunicationRead: (id) => stmts.markCommunicationRead.run(id),
  markLeadCommunicationsRead: (leadId) => stmts.markLeadCommunicationsRead.run(leadId),
  getTotalUnreadCount: () => stmts.getTotalUnreadCount.get().c,
  getUnreadByLead: () => {
    const rows = stmts.getUnreadByLead.all();
    const map = {};
    for (const r of rows) map[r.lead_id] = r.c;
    return map;
  },
  getUnreadInboundComms: () => stmts.getUnreadInboundComms.all(),
  getRecentSearches: () => stmts.getRecentSearches.all(),
  getRecentCommunications: () => stmts.getRecentCommunications.all(),
  getRecentBookings: () => stmts.getRecentBookings.all(),
  // Bookings
  upsertBooking: (b) => stmts.insertBooking.run(b.lead_id || null, b.calcom_uid, b.event_type || null, b.scheduled_at || null, b.end_at || null, b.attendee_email || null, b.attendee_name || null, b.meet_url || null, b.location || null, b.status || 'confirmed', b.raw_payload || null),
  setBookingStatus: (uid, status) => stmts.updateBookingStatus.run(status, uid),
  getBookings: () => stmts.getBookings.all(),
  getLeadBookings: (id) => stmts.getLeadBookings.all(id),
  getUpcomingBookingsCount: () => stmts.getUpcomingBookingsCount.get().c,
  getBookingByUid: (uid) => stmts.getBookingByUid.get(uid),
  getLeadIdsWithUpcomingBooking: () => stmts.getLeadsWithUpcomingBooking.all().map(r => r.lead_id),
  // Projects
  getProjects: () => stmts.getProjects.all(),
  addProject: (p) => stmts.insertProject.run(p.lead_id || null, p.name, p.status || 'planning', p.notes || ''),
  updateProject: (id, p) => stmts.updateProject.run(p.name, p.status, p.notes, id),
  deleteProject: (id) => stmts.deleteProject.run(id),
  // Stats
  getDashboardStats: () => stmts.getDashboardStats.get(),
  getSearches: () => stmts.getSearches.all(),
  deleteSearch: (id) => { stmts.deleteLeadsBySearch.run(id); stmts.deleteSearch.run(id); },
};
