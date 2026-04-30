// analyzer.js - Website analyse met scoring + email scraper
const axios = require('axios');
const cheerio = require('cheerio');

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || '';
const ANALYSIS_TIMEOUT = 25000;

// CMS fingerprints — modern = bestaande site, dus minder kans op vervanging
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
  } else if (/jquery/i.test(html)) {
    stack.push('jQuery (versie onbekend)');
  }
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

// Email harvesting — pakt contactadressen van homepage + contact page
async function scrapeEmails(baseUrl, $homepage, html) {
  const emails = new Set();
  const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g;

  // Pak emails uit homepage HTML
  const homepageEmails = (html.match(emailRegex) || [])
    .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg') && !e.endsWith('.svg'))
    .filter(e => !e.includes('example.com') && !e.includes('your-email'))
    .filter(e => !e.includes('sentry.io') && !e.includes('wixpress.com'));
  homepageEmails.forEach(e => emails.add(e.toLowerCase()));

  // Pak mailto: links
  $homepage('a[href^="mailto:"]').each((_, el) => {
    const href = $homepage(el).attr('href') || '';
    const m = href.replace(/^mailto:/, '').split('?')[0];
    if (m && emailRegex.test(m)) emails.add(m.toLowerCase());
  });

  // Probeer ook contact pagina als we minder dan 1 email hebben
  if (emails.size === 0) {
    const contactLinks = [];
    $homepage('a[href]').each((_, el) => {
      const href = $homepage(el).attr('href') || '';
      const text = $homepage(el).text().toLowerCase();
      if (/contact|kontakt/i.test(href) || /contact|kontakt/i.test(text)) {
        try {
          const url = new URL(href, baseUrl).toString();
          contactLinks.push(url);
        } catch (_) {}
      }
    });

    // Probeer eerste 1 contact link
    for (const link of contactLinks.slice(0, 1)) {
      try {
        const resp = await axios.get(link, {
          timeout: 10000,
          maxRedirects: 3,
          headers: { 'User-Agent': 'Mozilla/5.0' },
        });
        const html2 = resp.data || '';
        const found = (html2.match(emailRegex) || [])
          .filter(e => !e.endsWith('.png') && !e.endsWith('.jpg'));
        found.forEach(e => emails.add(e.toLowerCase()));
        if (emails.size > 0) break;
      } catch (_) { /* skip */ }
    }
  }

  return [...emails].slice(0, 5);
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
      timeout: ANALYSIS_TIMEOUT,
      maxRedirects: 5,
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

  // Viewport
  const viewport = $('meta[name="viewport"]').attr('content');
  result.has_viewport_meta = !!viewport;
  if (!viewport) result.issues.push('Geen viewport meta tag (niet mobiel-vriendelijk)');
  else result.is_mobile_friendly = true;

  // CMS detectie
  for (const fp of CMS_FINGERPRINTS) {
    if (fp.test($, html, response.headers)) {
      result.has_cms = true;
      result.cms_type = fp.name;
      if (!fp.modern) result.issues.push(`Verouderd platform: ${fp.name}`);
      break;
    }
  }
  if (!result.has_cms) result.issues.push('Geen CMS gedetecteerd (handgeschreven HTML)');

  // Open Graph
  result.has_open_graph = $('meta[property^="og:"]').length > 0;
  if (!result.has_open_graph) result.issues.push('Geen Open Graph tags (slechte social SEO)');

  // Tech stack
  result.tech_stack = detectTechStack($, html);
  for (const o of result.tech_stack.filter(t => t.startsWith('OUTDATED:'))) {
    result.issues.push(`Verouderde tech: ${o.replace('OUTDATED:', '')}`);
  }

  // Table layout
  if (isTableBasedLayout($)) result.issues.push('Table-based layout (oude HTML structuur)');

  // Inline styles
  const inlineCount = $('[style]').length;
  if (inlineCount > 30) result.issues.push(`Veel inline styles (${inlineCount}) — slechte code`);

  // Copyright jaar
  const bodyText = $('body').text();
  const copyMatches = [...bodyText.matchAll(/(?:©|&copy;|copyright)[^\d]*(\d{4})/gi)];
  if (copyMatches.length > 0) {
    const years = copyMatches.map(m => parseInt(m[1])).filter(y => y > 1995 && y <= new Date().getFullYear());
    if (years.length > 0) {
      result.copyright_year = Math.max(...years);
      const cy = new Date().getFullYear();
      if (result.copyright_year < cy - 4) result.issues.push(`Copyright jaar ${result.copyright_year} (4+ jaar oud)`);
      else if (result.copyright_year < cy - 2) result.issues.push(`Copyright jaar ${result.copyright_year} (verouderd)`);
    }
  } else {
    // Geen copyright = verdacht
    if ($('footer').length === 0) result.issues.push('Geen footer (basale site structuur ontbreekt)');
  }

  // Comic Sans
  if (/comic sans/i.test(html)) result.issues.push('Gebruikt Comic Sans (oude stijl)');

  // Favicon
  if ($('link[rel*="icon"]').length === 0) result.issues.push('Geen favicon');

  // Meta description
  if (!$('meta[name="description"]').attr('content')) result.issues.push('Geen meta description');

  // Alt tags
  const imgs = $('img');
  const noAlt = imgs.filter((_, el) => !$(el).attr('alt')).length;
  if (imgs.length > 5 && noAlt / imgs.length > 0.5) {
    result.issues.push('Meeste afbeeldingen zonder alt tekst');
  }

  // Responsive images
  const responsive = $('img[srcset], picture source').length;
  if (imgs.length > 5 && responsive === 0) {
    result.issues.push('Geen responsive afbeeldingen (srcset/picture)');
  }

  // Veel kleine afbeeldingen ipv 1 hero
  if (imgs.length > 30) result.issues.push(`Veel afbeeldingen (${imgs.length}) — mogelijk slecht geoptimaliseerd`);

  // Geen CTA / contactformulier
  const hasContactForm = $('form').filter((_, el) => {
    const txt = $(el).text().toLowerCase();
    return /contact|bericht|aanvraag|vraag|offerte/.test(txt);
  }).length > 0;
  if (!hasContactForm) result.issues.push('Geen contactformulier op homepage');

  // Email scraping
  try {
    result.emails = await scrapeEmails(result.url, $, html);
  } catch (e) { /* skip */ }

  // PageSpeed (optioneel)
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
    } catch (e) { /* skip */ }
  }

  result.replacement_score = calculateReplacementScore(result);
  return result;
}

