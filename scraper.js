// scraper.js - Google Maps scraper met block detection
const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => Math.floor(Math.random() * (max - min)) + min;

class GoogleBlockedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GoogleBlockedError';
    this.isBlock = true;
  }
}

async function scrapeGoogleMaps(query, location, maxResults = 40, onProgress = () => {}) {
  const fullQuery = location ? `${query} in ${location}` : query;
  const url = `https://www.google.com/maps/search/${encodeURIComponent(fullQuery)}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
      '--lang=nl-NL,nl',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8' });

    onProgress({ stage: 'navigating', message: 'Google Maps openen...' });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    // Check for block / captcha
    const blocked = await detectBlock(page);
    if (blocked) {
      throw new GoogleBlockedError(`Google block detected: ${blocked}`);
    }

    // Cookie consent
    try {
      const consent = await page.waitForSelector(
        'button[aria-label*="Alles accepteren"], button[aria-label*="Accept all"], form[action*="consent"] button',
        { timeout: 5000 }
      );
      if (consent) {
        await consent.click();
        await sleep(2000);
      }
    } catch (_) {}

    // Wacht op feed
    try {
      await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
    } catch (err) {
      // Mogelijk geen resultaten
      const noResults = await page.evaluate(() =>
        document.body.innerText.toLowerCase().includes('geen resultaten') ||
        document.body.innerText.toLowerCase().includes('no results')
      );
      if (noResults) {
        onProgress({ stage: 'done', message: 'Geen resultaten gevonden', count: 0 });
        return [];
      }
      throw err;
    }

    onProgress({ stage: 'scrolling', message: 'Resultaten laden...' });

    let lastCount = 0;
    let stagnant = 0;
    for (let i = 0; i < 40; i++) {
      const count = await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        return feed ? feed.querySelectorAll('a[href*="/maps/place/"]').length : 0;
      });

      onProgress({ stage: 'scrolling', message: `${count} bedrijven geladen`, count });

      if (count >= maxResults) break;
      if (count === lastCount) {
        stagnant++;
        if (stagnant >= 3) break;
      } else stagnant = 0;
      lastCount = count;

      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollTop = feed.scrollHeight;
      });
      await sleep(rand(1200, 2200));
    }

    onProgress({ stage: 'extracting', message: 'Details extraheren...' });

    const placeUrls = await page.evaluate((max) => {
      const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      return [...new Set(links.map(a => a.href))].slice(0, max);
    }, maxResults);

    const results = [];
    for (let i = 0; i < placeUrls.length; i++) {
      onProgress({
        stage: 'detail',
        message: `Detail ${i + 1}/${placeUrls.length}`,
        progress: i + 1,
        total: placeUrls.length,
      });

      try {
        const detail = await scrapePlaceDetail(page, placeUrls[i]);
        if (detail && detail.name) {
          detail.google_maps_url = placeUrls[i];
          // Extract city from address
          detail.city = extractCity(detail.address) || location;
          results.push(detail);
        }
      } catch (err) {
        console.error(`Detail error: ${err.message}`);
        // Check of het een block is
        const block = await detectBlock(page).catch(() => null);
        if (block) throw new GoogleBlockedError(`Blocked tijdens detail: ${block}`);
      }
      await sleep(rand(800, 1800));
    }

    onProgress({ stage: 'done', message: `${results.length} bedrijven gevonden`, count: results.length });
    return results;
  } finally {
    await browser.close();
  }
}

async function detectBlock(page) {
  try {
    const indicators = await page.evaluate(() => {
      const url = window.location.href;
      const text = document.body?.innerText?.toLowerCase() || '';
      const checks = {
        sorry_url: url.includes('/sorry/'),
        captcha: text.includes('captcha') || text.includes('recaptcha') || !!document.querySelector('#captcha-form'),
        unusual_traffic: text.includes('unusual traffic') || text.includes('ongewoon verkeer'),
        verify_human: text.includes('verify you') || text.includes('verifieer dat je geen robot'),
      };
      const triggered = Object.entries(checks).filter(([_, v]) => v).map(([k]) => k);
      return triggered;
    });
    if (indicators.length > 0) return indicators.join(', ');
    return null;
  } catch {
    return null;
  }
}

async function scrapePlaceDetail(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await sleep(rand(1000, 1800));

  return await page.evaluate(() => {
    const getText = (sels) => {
      for (const s of sels) {
        const el = document.querySelector(s);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    };

    const name = getText(['h1.DUwDvf', 'h1']);
    const buttons = Array.from(document.querySelectorAll('button[data-item-id], a[data-item-id]'));
    let address = null, phone = null, website = null;

    for (const btn of buttons) {
      const id = btn.getAttribute('data-item-id') || '';
      const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
      const text = btn.textContent.trim();
      if (id === 'address' || aria.includes('adres') || aria.includes('address')) {
        address = text.replace(/^Adres:\s*/i, '').replace(/^Address:\s*/i, '');
      } else if (id.startsWith('phone') || aria.includes('telefoon') || aria.includes('phone')) {
        phone = text.replace(/^Telefoon:\s*/i, '').replace(/^Phone:\s*/i, '');
      } else if (id === 'authority' || aria.includes('website')) {
        website = btn.getAttribute('href') || (text.startsWith('http') ? text : null);
      }
    }

    if (!website) {
      const ws = document.querySelector('a[data-item-id="authority"]');
      if (ws) website = ws.href;
    }

    let rating = null, reviewCount = null;
    const ratingEl = document.querySelector('div.F7nice span[aria-hidden="true"]');
    if (ratingEl) {
      const r = parseFloat(ratingEl.textContent.replace(',', '.'));
      if (!isNaN(r)) rating = r;
    }
    const reviewEl = document.querySelector('div.F7nice span[aria-label*="review"], div.F7nice span[aria-label*="recensie"]');
    if (reviewEl) {
      const m = reviewEl.textContent.match(/[\d.,]+/);
      if (m) reviewCount = parseInt(m[0].replace(/[.,]/g, ''));
    }

    const categoryEl = document.querySelector('button[jsaction*="category"]');
    const category = categoryEl ? categoryEl.textContent.trim() : null;

    return { name, address, phone, website, rating, review_count: reviewCount, category };
  });
}

/**
 * Probeer stad uit adres te halen.
 * Nederlandse adressen: "Straatnaam 12, 1234 AB Stad" → "Stad"
 */
function extractCity(address) {
  if (!address) return null;
  // Match Nederlandse postcode pattern + stad daarna
  const nlMatch = address.match(/\b\d{4}\s?[A-Z]{2}\s+([A-Za-zÀ-ÿ\s\-]+?)(?:,|$)/);
  if (nlMatch) return nlMatch[1].trim();
  // Fallback: laatste comma-segment
  const parts = address.split(',').map(s => s.trim());
  if (parts.length >= 2) {
    const last = parts[parts.length - 1];
    // Strip postcodes
    return last.replace(/^\d{4}\s?[A-Z]{2}\s*/, '').trim() || null;
  }
  return null;
}

module.exports = { scrapeGoogleMaps, GoogleBlockedError };
