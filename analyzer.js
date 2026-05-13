// analyzer.js - Website analyse met scoring + email scraper
const axios = require('axios');
const cheerio = require('cheerio');

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';
const ANALYSIS_TIMEOUT = 25000;

const CMS_FINGERPRINTS = [
  { name: 'WordPress', test: ($, html, h) =>
      html.includes('/wp-content/') || html.includes('/wp-includes/') ||
      (h['x-powered-by'] || '').includes('WordPress'), modern: true },
  { name: 'Wix', test: (_, html) => html.includes('static.wixstatic.com') || html.includes('wix.com'), modern: true },
  { name: 'Squarespace', test: (_, html) => html.includes('squarespace.com'), modern: true },
  { name: 'Shopify', test: (_, html, h) => html.includes('cdn.shopify.com') || h['x-shopify-stage'], modern: true },
  { name: 'Webflow', test: (_, html) => html.includes('webflow.com') || html.includes('wf-page-id'), modern: true },
  { name: 'Joomla', test: (_, html) => html.includes('/components/com_'), modern: true },
  { name: 'Drupal', test: (_, html, h) => html.includes('Drupal.settings') || (h['x-generator'] || '').includes('Drupal'), modern: true },
  { name: 'Next.js', test: (_, html) => html.includes('__NEXT_DATA__') || html.includes('/_next/'), modern: true },
  { name: 'React app', test: (_, html) => html.includes('data-reactroot') || /react@\d/.test(html), modern: true },
  { name: 'Jimdo', test: (_, html) => html.includes('jimdo'), modern: true },
  { name: 'Strato Sitebuilder', test: (_, html) => html.includes('strato-editor'), modern: true },
  { name: 'Mijndomein Sitebuilder', test: (_, html) => html.includes('mijndomein-sitebuilder'), modern: true },
  { name: 'FrontPage (legacy)', test: (_, html) => html.includes('FrontPage') || html.includes('_vti_'), modern: false },
  { name: 'Dreamweaver (legacy)', test: (_, html) => /generator.*dreamweaver/i.test(html), modern: false },
];

function detectTechStack($, html) {
  const stack = [];
  const jq = html.match(/jquery[/-](\d+)\.(\d+)\.(\d+)/i);
  if (jq) {
    const major = parseInt(jq[1]);
    stack.push(`jQuery ${jq[1]}.${jq[2]}.${jq[3]}`);
    if (major < 2) stack.push('OUTDATED:jQuery 1.x');
    else if (major === 2) stack.push('OUTDATED:jQuery 2.x');
  } else if (/jquery/i.test(html)) stack.push('jQuery (versie onbekend)');
  if (/<frameset|<frame /i.test(html)) stack.push('OUTDATED:Frames');
  if (/\.swf|application\/x-shockwave-flash/i.test(html)) stack.push('OUTDATED:Flash');
  if (/<marquee|<blink/i.test(html)) stack.push('OUTDATED:Marquee/Blink tags');
  if ($('font').length > 0) stack.push('OUTDATED:<font> tags');
  if ($('center').length > 0) stack.push('OUTDATED:<center> tags');
  const bs = html.match(/bootstrap[/-](\d+)\.(\d+)/i);
  if (bs) {
    stack.push(`Bootstrap ${bs[1]}.${bs[2]}`);
    if (parseInt(bs[1]) < 4) stack.push('OUTDATED:Bootstrap < 4');
  }
  return stack;
}

function isTableBasedLayout($) {
  const tables = $('table');
  if (tables.length === 0) return false;
  let layoutTables = 0;
  tables.each((_, el) => {
    const $t = $(el);
    const role = $t.attr('role');
    const hasNested = $t.find('table').length > 0;
    const cellCount = $t.find('td').length;
    if ((hasNested || cellCount > 10) && role !== 'presentation' && $t.find('thead').length === 0) {
      layoutTables++;
    }
  });
  return layoutTables >= 1;
}

