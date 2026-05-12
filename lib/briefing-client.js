// lib/briefing-client.js - HTTP-client naar briefing.aitomade.nl voor auto-create van briefings
const axios = require('axios');

const BRIEFING_BASE_URL = process.env.BRIEFING_BASE_URL || 'https://briefing.aitomade.nl';

function slugify(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // strip accents
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 60);
}

async function createBriefingLink({ companyName, source = 'leadgen-bot', partner = '', markup = 0 }) {
  const token = process.env.BRIEFING_API_TOKEN;
  if (!token) throw new Error('BRIEFING_API_TOKEN niet ingesteld');

  const slug = slugify(companyName);
  if (!slug) throw new Error('Kan geen geldige slug genereren uit companyName');

  const url = `${BRIEFING_BASE_URL}/?action=create-client`;
  const params = new URLSearchParams();
  params.set('slug', slug);
  params.set('source', source);
  if (partner) params.set('partner', partner);
  if (markup > 0) params.set('markup', String(markup));

  try {
    const res = await axios.post(url, params, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 10000,
    });
    if (res.data && res.data.ok) {
      return { slug, url: res.data.url, existed: !!res.data.existed };
    }
    throw new Error(res.data?.error || 'create-client returned no ok');
  } catch (err) {
    if (err.response) {
      throw new Error(`Briefing API ${err.response.status}: ${err.response.data?.error || err.message}`);
    }
    throw err;
  }
}

/**
 * Sync complete lead-context (contactgegevens, analyse, communications, bookings,
 * notities) naar briefing-app onder de slug. Briefing-app slaat als JSON op en
 * toont het in admin klant-edit view onder "Voorgeschiedenis".
 *
 * Idempotent: kan vaker worden aangeroepen — overschrijft de history-snapshot.
 */
async function syncLeadContext({ slug, payload }) {
  const token = process.env.BRIEFING_API_TOKEN;
  if (!token) throw new Error('BRIEFING_API_TOKEN niet ingesteld');
  if (!slug) throw new Error('slug verplicht');

  const url = `${BRIEFING_BASE_URL}/?action=sync-lead-context`;
  try {
    const res = await axios.post(url, { slug, ...payload }, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      timeout: 10000,
    });
    if (res.data && res.data.ok) return { ok: true };
    throw new Error(res.data?.error || 'sync-lead-context returned no ok');
  } catch (err) {
    if (err.response) {
      throw new Error(`Briefing sync ${err.response.status}: ${err.response.data?.error || err.message}`);
    }
    throw err;
  }
}

module.exports = { createBriefingLink, syncLeadContext, slugify };
