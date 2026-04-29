// analyzer.js - Website analyse met scoring voor "vervangbaarheid"
const axios = require('axios');
const cheerio = require('cheerio');

const PAGESPEED_API_KEY = process.env.PAGESPEED_API_KEY || ''; // optioneel, werkt ook zonder
const ANALYSIS_TIMEOUT = 20000;

/**
 * CMS / framework fingerprints
 * Hogere score = moderner platform
 */
const CMS_FINGERPRINTS = [
  { name: 'WordPress', test: ($, html, headers) =>
      html.includes('/wp-content/') || html.includes('/wp-includes/') || (headers['x-powered-by'] || '').includes('WordPress'),
    modern: true },
  { name: 'Wix', test: (_, html) => html.includes('static.wixstatic.com') || html.includes('wix.com'), modern: true },
  { name: 'Squarespace', test: (_, html) => html.includes('squarespace.com') || html.includes('static1.squarespace'), modern: true },
  { name: 'Shopify', test: (_, html, headers) => html.includes('cdn.shopify.com') || (headers['x-shopify-stage']), modern: true },
  { name: 'Webflow', test: (_, html) => html.includes('webflow.com') || html.includes('wf-page-id'), modern: true },
  { name: 'Joomla', test: (_, html) => html.includes('/components/com_') || html.includes('Joomla'), modern: true },
  { name: 'Drupal', test: (_, html, headers) => html.includes('Drupal.settings') || (headers['x-generator'] || '').includes('Drupal'), modern: true },
  { name: 'Next.js', test: (_, html) => html.includes('__NEXT_DATA__') || html.includes('/_next/'), modern: true },
  { name: 'React', test: (_, html) => html.includes('react.production') || html.includes('data-reactroot') || html.includes('id="root"'), modern: true },
  { name: 'Jimdo', test: (_, html) => html.includes('jimdo') || html.includes('jimdofree'), modern: true },
  { name: 'Strato Sitebuilder', test: (_, html) => html.includes('strato-editor') || html.includes('cdn.strato'), modern: true },
  { name: 'Mijndomein Sitebuilder', test: (_, html) => html.includes('mijndomein'), modern: true },
  { name: 'Frontpage (legacy)', test: (_, html) => html.includes('FrontPage') || html.includes('_vti_'), modern: false },
  { name: 'Dreamweaver (legacy)', test: (_, html) => html.includes('Dreamweaver') || html.includes('Adobe Dreamweaver'), modern: false },
];

/**
 * Tech stack fingerprints (jQuery versie, Flash, etc.)
 */
function detectTechStack($, html) {
  const stack = [];

  // jQuery versie
  const jqMatch = html.match(/jquery[/-](\d+)\.(\d+)\.(\d+)/i);
  if (jqMatch) {
    const major = parseInt(jqMatch[1]);
    stack.push(`jQuery ${jqMatch[1]}.${jqMatch[2]}.${jqMatch[3]}`);
    if (major < 2) stack.push('OUTDATED:jQuery 1.x');
  } else if (html.match(/jquery/i)) {
    stack.push('jQuery (versie onbekend)');
  }

  if (html.match(/<frameset|<frame /i)) stack.push('OUTDATED:Frames');
  if (html.match(/\.swf|application\/x-shockwave-flash/i)) stack.push('OUTDATED:Flash');
  if (html.match(/<marquee|<blink/i)) stack.push('OUTDATED:Marquee/Blink tags');

  if ($('font').length > 0) stack.push('OUTDATED:<font> tags');
  if ($('center').length > 0) stack.push('OUTDATED:<center> tags');

  // Bootstrap versie
  const bsMatch = html.match(/bootstrap[/-](\d+)\.(\d+)/i);
  if (bsMatch) {
    stack.push(`Bootstrap ${bsMatch[1]}.${bsMatch[2]}`);
    if (parseInt(bsMatch[1]) < 4) stack.push('OUTDATED:Bootstrap < 4');
  }

  return stack;
}

/**
 * Detecteer table-based layout (oude HTML stijl)
 */