const EMAIL_REGEX = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const CONTACT_PATHS = [
  '/contact', '/contact.html', '/contact.php', '/contact-us', '/contactgegevens',
  '/kontakt', '/over-ons', '/over', '/over-mij', '/about', '/about-us',
  '/info', '/informatie', '/impressum', '/imprint', '/colofon',
];
const CONTACT_LINK_RE = /contact|kontakt|over[- ]?ons|over[- ]?mij|about|impressum|imprint|colofon|info|adres/i;
const JUNK_TLDS = ['.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.ico', '.css', '.js'];
const JUNK_DOMAINS = ['example.com', 'your-email', 'sentry.io', 'wixpress.com', 'cloudflare', 'godaddy', 'sentry-next.wixpress'];

function cfDecode(cipher) {
  try {
    const r = parseInt(cipher.substr(0, 2), 16);
    let out = '';
    for (let i = 2; i < cipher.length; i += 2) {
      out += String.fromCharCode(parseInt(cipher.substr(i, 2), 16) ^ r);
    }
    return out.toLowerCase();
  } catch { return null; }
}

function deobfuscate(text) {
  if (!text) return '';
  return text
    .replace(/&#0?64;|&commat;|&#x40;/gi, '@')
    .replace(/&#46;|&period;|&#x2e;/gi, '.')
    .replace(/\s*\[\s*at\s*\]\s*/gi, '@')
    .replace(/\s*\(\s*at\s*\)\s*/gi, '@')
    .replace(/\s*\{\s*at\s*\}\s*/gi, '@')
    .replace(/\s+at\s+/gi, '@')
    .replace(/\s*\[\s*dot\s*\]\s*/gi, '.')
    .replace(/\s*\(\s*dot\s*\)\s*/gi, '.')
    .replace(/\s*\{\s*dot\s*\}\s*/gi, '.')
    .replace(/\s+dot\s+/gi, '.');
}

function isJunkEmail(e) {
  e = e.toLowerCase();
  if (JUNK_TLDS.some(t => e.endsWith(t))) return true;
  if (JUNK_DOMAINS.some(d => e.includes(d))) return true;
  if (/^(noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|abuse|webmaster@(?:cloudflare|wix))/i.test(e)) return true;
  return false;
}

function harvestPage($page, pageHtml, emails) {
  const add = (text) => {
    const matches = (deobfuscate(text || '').match(EMAIL_REGEX) || []);
    for (const m of matches) {
      const e = m.toLowerCase();
      if (!isJunkEmail(e)) emails.add(e);
    }
  };
  // Cloudflare email-protection (zeer veel gebruikt op kozijnsites)
  $page('[data-cfemail]').each((_, el) => {
    const cipher = $page(el).attr('data-cfemail');
    if (cipher) { const d = cfDecode(cipher); if (d) add(d); }
  });
  for (const m of (pageHtml || '').matchAll(/data-cfemail=["']([0-9a-fA-F]+)["']/g)) {
    const d = cfDecode(m[1]); if (d) add(d);
  }
  // mailto: links (incl. URL-encoded)
  $page('a[href^="mailto:"]').each((_, el) => {
    const href = $page(el).attr('href') || '';
    try { add(decodeURIComponent(href.replace(/^mailto:/i, '').split('?')[0])); }
    catch { add(href.replace(/^mailto:/i, '').split('?')[0]); }
  });
  // JSON-LD email-velden (Organization, LocalBusiness)
  $page('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($page(el).contents().text());
      const stack = [data];
      while (stack.length) {
        const node = stack.pop();
        if (!node) continue;
        if (Array.isArray(node)) { stack.push(...node); continue; }
        if (typeof node === 'object') {
          if (typeof node.email === 'string') add(node.email);
          for (const v of Object.values(node)) if (v && typeof v === 'object') stack.push(v);
        }
      }
    } catch (_) {}
  });
  // Body-text (gevangen geobfusceerde adressen)
  add($page('body').text());
  // Raw HTML als vangnet
  add(pageHtml);
}

async function fetchPage(url) {
  try {
    const resp = await axios.get(url, {
      timeout: 8000, maxRedirects: 3,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      },
      validateStatus: s => s < 500,
    });
    if (typeof resp.data === 'string' && resp.data.length > 100) return resp.data;
  } catch (_) {}
  return null;
}

async function scrapeEmails(baseUrl, $homepage, html) {
  const emails = new Set();
  harvestPage($homepage, html, emails);

  // Verzamel contact-links uit homepage + standaard-paden
  const visited = new Set();
  const candidates = [];
  $homepage('a[href]').each((_, el) => {
    const href = $homepage(el).attr('href') || '';
    const text = $homepage(el).text();
    if (CONTACT_LINK_RE.test(href) || CONTACT_LINK_RE.test(text)) {
      try {
        const url = new URL(href, baseUrl).toString();
        if (!visited.has(url)) { candidates.push(url); visited.add(url); }
      } catch (_) {}
    }
  });
  for (const p of CONTACT_PATHS) {
    try {
      const url = new URL(p, baseUrl).toString();
      if (!visited.has(url)) { candidates.push(url); visited.add(url); }
    } catch (_) {}
  }

  // Crawl tot 4 pagina's (stopt zodra we 3 emails hebben — anders gaan we tot het einde)
  for (const link of candidates.slice(0, 4)) {
    if (emails.size >= 3) break;
    const pageHtml = await fetchPage(link);
    if (!pageHtml) continue;
    try {
      const $page = cheerio.load(pageHtml);
      harvestPage($page, pageHtml, emails);
    } catch (_) {}
  }

  return [...emails].slice(0, 5);
}

async function scrapeEmailsForUrl(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) return [];
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  const html = await fetchPage(url);
  if (!html) return [];
  try {
    const $ = cheerio.load(html);
    return await scrapeEmails(url, $, html);
  } catch { return []; }
}

