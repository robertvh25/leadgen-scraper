// scheduler.js - Auto-pilot scheduler die de queue afwerkt
const { scrapeGoogleMaps } = require('./scraper');
const { analyzeWebsite } = require('./analyzer');
const db = require('./db');

let running = false;
let currentJob = null;
let stats = { lastRunAt: null, lastError: null, totalRuns: 0, blocked: false, blockedUntil: null };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getMinIntervalMs() {
  const perHour = parseInt(db.getSetting('searches_per_hour') || '3');
  const baseInterval = (60 / Math.max(perHour, 1)) * 60 * 1000;
  // 's nachts kunnen we iets sneller (00:00 - 06:00 NL tijd)
  const hour = new Date().getHours();
  const isNight = hour >= 0 && hour < 6;
  const nightMode = db.getSetting('night_mode') === '1';
  if (isNight && nightMode) return baseInterval * 0.7;
  return baseInterval;
}

async function runOneJob() {
  if (currentJob) return; // already busy

  // Check als we geblokkeerd zijn
  if (stats.blockedUntil && new Date() < stats.blockedUntil) {
    return;
  }
  stats.blocked = false;

  // Pak volgende item uit queue
  const item = db.pickNextQueueItem();
  if (!item) return;

  currentJob = item;
  stats.lastRunAt = new Date();
  stats.totalRuns++;

  console.log(`🤖 Auto-pilot job: "${item.branch_name}" in ${item.city_name}`);

  const maxResults = parseInt(db.getSetting('max_results_per_search') || '20');
  const intervalDays = parseInt(db.getSetting('repeat_interval_days') || '14');

  // Maak een search record
  const searchResult = db.createSearch(item.branch_name, item.city_name, true);
  const searchId = searchResult.lastInsertRowid;

  let leadsFound = 0;
  let status = 'done';

  try {
    const businesses = await scrapeGoogleMaps(
      item.branch_name, item.city_name, maxResults,
      (p) => { /* silent */ }
    );

    for (const biz of businesses) {
      try {
        const r = db.insertLead({
          search_id: searchId,
          ...biz,
          branch_name: item.branch_name,
          city_name: item.city_name,
        });
        if (r.changes > 0) leadsFound++;
      } catch (e) { /* duplicate */ }
    }

    db.updateSearchStatus(searchId, 'analyzing', businesses.length);

    // Analyseer alleen NIEUWE leads (degene die zojuist nieuw zijn toegevoegd worden ook opgepakt)
    const unanalyzed = db.getUnanalyzedLeads(searchId);
    for (const lead of unanalyzed) {
      try {
        const analysis = await analyzeWebsite(lead.website);
        db.updateLeadAnalysis(lead.id, analysis);
      } catch (err) {
        db.updateLeadAnalysis(lead.id, {
          replacement_score: null, issues: [], error: err.message,
        });
      }
      // Korte pauze tussen analyses om rate limits te respecteren
      await sleep(500);
    }

    db.updateSearchStatus(searchId, 'done', businesses.length);
    db.updateQueueItem(item.id, 'done', intervalDays, leadsFound);
    stats.lastError = null;
    console.log(`✓ Klaar: ${leadsFound} nieuwe leads voor "${item.branch_name}" in ${item.city_name}`);
  } catch (err) {
    console.error(`✗ Auto-pilot error: ${err.message}`);
    stats.lastError = err.message;
    status = 'error';

    // Check of het op een Google block lijkt
    const isBlock = /blocked|captcha|429|too many|forbidden/i.test(err.message);
    if (isBlock) {
      stats.blocked = true;
      stats.blockedUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 uur pauze
      console.warn(`⚠ Mogelijk Google block, pauzeer 1 uur tot ${stats.blockedUntil.toLocaleTimeString()}`);
      // Reschedule dit item naar over 2 uur
      db.rescheduleQueueItem(item.id, 120);
    } else {
      // Andere error: probeer later opnieuw
      db.updateQueueItem(item.id, 'error', 1, 0);
    }

    db.updateSearchStatus(searchId, 'error', 0);
  } finally {
    currentJob = null;
  }
}

async function loop() {
  while (running) {
    const enabled = db.getSetting('autopilot_enabled') === '1';
    if (!enabled) {
      await sleep(10000); // check elke 10s of het weer aangezet wordt
      continue;
    }

    try {
      await runOneJob();
    } catch (err) {
      console.error('Loop error:', err);
    }

    // Wacht tot volgende interval
    const interval = getMinIntervalMs();
    const jitter = Math.random() * 0.3 * interval; // ±30% jitter
    await sleep(interval + jitter);
  }
}

function start() {
  if (running) return;
  running = true;
  db.syncQueue(); // zorg dat queue up-to-date is
  loop().catch(err => console.error('Scheduler crashed:', err));
  console.log('🤖 Scheduler gestart');
}

function stop() {
  running = false;
  console.log('🛑 Scheduler gestopt');
}

function getStatus() {
  return {
    running,
    currentJob: currentJob ? { branch: currentJob.branch_name, city: currentJob.city_name } : null,
    ...stats,
    blockedUntil: stats.blockedUntil?.toISOString() || null,
    lastRunAt: stats.lastRunAt?.toISOString() || null,
    nextRunIn: currentJob ? null : Math.round(getMinIntervalMs() / 1000),
    autopilotEnabled: db.getSetting('autopilot_enabled') === '1',
    searchesPerHour: parseInt(db.getSetting('searches_per_hour') || '3'),
  };
}

module.exports = { start, stop, getStatus, runOneJob };
