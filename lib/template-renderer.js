// lib/template-renderer.js - Vervang {{variabelen}} in templates
const db = require('../db');

/**
 * Render een template met lead + settings data.
 * Ondersteunt: {{lead.field}} en {{settings.key}}
 * Plus computed fields: {{lead.first_issue}}, {{lead.website_short}}, {{lead.email}}
 */
function render(template, lead) {
  if (!template) return '';
  const settings = db.getAllSettings();

  // Parse JSON fields
  let issues = [];
  try { issues = lead.issues ? (typeof lead.issues === 'string' ? JSON.parse(lead.issues) : lead.issues) : []; } catch {}
  let emails = [];
  try { emails = lead.emails ? (typeof lead.emails === 'string' ? JSON.parse(lead.emails) : lead.emails) : []; } catch {}

  // Computed fields
  const firstIssue = issues.length > 0 ? issues[0] : 'enkele verbeterpunten';
  const websiteShort = lead.website ? lead.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';
  const primaryEmail = emails[0] || '';
  const firstName = (lead.name || '').split(' ')[0];

  const ctx = {
    lead: {
      ...lead,
      first_issue: firstIssue,
      issues_text: issues.slice(0, 3).map(i => `- ${i}`).join('\n'),
      website_short: websiteShort,
      email: primaryEmail,
      first_name: firstName,
      pagespeed_score: lead.pagespeed_score ?? '?',
      score: lead.replacement_score ?? '?',
    },
    settings,
  };

  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, path) => {
    const parts = path.split('.');
    let val = ctx;
    for (const p of parts) {
      val = val?.[p];
      if (val === undefined || val === null) return '';
    }
    return String(val);
  });
}

function listAvailableVars() {
  return [
    'lead.name', 'lead.first_name', 'lead.address', 'lead.phone', 'lead.website',
    'lead.website_short', 'lead.email', 'lead.branch_name', 'lead.city_name',
    'lead.rating', 'lead.review_count', 'lead.score', 'lead.pagespeed_score',
    'lead.first_issue', 'lead.issues_text', 'lead.cms_type', 'lead.copyright_year',
    'settings.sender_name', 'settings.sender_email', 'settings.company_name',
    'settings.signature',
  ];
}

module.exports = { render, listAvailableVars };