async function analyzeWebsite(rawUrl) {
  const result = {
    url: null, has_https: false, is_mobile_friendly: false, has_cms: false,
    cms_type: null, has_viewport_meta: false, has_open_graph: false,
    pagespeed_score: null, copyright_year: null, last_modified: null,
    tech_stack: [], issues: [], replacement_score: 0, error: null, emails: [],
  };

  let url = (rawUrl || '').trim();
  if (!url) { result.error = 'Geen website URL'; return result; }
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  result.url = url;

  let response;
  try {
    response = await axios.get(url, {
      timeout: ANALYSIS_TIMEOUT, maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'nl-NL,nl;q=0.9,en;q=0.8',
      },
      validateStatus: s => s < 500,
    });
  } catch (err) {
    if (url.startsWith('https://')) {
      try {
        const httpUrl = url.replace(/^https:/, 'http:');
        response = await axios.get(httpUrl, { timeout: ANALYSIS_TIMEOUT, maxRedirects: 5 });
        result.url = httpUrl;
        result.issues.push('Geen werkende HTTPS (alleen HTTP bereikbaar)');
      } catch (err2) {
        result.error = `Niet bereikbaar: ${err.message}`;
        result.replacement_score = 50;
        return result;
      }
    } else {
      result.error = `Niet bereikbaar: ${err.message}`;
      result.replacement_score = 50;
      return result;
    }
  }

  const html = response.data || '';
  const finalUrl = response.request?.res?.responseUrl || result.url;
  result.has_https = finalUrl.startsWith('https://');
  result.last_modified = response.headers['last-modified'] || null;

  if (!result.has_https) result.issues.push('Geen HTTPS / SSL');

  if (typeof html !== 'string' || html.length < 100) {
    result.error = 'Lege response';
    result.replacement_score = 60;
    return result;
  }

  const $ = cheerio.load(html);

  const viewport = $('meta[name="viewport"]').attr('content');
  result.has_viewport_meta = !!viewport;
  if (!viewport) result.issues.push('Geen viewport meta tag (niet mobiel-vriendelijk)');
  else result.is_mobile_friendly = true;

  for (const fp of CMS_FINGERPRINTS) {
    if (fp.test($, html, response.headers)) {
      result.has_cms = true;
      result.cms_type = fp.name;
      if (!fp.modern) result.issues.push(`Verouderd platform: ${fp.name}`);
      break;
    }
  }
  if (!result.has_cms) result.issues.push('Geen CMS gedetecteerd (handgeschreven HTML)');

  result.has_open_graph = $('meta[property^="og:"]').length > 0;
  if (!result.has_open_graph) result.issues.push('Geen Open Graph tags (slechte social SEO)');

  result.tech_stack = detectTechStack($, html);
  for (const o of result.tech_stack.filter(t => t.startsWith('OUTDATED:'))) {
    result.issues.push(`Verouderde tech: ${o.replace('OUTDATED:', '')}`);
  }

  if (isTableBasedLayout($)) result.issues.push('Table-based layout (oude HTML structuur)');

  const inlineCount = $('[style]').length;
  if (inlineCount > 30) result.issues.push(`Veel inline styles (${inlineCount})`);

  const bodyText = $('body').text();
  const copyMatches = [...bodyText.matchAll(/(?:©|&copy;|copyright)[^\d]*(\d{4})/gi)];
  if (copyMatches.length > 0) {
    const years = copyMatches.map(m => parseInt(m[1])).filter(y => y > 1995 && y <= new Date().getFullYear());
    if (years.length > 0) {
      result.copyright_year = Math.max(...years);
      const cy = new Date().getFullYear();
      if (result.copyright_year < cy - 4) result.issues.push(`Copyright ${result.copyright_year} (4+ jaar oud)`);
      else if (result.copyright_year < cy - 2) result.issues.push(`Copyright ${result.copyright_year} (verouderd)`);
    }
  } else {
    if ($('footer').length === 0) result.issues.push('Geen footer (basale structuur ontbreekt)');
  }

  if (/comic sans/i.test(html)) result.issues.push('Gebruikt Comic Sans');
  if ($('link[rel*="icon"]').length === 0) result.issues.push('Geen favicon');
  if (!$('meta[name="description"]').attr('content')) result.issues.push('Geen meta description');

  const imgs = $('img');
  const noAlt = imgs.filter((_, el) => !$(el).attr('alt')).length;
  if (imgs.length > 5 && noAlt / imgs.length > 0.5) result.issues.push('Meeste afbeeldingen zonder alt tekst');

  const responsive = $('img[srcset], picture source').length;
  if (imgs.length > 5 && responsive === 0) result.issues.push('Geen responsive afbeeldingen');

  if (imgs.length > 30) result.issues.push(`Veel afbeeldingen (${imgs.length})`);

  const hasContactForm = $('form').filter((_, el) => {
    const txt = $(el).text().toLowerCase();
    return /contact|bericht|aanvraag|vraag|offerte/.test(txt);
  }).length > 0;
  if (!hasContactForm) result.issues.push('Geen contactformulier op homepage');

  try { result.emails = await scrapeEmails(result.url, $, html); } catch (e) {}

  if (PAGESPEED_API_KEY) {
    try {
      const ps = await axios.get(
        'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
        { params: { url: result.url, strategy: 'mobile', key: PAGESPEED_API_KEY }, timeout: 30000 }
      );
      const score = ps.data?.lighthouseResult?.categories?.performance?.score;
      if (typeof score === 'number') {
        result.pagespeed_score = Math.round(score * 100);
        if (result.pagespeed_score < 30) result.issues.push(`Zeer slechte PageSpeed (${result.pagespeed_score}/100)`);
        else if (result.pagespeed_score < 50) result.issues.push(`Slechte PageSpeed (${result.pagespeed_score}/100)`);
      }
    } catch (e) {}
  }

  result.replacement_score = calculateReplacementScore(result);
  return result;
}

