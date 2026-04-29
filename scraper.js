// scraper.js - Google Maps scraper met Puppeteer
const puppeteer = require('puppeteer');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Scrape Google Maps voor bedrijven op basis van zoekopdracht
 * @param {string} query - bv "kozijnbedrijf"
 * @param {string} location - bv "Rotterdam"
 * @param {number} maxResults - maximum aantal resultaten
 * @param {function} onProgress - callback voor progress updates
 */
async function scrapeGoogleMaps(query, location, maxResults = 50, onProgress = () => {}) {
  const fullQuery = location ? `${query} in ${location}` : query;
  const url = `https://www.google.com/maps/search/${encodeURIComponent(fullQuery)}`;

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled',
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

    // Cookie consent (Google EU)
    try {
      const consentBtn = await page.waitForSelector(
        'button[aria-label*="Alles accepteren"], button[aria-label*="Accept all"], form[action*="consent"] button',
        { timeout: 5000 }
      );
      if (consentBtn) {
        await consentBtn.click();
        await sleep(2000);
      }
    } catch (_) { /* geen consent popup */ }

    // Wacht op resultaten lijst
    await page.waitForSelector('div[role="feed"], div[aria-label*="Resultaten"], div[aria-label*="Results"]', {
      timeout: 30000,
    });

    onProgress({ stage: 'scrolling', message: 'Resultaten laden door te scrollen...' });

    // Scroll door de lijst tot we genoeg resultaten hebben of einde bereiken
    const feedSelector = 'div[role="feed"]';
    let lastCount = 0;
    let stagnantCount = 0;

    for (let i = 0; i < 40; i++) {
      const count = await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (!feed) return 0;
        return feed.querySelectorAll('a[href*="/maps/place/"]').length;
      }, feedSelector);

      onProgress({ stage: 'scrolling', message: `${count} bedrijven geladen...`, count });

      if (count >= maxResults) break;
      if (count === lastCount) {
        stagnantCount++;
        if (stagnantCount >= 3) break; // einde lijst bereikt
      } else {
        stagnantCount = 0;
      }
      lastCount = count;

      await page.evaluate((sel) => {
        const feed = document.querySelector(sel);
        if (feed) feed.scrollTop = feed.scrollHeight;
      }, feedSelector);

      await sleep(1500);
    }

    onProgress({ stage: 'extracting', message: 'Data extraheren...' });

    // Verzamel place URLs
    const placeUrls = await page.evaluate((max) => {
      const links = Array.from(document.querySelectorAll('a[href*="/maps/place/"]'));
      const urls = [...new Set(links.map(a => a.href))];
      return urls.slice(0, max);
    }, maxResults);

    const results = [];

    for (let i = 0; i < placeUrls.length; i++) {
      const placeUrl = placeUrls[i];
      onProgress({
        stage: 'detail',
        message: `Detail ${i + 1}/${placeUrls.length} ophalen...`,
        progress: i + 1,
        total: placeUrls.length,
      });

      try {
        const detail = await scrapePlaceDetail(page, placeUrl);
        if (detail && detail.name) {
          results.push(detail);
        }
      } catch (err) {
        console.error(`Fout bij detail ${placeUrl}:`, err.message);
      }

      await sleep(800 + Math.random() * 700); // anti-bot jitter
    }

    onProgress({ stage: 'done', message: `${results.length} bedrijven gevonden`, count: results.length });
    return results;
  } finally {
    await browser.close();
  }
}

async function scrapePlaceDetail(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

  // Wacht op de detail panel
  await page.waitForSelector('h1', { timeout: 15000 }).catch(() => {});
  await sleep(1200);

  return await page.evaluate(() => {
    const getText = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    };

    const getAttr = (selector, attr) => {
      const el = document.querySelector(selector);
      return el ? el.getAttribute(attr) : null;
    };

    const name = getText(['h1.DUwDvf', 'h1']);

    // Address, phone, website via aria-labels (taalonafhankelijk via icoon-classes)
    const buttons = Array.from(document.querySelectorAll('button[data-item-id], a[data-item-id]'));
    let address = null, phone = null, website = null;

    for (const btn of buttons) {
      const id = btn.getAttribute('data-item-id') || '';
      const aria = btn.getAttribute('aria-label') || '';
      const text = btn.textContent.trim();

      if (id === 'address' || aria.toLowerCase().includes('adres') || aria.toLowerCase().includes('address')) {
        address = text.replace(/^Adres:\s*/i, '').replace(/^Address:\s*/i, '');
      } else if (id.startsWith('phone') || aria.toLowerCase().includes('telefoon') || aria.toLowerCase().includes('phone')) {
        phone = text.replace(/^Telefoon:\s*/i, '').replace(/^Phone:\s*/i, '');
      } else if (id === 'authority' || aria.toLowerCase().includes('website')) {
        website = btn.getAttribute('href') || text;
      }
    }

    // Fallback: zoek expliciete website link
    if (!website) {
      const wsLink = document.querySelector('a[data-item-id="authority"]');
      if (wsLink) website = wsLink.href;
    }

    // Rating
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

    // Categorie
    const categoryEl = document.querySelector('button[jsaction*="category"]');
    const category = categoryEl ? categoryEl.textContent.trim() : null;

    return {
      name,
      address,
      phone,
      website,
      google_maps_url: window.location.href,
      rating,
      review_count: reviewCount,
      category,
    };
  });
}

module.exports = { scrapeGoogleMaps };