function isTableBasedLayout($) {
  const tables = $('table');
  if (tables.length === 0) return false;

  // Tabellen met layout-rol (geen role="presentation" maar wel veel inhoud)
  let layoutTables = 0;
  tables.each((_, el) => {
    const $t = $(el);
    const role = $t.attr('role');
    const hasNestedTables = $t.find('table').length > 0;
    const cellCount = $t.find('td').length;
    // Nested tables of veel cellen zonder thead = waarschijnlijk layout
    if ((hasNestedTables || cellCount > 10) && role !== 'presentation' && $t.find('thead').length === 0) {
      layoutTables++;
    }
  });
  return layoutTables >= 1;
}

/**
 * Analyseer een website
 */
async function analyzeWebsite(rawUrl) {
  const result = {
    url: null,
    has_https: false,
    is_mobile_friendly: false,
    has_cms: false,
    cms_type: null,
    has_viewport_meta: false,
    has_open_graph: false,
    pagespeed_score: null,
    copyright_year: null,
    last_modified: null,
    tech_stack: [],
    issues: [],
    replacement_score: 0,
    error: null,
  };

  // Normaliseer URL
  let url = (rawUrl || '').trim();
  if (!url) {
    result.error = 'Geen website URL';
    return result;
  }
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
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
      validateStatus: (s) => s < 500,
    });
  } catch (err) {
    // Probeer http fallback
    if (url.startsWith('https://')) {
      try {
        const httpUrl = url.replace(/^https:/, 'http:');
        response = await axios.get(httpUrl, { timeout: ANALYSIS_TIMEOUT, maxRedirects: 5 });
        result.url = httpUrl;
        result.issues.push('Geen werkende HTTPS (alleen HTTP bereikbaar)');
      } catch (err2) {
        result.error = `Niet bereikbaar: ${err.message}`;
        result.replacement_score = 50; // onbekend, neutraal
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

  if (!result.has_https) {
    result.issues.push('Geen HTTPS (geen SSL certificaat)');
  }

  if (typeof html !== 'string' || html.length < 100) {
    result.error = 'Lege of ongeldige response';
    result.replacement_score = 60;
    return result;
  }

  const $ = cheerio.load(html);

  // Viewport meta tag
  const viewport = $('meta[name="viewport"]').attr('content');
  result.has_viewport_meta = !!viewport;
  if (!viewport) {
    result.issues.push('Geen viewport meta tag (niet mobiel-vriendelijk)');
  } else {
    result.is_mobile_friendly = true;
  }

  // CMS detectie
  for (const fp of CMS_FINGERPRINTS) {
    if (fp.test($, html, response.headers)) {
      result.has_cms = true;
      result.cms_type = fp.name;
      if (!fp.modern) {
        result.issues.push(`Verouderd platform: ${fp.name}`);
      }
      break;
    }
  }
  if (!result.has_cms) {
    result.issues.push('Geen CMS gedetecteerd (waarschijnlijk handgeschreven HTML)');
  }

  // Open Graph (moderne SEO)
  result.has_open_graph = $('meta[property^="og:"]').length > 0;
  if (!result.has_open_graph) {
    result.issues.push('Geen Open Graph tags (slechte social media SEO)');
  }

  // Tech stack
  result.tech_stack = detectTechStack($, html);
  const outdatedTech = result.tech_stack.filter(t => t.startsWith('OUTDATED:'));
  for (const o of outdatedTech) {
    result.issues.push(`Verouderde tech: ${o.replace('OUTDATED:', '')}`);
  }

  // Table-based layout
  if (isTableBasedLayout($)) {
    result.issues.push('Table-based layout (oude HTML structuur)');
  }

  // Inline styles (te veel = oud)
  const inlineStyleCount = $('[style]').length;
  if (inlineStyleCount > 30) {
    result.issues.push(`Veel inline styles (${inlineStyleCount}) — slechte code kwaliteit`);
  }

  // Copyright jaar in footer
  const bodyText = $('body').text();
  const copyMatches = [...bodyText.matchAll(/(?:©|&copy;|copyright)[^\d]*(\d{4})/gi)];
  if (copyMatches.length > 0) {
    const years = copyMatches.map(m => parseInt(m[1])).filter(y => y > 1995 && y <= new Date().getFullYear());
    if (years.length > 0) {
      result.copyright_year = Math.max(...years);
      const currentYear = new Date().getFullYear();
      if (result.copyright_year < currentYear - 2) {
        result.issues.push(`Copyright jaar is ${result.copyright_year} (waarschijnlijk niet onderhouden)`);
      }
    }
  }

  // Generic font tags / Comic Sans
  if (html.match(/comic sans/i)) {
    result.issues.push('Gebruikt Comic Sans (oude stijl)');
  }

  // Geen favicon
  if ($('link[rel*="icon"]').length === 0) {
    result.issues.push('Geen favicon');
  }

  // Geen meta description
  if (!$('meta[name="description"]').attr('content')) {
    result.issues.push('Geen meta description (slechte SEO)');
  }

  // Lage afbeelding kwaliteit / geen alt tekst
  const imgs = $('img');
  const imgsWithoutAlt = imgs.filter((_, el) => !$(el).attr('alt')).length;
  if (imgs.length > 5 && imgsWithoutAlt / imgs.length > 0.5) {
    result.issues.push('Meer dan helft van afbeeldingen heeft geen alt tekst');
  }

  // Geen responsive images
  const responsiveImgs = $('img[srcset], picture source').length;
  if (imgs.length > 5 && responsiveImgs === 0) {
    result.issues.push('Geen responsive afbeeldingen (srcset/picture)');
  }

  // PageSpeed Insights API (gratis, optioneel)
  if (PAGESPEED_API_KEY) {
    try {
      const psResp = await axios.get(
        'https://www.googleapis.com/pagespeedonline/v5/runPagespeed',
        {
          params: {
            url: result.url,
            strategy: 'mobile',
            key: PAGESPEED_API_KEY,
          },
          timeout: 30000,
        }
      );
      const score = psResp.data?.lighthouseResult?.categories?.performance?.score;
      if (typeof score === 'number') {
        result.pagespeed_score = Math.round(score * 100);
        if (result.pagespeed_score < 40) {
          result.issues.push(`Slechte PageSpeed score (${result.pagespeed_score}/100 op mobiel)`);
        }
      }
    } catch (err) {
      // PageSpeed faalde, geen probleem
    }
  }

  // Bereken vervangings-score (0-100, hoger = meer kans om te vervangen)
  result.replacement_score = calculateReplacementScore(result);
  return result;
}

/**
 * Score 0-100. Hoger = grotere kans dat website aan vervanging toe is.
 */
function calculateReplacementScore(r) {
  let score = 0;

  // Geen HTTPS = grote rode vlag
  if (!r.has_https) score += 20;

  // Niet mobiel-vriendelijk = grootste pijnpunt
  if (!r.is_mobile_friendly) score += 25;

  // Geen modern CMS
  if (!r.has_cms) score += 15;

  // Verouderd CMS
  if (r.cms_type && (r.cms_type.includes('legacy') || r.cms_type.includes('Frontpage') || r.cms_type.includes('Dreamweaver'))) {
    score += 20;
  }

  // Geen Open Graph
  if (!r.has_open_graph) score += 5;

  // Outdated copyright jaar
  if (r.copyright_year) {
    const yearsOld = new Date().getFullYear() - r.copyright_year;
    if (yearsOld >= 5) score += 10;
    else if (yearsOld >= 3) score += 6;
    else if (yearsOld >= 2) score += 3;
  }

  // PageSpeed
  if (r.pagespeed_score !== null) {
    if (r.pagespeed_score < 30) score += 15;
    else if (r.pagespeed_score < 50) score += 10;
    else if (r.pagespeed_score < 70) score += 5;
  }

  // Tech stack issues (per outdated item)
  const outdatedCount = (r.tech_stack || []).filter(t => t.startsWith('OUTDATED:')).length;
  score += outdatedCount * 5;

  // Algemene issues teller (max 10 punten boost)
  score += Math.min(r.issues.length * 1.5, 10);

  return Math.min(Math.round(score), 100);
}

module.exports = { analyzeWebsite };