function calculateReplacementScore(r) {
  let score = 0;

  // Mobile = absolute essential anno 2026
  if (!r.is_mobile_friendly) score += 30;

  // HTTPS
  if (!r.has_https) score += 20;

  // CMS handling
  if (r.has_cms && r.cms_type && !r.cms_type.includes('legacy')) {
    // Modern CMS: minder kans op vervanging
  } else if (!r.has_cms) {
    score += 18;
  } else {
    score += 25; // FrontPage etc.
  }

  if (!r.has_open_graph) score += 5;

  if (r.copyright_year) {
    const yearsOld = new Date().getFullYear() - r.copyright_year;
    if (yearsOld >= 6) score += 14;
    else if (yearsOld >= 4) score += 10;
    else if (yearsOld >= 2) score += 5;
  }

  if (r.pagespeed_score !== null) {
    if (r.pagespeed_score < 25) score += 18;
    else if (r.pagespeed_score < 45) score += 12;
    else if (r.pagespeed_score < 65) score += 6;
  }

  const outdated = (r.tech_stack || []).filter(t => t.startsWith('OUTDATED:')).length;
  score += outdated * 6;

  score += Math.min(r.issues.length * 1.2, 12);

  return Math.min(Math.round(score), 100);
}

module.exports = { analyzeWebsite, scrapeEmailsForUrl };