function calculateReplacementScore(r) {
  let score = 0;

  // Mobile = absolute essential anno 2026, hoogste weging
  if (!r.is_mobile_friendly) score += 30;

  // HTTPS
  if (!r.has_https) score += 20;

  // CMS — modern CMS = vrij waarschijnlijk al onderhouden, dus aftrekken
  if (r.has_cms && r.cms_type && !r.cms_type.includes('legacy') && !r.cms_type.includes('FrontPage') && !r.cms_type.includes('Dreamweaver')) {
    // Modern CMS, verlaag score want zit waarschijnlijk al goed
  } else if (!r.has_cms) {
    score += 18; // handmatige HTML = waarschijnlijk oud
  } else {
    score += 25; // FrontPage etc.
  }

  // Open Graph = moderne site indicator
  if (!r.has_open_graph) score += 5;

  // Copyright jaar
  if (r.copyright_year) {
    const yearsOld = new Date().getFullYear() - r.copyright_year;
    if (yearsOld >= 6) score += 14;
    else if (yearsOld >= 4) score += 10;
    else if (yearsOld >= 2) score += 5;
  }

  // PageSpeed
  if (r.pagespeed_score !== null) {
    if (r.pagespeed_score < 25) score += 18;
    else if (r.pagespeed_score < 45) score += 12;
    else if (r.pagespeed_score < 65) score += 6;
  }

  // Outdated tech (per item)
  const outdated = (r.tech_stack || []).filter(t => t.startsWith('OUTDATED:')).length;
  score += outdated * 6;

  // Issues count (algemeen)
  score += Math.min(r.issues.length * 1.2, 12);

  return Math.min(Math.round(score), 100);
}

module.exports = { analyzeWebsite };
