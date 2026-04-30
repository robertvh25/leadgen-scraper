// scheduler.js - Auto-pilot scheduler die de queue afwerkt
const { scrapeGoogleMaps } = require('./scraper');
const { analyzeWebsite } = require('./analyzer');
const { takeScreenshot } = require('./lib/screenshot');
const sequenceEngine = require('./lib/sequence-engine');
const db = require('./db');

let running = false;
let currentJob = null;
let stats = { lastRunAt: null, lastError: null, totalRuns: 0, blocked: false, blockedUntil: null };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getMinIntervalMs() {
  const perHour = parseInt(db.getSetting('searches_per_hour') || '3');
  const baseInterval = (60 / Math.max(perHour, 1)) * 60 * 1000;
  const hour = new Date().getHours();
  const isNight = hour >= 0 && hour < 6;
  const nightMode = db.getSetting('night_mode') === '1';
  if (isNight && nightMode) return baseInterval * 0.7;
  return baseInterval;
}

async function runOneJob() {
  if (currentJob) return;

  if (stats.blockedUntil && new Date() < stats.blockedUntil) return;
  stats.blocked = false;

  const item = db.pickNextQueueItem();
  if (!item) return;

  currentJob = item;
  stats.lastRunAt = new Date();
  stats.totalRuns++;

  console.log(`🤖 Auto-pilot: "${item.branch_name}" in ${item.city_name}`);

  const maxResults = parseInt(db.getSetting('max_results_per_search') || '20');
  const intervalDays = parseInt(db.getSetting('repeat_interval_days') || '14');
  const autoFunnel = db.getSetting('auto_add_high_score_to_funnel') === '1';
  const highScoreThreshold = parseInt(db.getSetting('high_score_threshold') || '70');

  const searchResult = db.createSearch(item.branch_name, item.city_name, true);
  const searchId = searchResult.lastInsertRowid;

  let leadsFound = 0;
  let status = 'done';

  try {
    const businesses = await scrapeGoogleMaps(
      item.branch_name, item.city_name, maxResults, () => {}
    );

    for (const biz of businesses) {
      try {
        const r = db.insertLead({
          search_id: searchId, ...biz,
          branch_name: item.branch_name,
          city_name: item.city_name,
        });
        if (r.changes > 0) leadsFound++;
      } catch (e) {}
    }

    db.updateSearchStatus(searchId, 'analyzing', businesses.length);

    const unanalyzed = db.getUnanalyzedLeads(searchId);
    for (const lead of unanalyzed) {
      try {
        const analysis = await analyzeWebsite(lead.website);

        // Screenshot proberen, niet kritiek als het mislukt
        try {
          const ssPath = await takeScreenshot(lead.website, lead.id);
          if (ssPath) analysis.screenshot_path = ssPath;
        } catch (e) { /* skip */ }

        db.updateLeadAnalysis(lead.id, analysis);

        // Auto-funnel: hoge score → automatisch naar 'contacted' stage
        if (autoFunnel && analysis.replacement_score >= highScoreThreshold) {
          const fresh = db.getLead(lead.id);
          if (fresh && fresh.stage === 'new') {
            db.updateLeadStage(lead.id, 'contacted');
            sequenceEngine.autoStartCampaignsForStage(lead.id, 'contacted');
            console.log(`  ↪ Lead "${lead.name}" (score ${analysis.replacement_score}) automatisch naar funnel`);
          }
        }
      } catch (err) {
        db.updateLeadAnalysis(lead.id, {
          replacement_score: null, issues: [], error: err.message,
        });
      }
      await sleep(700);
    }

    db.updateSearchStatus(searchId, 'done', businesses.length);
    db.updateQueueItem(item.id, 'done', intervalDays, leadsFound);
    stats.lastError = null;
    console.log(`✓ ${leadsFound} nieuwe leads voor "${item.branch_name}" in ${item.city_name}`);
  } catch (err) {
    console.error(`✗ Auto-pilot error: ${err.message}`);
    stats.lastError = err.message;
    status = 'error';

    const isBlock = /blocked|captcha|429|too many|forbidden/i.test(err.message);
    if (isBlock) {
      stats.blocked = true;
      stats.blockedUntil = new Date(Date.now() + 60 * 60 * 1000);
      console.warn(`⚠ Mogelijk Google block, pauze tot ${stats.blockedUntil.toLocaleTimeString()}`);
      db.rescheduleQueueItem(item.id, 120);
    } else {
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
      await sleep(10000);
      continue;
    }

    try {
      await runOneJob();
    } catch (err) {
      console.error('Loop error:', err);
    }

    const interval = getMinIntervalMs();
    const jitter = Math.random() * 0.3 * interval;
    await sleep(interval + jitter);
  }
}

function start() {
  if (running) return;
  running = true;
  db.syncQueue();
  loop().catch(err => console.error('Scheduler crashed:', err));
  console.log('🤖 Scheduler gestart');
}

function stop() {
  running = false;
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
