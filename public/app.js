// ============================================================
// Lead Hunter — Frontend logic
// ============================================================

const STAGES = [
  { id: 'new', label: 'Nieuw', color: 'var(--text-faint)' },
  { id: 'contacted', label: 'Benaderd', color: 'var(--info)' },
  { id: 'engaged', label: 'In gesprek', color: 'var(--warn)' },
  { id: 'quote_sent', label: 'Offerte verstuurd', color: 'var(--purple)' },
  { id: 'signed', label: 'Getekend', color: 'var(--success)' },
  { id: 'project', label: 'Project', color: 'var(--accent)' },
  { id: 'lost', label: 'Verloren', color: 'var(--danger)' },
];

const FUNNEL_STAGES = STAGES.filter(s => !['new', 'lost'].includes(s.id));

const state = {
  view: 'dashboard',
  leads: [],
  allLeads: [],
  filter: '50',  // default ≥ 50
  filterText: '',
  filterBranch: '',
  filterCity: '',
  filterAll: 'all',
  filterTextAll: '',
  filterBranchAll: '',
  filterCityAll: '',
  branches: [],
  cities: [],
  templates: [],
  sequences: [],
  settings: {},
  scheduler: {},
  currentLead: null,
  currentLeadTab: 'overview',
};

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (!res.ok) {
    let err = 'Fout';
    try { err = (await res.json()).error || err; } catch {}
    throw new Error(err);
  }
  return res.json();
}

function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

function timeAgo(iso) {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso + (iso.endsWith('Z') ? '' : 'Z')).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'zojuist';
  if (m < 60) return `${m}m geleden`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}u geleden`;
  const d = Math.floor(h / 24);
  return `${d}d geleden`;
}

function scoreClass(score) {
  if (score === null || score === undefined) return 'none';
  if (score >= 60) return 'high';
  if (score >= 35) return 'med';
  return 'low';
}

// === NAVIGATION ===
$$('.nav-item').forEach(item => {
  item.addEventListener('click', () => switchView(item.dataset.view));
});

function switchView(view, data = {}) {
  state.view = view;
  $$('.nav-item').forEach(i => i.classList.toggle('active', i.dataset.view === view));
  $$('.view').forEach(v => v.classList.toggle('active', v.id === `view-${view}`));

  const titles = {
    dashboard: 'Dashboard',
    leads: 'Hoge score leads',
    'all-leads': 'Alle leads',
    funnel: 'Funnel',
    pending: 'Berichten te bevestigen',
    projects: 'Projecten',
    branches: 'Branches',
    cities: 'Steden',
    templates: 'Templates',
    sequences: 'Sequences',
    settings: 'Instellingen',
    'lead-detail': data.leadName || 'Lead detail',
  };
  $('#topbarTitle').textContent = titles[view] || '';
  $('#topbarActions').innerHTML = '';

  if (view === 'dashboard') loadDashboard();
  if (view === 'leads') loadLeads();
  if (view === 'all-leads') loadAllLeads();
  if (view === 'funnel') loadFunnel();
  if (view === 'pending') loadPending();
  if (view === 'branches') loadBranches();
  if (view === 'cities') loadCities();
  if (view === 'templates') loadTemplatesList();
  if (view === 'sequences') loadSequencesList();
  if (view === 'settings') loadSettings();
  if (view === 'projects') loadProjects();
}

// === DASHBOARD ===
async function loadDashboard() {
  try {
    const data = await api('/api/dashboard');
    $('#dTotal').textContent = data.stats.total_leads;
    $('#dHighScore').textContent = data.stats.high_score_leads;
    $('#dToday').textContent = data.stats.leads_today;
    $('#dInFunnel').textContent = data.stats.in_funnel;
    $('#dQueueTotal').textContent = data.queue.total || 0;
    $('#dQueueDue').textContent = data.queue.due_now || 0;
    $('#dBranches').textContent = data.stats.unique_branches;
    $('#dCities').textContent = data.stats.unique_cities;
    $('#dTotalSub').textContent = `${data.stats.analyzed_leads} geanalyseerd`;

    updateAutopilotUI(data.scheduler);
    $('#navLeadsCount').textContent = data.stats.high_score_leads;
    const navAll = $('#navAllLeadsCount');
    if (navAll) navAll.textContent = data.stats.total_leads;
    $('#navFunnelCount').textContent = data.stats.in_funnel;
    $('#navPendingCount').textContent = data.pending_count;

    const grid = $('#topLeadsGrid');
    if (data.new_today.length === 0) {
      grid.innerHTML = `<div class="empty"><h3>nog geen nieuwe leads vandaag</h3><p>Auto-pilot vult deze lijst gedurende de dag</p></div>`;
    } else {
      grid.innerHTML = data.new_today.map(renderLeadCard).join('');
      attachLeadCardHandlers(grid);
    }
  } catch (e) {
    console.error(e);
  }
}

function updateAutopilotUI(s) {
  state.scheduler = s;
  const dot = $('#apDot');
  const label = $('#apLabel');
  const meta = $('#apMeta');
  const toggle = $('#apToggle');

  if (s.autopilotEnabled) {
    dot.className = s.lastError ? 'pulse-dot error' : 'pulse-dot on';
    label.textContent = s.currentJob ? `Bezig...` : 'Auto-pilot actief';
    meta.textContent = s.currentJob
      ? `${s.currentJob.branch.substring(0,18)} · ${s.currentJob.city}`
      : `${s.searchesPerHour}/uur · ${s.totalRuns} runs gedaan`;
  } else {
    dot.className = 'pulse-dot';
    label.textContent = 'Auto-pilot uit';
    meta.textContent = 'Klik switch om te starten';
  }
  toggle.checked = s.autopilotEnabled;
}

$('#apToggle').addEventListener('change', async (e) => {
  try {
    await api('/api/settings', { method: 'POST', body: { autopilot_enabled: e.target.checked ? '1' : '0' } });
    toast(e.target.checked ? '🤖 Auto-pilot aan' : '🛑 Auto-pilot uit');
    loadDashboard();
  } catch (err) { toast('Fout: ' + err.message, 'error'); }
});

// === LEAD CARD ===
function renderLeadCard(l) {
  const score = l.replacement_score;
  const sc = scoreClass(score);
  const issues = l.issues || [];
  const visible = issues.slice(0, 4);
  const hasScreenshot = l.screenshot_path;

  return `
    <div class="lead ${score >= 60 ? 'high-score' : ''} ${l.contacted ? 'contacted' : ''}" data-id="${l.id}">
      <div class="lead-row">
        <div class="score-circle ${sc}">${score === null ? '—' : score}</div>
        <div class="lead-thumb">
          ${hasScreenshot
            ? `<img src="${escapeHtml(l.screenshot_path)}" alt="" onerror="this.style.display='none';this.parentElement.textContent='—'">`
            : (l.website ? '—' : 'Geen site')}
        </div>
        <div class="lead-info">
          <h4>${escapeHtml(l.name)}</h4>
          <div class="meta">
            ${l.rating ? `★ ${l.rating}` : ''}${l.review_count ? ` (${l.review_count})` : ''}
            ${l.branch_name ? ` · ${escapeHtml(l.branch_name)}` : ''}
            ${l.city_name ? ` · ${escapeHtml(l.city_name)}` : ''}
          </div>
          ${l.website ? `<div class="website-line">→ ${escapeHtml(l.website)}</div>` : `<div class="website-line" style="color:var(--text-faint)">Geen website</div>`}
        </div>
        <div class="lead-issues">
          ${visible.map(i => `<span class="issue-tag">${escapeHtml(i)}</span>`).join('')}
          ${issues.length > visible.length ? `<span class="issue-tag warn">+${issues.length - visible.length}</span>` : ''}
        </div>
        <div class="lead-actions">
          <button class="tiny secondary" onclick="event.stopPropagation(); openLeadDetail(${l.id})">Open →</button>
        </div>
      </div>
    </div>
  `;
}

function attachLeadCardHandlers(scope) {
  scope.querySelectorAll('.lead').forEach(card => {
    card.addEventListener('click', () => openLeadDetail(parseInt(card.dataset.id)));
  });
}

// === LEADS LIST (HOGE SCORE - default ≥50) ===
async function loadLeads() {
  const params = new URLSearchParams();
  if (state.filterBranch) params.set('branch', state.filterBranch);
  if (state.filterCity) params.set('city', state.filterCity);

  // Score filter: default 50, of wat user kiest
  if (state.filter === '50') params.set('minScore', '50');
  else if (state.filter === '60') params.set('minScore', '60');
  else if (state.filter === '80') params.set('minScore', '80');
  else if (state.filter === 'uncontacted') {
    params.set('minScore', '50');
    params.set('contacted', 'false');
  }

  state.leads = await api(`/api/leads?${params}`);
  renderLeads();
  populateFilterDropdowns();
}

function populateFilterDropdowns() {
  const branchSet = new Set(state.leads.map(l => l.branch_name).filter(Boolean));
  const citySet = new Set(state.leads.map(l => l.city_name).filter(Boolean));
  const bSel = $('#filterBranch'), cSel = $('#filterCity');
  const cb = bSel.value, cc = cSel.value;
  bSel.innerHTML = '<option value="">Alle branches</option>' + [...branchSet].sort().map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  cSel.innerHTML = '<option value="">Alle steden</option>' + [...citySet].sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  bSel.value = cb; cSel.value = cc;
}

function renderLeads() {
  const grid = $('#leadsGrid');
  let leads = state.leads;
  if (state.filterText) {
    const q = state.filterText.toLowerCase();
    leads = leads.filter(l =>
      (l.name || '').toLowerCase().includes(q) ||
      (l.address || '').toLowerCase().includes(q) ||
      (l.issues || []).join(' ').toLowerCase().includes(q)
    );
  }
  if (leads.length === 0) {
    grid.innerHTML = `<div class="empty"><h3>geen leads</h3><p>Pas filters aan of wacht tot auto-pilot meer leads vindt</p></div>`;
    return;
  }
  grid.innerHTML = leads.map(renderLeadCard).join('');
  attachLeadCardHandlers(grid);
}

// Chips voor 'leads' view (score-based)
$$('#view-leads .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $$('#view-leads .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.filter = chip.dataset.filter;
    loadLeads();
  });
});
$('#filterText').addEventListener('input', e => { state.filterText = e.target.value; renderLeads(); });
$('#filterBranch').addEventListener('change', e => { state.filterBranch = e.target.value; loadLeads(); });
$('#filterCity').addEventListener('change', e => { state.filterCity = e.target.value; loadLeads(); });
$('#exportBtn').addEventListener('click', () => {
  const params = new URLSearchParams();
  if (state.filterBranch) params.set('branch', state.filterBranch);
  if (state.filterCity) params.set('city', state.filterCity);
  if (state.filter === '50') params.set('minScore', '50');
  if (state.filter === '60') params.set('minScore', '60');
  if (state.filter === '80') params.set('minScore', '80');
  if (state.filter === 'uncontacted') { params.set('minScore', '50'); params.set('contacted', 'false'); }
  window.location = `/api/export.csv?${params}`;
});

// === ALL LEADS (geen score filter) ===
async function loadAllLeads() {
  const params = new URLSearchParams();
  params.set('limit', '1000');
  if (state.filterBranchAll) params.set('branch', state.filterBranchAll);
  if (state.filterCityAll) params.set('city', state.filterCityAll);
  if (state.filterAll === 'uncontacted') params.set('contacted', 'false');
  state.allLeads = await api(`/api/leads?${params}`);
  // Client-side filter voor analyzed/unanalyzed
  if (state.filterAll === 'analyzed') {
    state.allLeads = state.allLeads.filter(l => l.analyzed);
  } else if (state.filterAll === 'unanalyzed') {
    state.allLeads = state.allLeads.filter(l => !l.analyzed);
  }
  renderAllLeads();
  populateAllLeadsFilterDropdowns();
}

function populateAllLeadsFilterDropdowns() {
  const branchSet = new Set(state.allLeads.map(l => l.branch_name).filter(Boolean));
  const citySet = new Set(state.allLeads.map(l => l.city_name).filter(Boolean));
  const bSel = $('#filterBranchAll'), cSel = $('#filterCityAll');
  if (!bSel || !cSel) return;
  const cb = bSel.value, cc = cSel.value;
  bSel.innerHTML = '<option value="">Alle branches</option>' + [...branchSet].sort().map(b => `<option value="${escapeHtml(b)}">${escapeHtml(b)}</option>`).join('');
  cSel.innerHTML = '<option value="">Alle steden</option>' + [...citySet].sort().map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
  bSel.value = cb; cSel.value = cc;
}

function renderAllLeads() {
  const grid = $('#allLeadsGrid');
  if (!grid) return;
  let leads = state.allLeads;
  if (state.filterTextAll) {
    const q = state.filterTextAll.toLowerCase();
    leads = leads.filter(l =>
      (l.name || '').toLowerCase().includes(q) ||
      (l.address || '').toLowerCase().includes(q) ||
      (l.issues || []).join(' ').toLowerCase().includes(q)
    );
  }
  if (leads.length === 0) {
    grid.innerHTML = `<div class="empty"><h3>Geen leads</h3><p>Pas filters aan of wacht tot auto-pilot meer leads vindt</p></div>`;
    return;
  }
  grid.innerHTML = `<p style="font-size:12px;color:var(--text-faint);margin-bottom:8px;">${leads.length} leads getoond</p>` + leads.map(renderLeadCard).join('');
  attachLeadCardHandlers(grid);
}

// Chips voor 'all-leads' view
$$('#view-all-leads .chip').forEach(chip => {
  chip.addEventListener('click', () => {
    $$('#view-all-leads .chip').forEach(c => c.classList.remove('active'));
    chip.classList.add('active');
    state.filterAll = chip.dataset.filterAll;
    loadAllLeads();
  });
});
const ftAll = $('#filterTextAll');
if (ftAll) ftAll.addEventListener('input', e => { state.filterTextAll = e.target.value; renderAllLeads(); });
const fbAll = $('#filterBranchAll');
if (fbAll) fbAll.addEventListener('change', e => { state.filterBranchAll = e.target.value; loadAllLeads(); });
const fcAll = $('#filterCityAll');
if (fcAll) fcAll.addEventListener('change', e => { state.filterCityAll = e.target.value; loadAllLeads(); });
const ebAll = $('#exportBtnAll');
if (ebAll) ebAll.addEventListener('click', () => {
  const params = new URLSearchParams();
  if (state.filterBranchAll) params.set('branch', state.filterBranchAll);
  if (state.filterCityAll) params.set('city', state.filterCityAll);
  window.location = `/api/export.csv?${params}`;
});

// === LEAD DETAIL ===
async function openLeadDetail(id) {
  try {
    const lead = await api(`/api/leads/${id}`);
    state.currentLead = lead;
    state.currentLeadTab = 'overview';

    const issues = lead.issues || [];
    const emails = lead.emails || [];
    const phone = lead.phone || '';
    const score = lead.replacement_score;

    $('#view-lead-detail').innerHTML = `
      <button class="ghost tiny" style="margin-bottom:14px;" onclick="switchView('leads')">← Terug naar leads</button>
      <div class="detail-header">
        <div class="score-circle ${scoreClass(score)}" style="width:60px;height:60px;font-size:18px;">${score === null ? '—' : score}</div>
        <div style="flex:1;">
          <h1>${escapeHtml(lead.name)}</h1>
          <div class="meta">
            ${lead.branch_name ? escapeHtml(lead.branch_name) : '—'}
            ${lead.city_name ? ' · ' + escapeHtml(lead.city_name) : ''}
            ${lead.rating ? ` · ★ ${lead.rating} (${lead.review_count || 0})` : ''}
            ${lead.stage && lead.stage !== 'new' ? ` · <span class="pill" style="background:var(--accent-glow); color:var(--accent);">${stageLabel(lead.stage)}</span>` : ''}
          </div>
        </div>
      </div>

      <div class="detail-actions">
        ${emails.length > 0 ? `<button onclick="openSendDialog(${lead.id}, 'email')">📧 Email versturen</button>` : `<button disabled title="Geen email">📧 Email versturen</button>`}
        ${phone ? `<button class="secondary" onclick="openSendDialog(${lead.id}, 'whatsapp')">💬 WhatsApp</button>` : ''}
        ${phone ? `<a href="tel:${escapeHtml(phone)}" style="text-decoration:none;"><button class="secondary">📞 Bel</button></a>` : ''}
        <button class="secondary" onclick="moveLeadToStage(${lead.id})">→ Naar funnel</button>
        ${lead.website ? `<button class="ghost" onclick="window.open('${escapeHtml(lead.website)}','_blank')">↗ Open website</button>` : ''}
        ${lead.google_maps_url ? `<button class="ghost" onclick="window.open('${escapeHtml(lead.google_maps_url)}','_blank')">↗ Google Maps</button>` : ''}
        <button class="ghost" onclick="reanalyzeLead(${lead.id})">↻ Opnieuw analyseren</button>
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="overview">Overzicht</div>
        <div class="tab" data-tab="analysis">Analyse</div>
        <div class="tab" data-tab="comms">Communicatie</div>
        <div class="tab" data-tab="notes">Notities</div>
      </div>

      <div class="tab-content active" id="tab-overview">
        <div class="detail-grid">
          <div class="detail-main">
            <h3>Website screenshot</h3>
            <div class="detail-screenshot">
              ${lead.screenshot_path
                ? `<img src="${escapeHtml(lead.screenshot_path)}" onerror="this.parentElement.innerHTML='Geen screenshot beschikbaar'">`
                : (lead.website ? `<div>Geen screenshot — <a href="#" onclick="reanalyzeLead(${lead.id});return false;" style="color:var(--accent);">analyseer opnieuw</a></div>` : 'Geen website')}
            </div>
          </div>
          <div>
            <h3>Bedrijfsgegevens</h3>
            <div class="info-rows">
              <div class="info-row"><div class="label">Naam</div><div class="value">${escapeHtml(lead.name)}</div></div>
              ${lead.address ? `<div class="info-row"><div class="label">Adres</div><div class="value copy" onclick="copyText('${escapeHtml(lead.address)}')">${escapeHtml(lead.address)}</div></div>` : ''}
              ${phone ? `<div class="info-row"><div class="label">Telefoon</div><div class="value copy" onclick="copyText('${escapeHtml(phone)}')">${escapeHtml(phone)}</div></div>` : ''}
              ${lead.website ? `<div class="info-row"><div class="label">Website</div><div class="value"><a href="${escapeHtml(lead.website)}" target="_blank">${escapeHtml(lead.website)}</a></div></div>` : ''}
              ${emails.length > 0 ? `<div class="info-row"><div class="label">Email</div><div class="value">${emails.map(e => `<div class="copy" onclick="copyText('${escapeHtml(e)}')" style="margin-bottom:4px;">${escapeHtml(e)}</div>`).join('')}</div></div>` : '<div class="info-row"><div class="label">Email</div><div class="value" style="color:var(--text-faint);">Geen gevonden</div></div>'}
            </div>
            ${issues.length > 0 ? `
              <h3 style="margin-top:20px;">Issues</h3>
              <div style="display:flex; flex-direction:column; gap:4px;">
                ${issues.map(i => `<span class="issue-tag" style="font-size:11px; padding:5px 10px;">${escapeHtml(i)}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        </div>
      </div>

      <div class="tab-content" id="tab-analysis">
        <div class="card-grid">
          <div class="card">
            <div class="card-title">Technische checks</div>
            <div class="check-item"><span class="icon ${lead.has_https ? 'yes' : 'no'}">${lead.has_https ? '✓' : '✗'}</span><span class="label">HTTPS / SSL</span></div>
            <div class="check-item"><span class="icon ${lead.is_mobile_friendly ? 'yes' : 'no'}">${lead.is_mobile_friendly ? '✓' : '✗'}</span><span class="label">Mobiel-vriendelijk</span></div>
            <div class="check-item"><span class="icon ${lead.has_cms ? 'yes' : 'no'}">${lead.has_cms ? '✓' : '✗'}</span><span class="label">CMS: ${escapeHtml(lead.cms_type || 'Geen')}</span></div>
            <div class="check-item"><span class="icon ${lead.has_open_graph ? 'yes' : 'no'}">${lead.has_open_graph ? '✓' : '✗'}</span><span class="label">Open Graph (social SEO)</span></div>
          </div>
          <div class="card">
            <div class="card-title">Performance</div>
            ${lead.pagespeed_score !== null ? `<div style="font-size:32px; font-weight:700; font-family:'JetBrains Mono', monospace;">${lead.pagespeed_score}<span style="font-size:14px; color:var(--text-faint);">/100</span></div><div style="font-size:11px; color:var(--text-faint); margin-top:4px;">PageSpeed score (mobile)</div>` : '<div style="color:var(--text-faint);">Geen PageSpeed score (zet API key in env)</div>'}
            ${lead.copyright_year ? `<div style="margin-top:14px; font-size:13px;">Copyright: <strong>${lead.copyright_year}</strong></div>` : ''}
          </div>
          ${(lead.tech_stack || []).length > 0 ? `
            <div class="card">
              <div class="card-title">Tech stack</div>
              <div style="display:flex; flex-wrap:wrap; gap:5px;">
                ${(lead.tech_stack || []).map(t => `<span class="issue-tag ${t.startsWith('OUTDATED:') ? '' : 'info'}">${escapeHtml(t.replace('OUTDATED:', '⚠ '))}</span>`).join('')}
              </div>
            </div>
          ` : ''}
        </div>
      </div>

      <div class="tab-content" id="tab-comms">
        <div id="commsList">${renderCommsList(lead.communications || [])}</div>
      </div>

      <div class="tab-content" id="tab-notes">
        <label class="field">Notities</label>
        <textarea id="leadNotes" rows="6" placeholder="Persoonlijke aantekeningen...">${escapeHtml(lead.notes || '')}</textarea>
        <button class="secondary" style="margin-top:10px;" onclick="saveLeadNotes(${lead.id})">Opslaan</button>
      </div>
    `;

    $$('#view-lead-detail .tab').forEach(t => {
      t.addEventListener('click', () => {
        $$('#view-lead-detail .tab').forEach(x => x.classList.remove('active'));
        t.classList.add('active');
        $$('#view-lead-detail .tab-content').forEach(c => c.classList.remove('active'));
        $(`#tab-${t.dataset.tab}`).classList.add('active');
      });
    });

    switchView('lead-detail', { leadName: lead.name });
  } catch (e) { toast('Kon lead niet laden: ' + e.message, 'error'); }
}

function stageLabel(stage) {
  return STAGES.find(s => s.id === stage)?.label || stage;
}

function renderCommsList(comms) {
  if (!comms || comms.length === 0) {
    return '<div class="empty"><p>Nog geen communicatie</p></div>';
  }
  return comms.map(c => `
    <div class="card" style="cursor:default;">
      <div class="card-title">
        <span class="pill ${c.type}">${c.type}</span>
        <span style="font-size:12px; color:var(--text-faint); margin-left:auto;">${timeAgo(c.sent_at)}</span>
      </div>
      ${c.subject ? `<div style="font-size:13px; font-weight:500; margin:8px 0 4px;">${escapeHtml(c.subject)}</div>` : ''}
      <div style="font-size:12px; color:var(--text-dim);">→ ${escapeHtml(c.recipient || '?')}</div>
      ${c.body ? `<div class="card-preview">${escapeHtml(c.body.substring(0, 200))}${c.body.length > 200 ? '...' : ''}</div>` : ''}
      ${c.error ? `<div style="color:var(--danger); font-size:11px; margin-top:6px;">⚠ ${escapeHtml(c.error)}</div>` : ''}
    </div>
  `).join('');
}

window.openLeadDetail = openLeadDetail;
window.copyText = (text) => {
  navigator.clipboard.writeText(text).then(() => toast('✓ Gekopieerd'));
};
window.reanalyzeLead = async (id) => {
  toast('Analyseren...');
  try {
    await api(`/api/leads/${id}/analyze`, { method: 'POST' });
    toast('✓ Klaar');
    openLeadDetail(id);
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
};
window.saveLeadNotes = async (id) => {
  const notes = $('#leadNotes').value;
  await api(`/api/leads/${id}`, { method: 'PATCH', body: { notes } });
  toast('✓ Opgeslagen');
};
window.moveLeadToStage = async (id) => {
  const stages = STAGES.filter(s => s.id !== 'new');
  const choice = prompt(`Naar welke stage?\n${stages.map((s, i) => `${i+1}. ${s.label}`).join('\n')}\n\nKies nummer:`);
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || !stages[idx]) return;
  await api(`/api/leads/${id}`, { method: 'PATCH', body: { stage: stages[idx].id } });
  toast(`✓ Naar ${stages[idx].label}`);
  openLeadDetail(id);
};

// === SEND DIALOG ===
async function openSendDialog(leadId, type) {
  const tmpls = state.templates.length ? state.templates : await api('/api/templates');
  state.templates = tmpls;
  const filtered = tmpls.filter(t => t.type === type && t.enabled);
  if (filtered.length === 0) {
    toast('Geen ' + type + ' templates beschikbaar', 'error');
    return;
  }
  const lead = state.currentLead;
  const recipient = type === 'email'
    ? (lead.emails || [])[0] || ''
    : lead.phone || '';

  const html = `
    <h2>${type === 'email' ? '📧 Email versturen' : '💬 WhatsApp versturen'}</h2>
    <p style="color:var(--text-dim); margin-bottom:16px;">Naar: <strong>${escapeHtml(recipient)}</strong></p>
    <label class="field">Template</label>
    <select id="sendTmplSel">
      ${filtered.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('')}
    </select>
    ${type === 'email' ? '<label class="field" style="margin-top:12px;">Onderwerp</label><input type="text" id="sendSubj">' : ''}
    <label class="field" style="margin-top:12px;">Bericht (preview)</label>
    <textarea id="sendBody" rows="10" class="code"></textarea>
    <div class="modal-actions">
      <button class="ghost" onclick="closeModal('templateModal')">Annuleren</button>
      ${type === 'whatsapp' && recipient ? `<button class="secondary" onclick="openWhatsAppLink(${leadId})">📱 wa.me link</button>` : ''}
      <button onclick="executeSend(${leadId}, '${type}')">Verstuur nu</button>
    </div>
  `;
  $('#templateModalContent').innerHTML = html;
  $('#templateModal').classList.add('active');

  const sel = $('#sendTmplSel');
  async function refresh() {
    const tmpl = filtered.find(t => t.id === parseInt(sel.value));
    const preview = await api(`/api/templates/${tmpl.id}/preview`, { method: 'POST', body: { lead_id: leadId } });
    if ($('#sendSubj')) $('#sendSubj').value = preview.subject || '';
    $('#sendBody').value = preview.body;
  }
  sel.addEventListener('change', refresh);
  refresh();
}

window.openSendDialog = openSendDialog;
window.closeModal = (id) => $('#' + id).classList.remove('active');
window.executeSend = async (leadId, type) => {
  const body = $('#sendBody').value;
  const tmplId = parseInt($('#sendTmplSel').value);
  const lead = state.currentLead;
  try {
    if (type === 'email') {
      const subject = $('#sendSubj').value;
      await api(`/api/leads/${leadId}/send-email`, {
        method: 'POST',
        body: { custom_subject: subject, custom_body: body, recipient: (lead.emails || [])[0] }
      });
    } else {
      await api(`/api/leads/${leadId}/send-whatsapp`, {
        method: 'POST',
        body: { custom_body: body, recipient: lead.phone }
      });
    }
    toast('✓ Verstuurd');
    closeModal('templateModal');
    openLeadDetail(leadId);
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
};
window.openWhatsAppLink = async (leadId) => {
  const body = $('#sendBody').value;
  const tmplId = $('#sendTmplSel').value;
  const r = await api(`/api/leads/${leadId}/whatsapp-link?template_id=${tmplId}&message=${encodeURIComponent(body)}`);
  window.open(r.link, '_blank');
};

// === FUNNEL (KANBAN) ===
async function loadFunnel() {
  try {
    const deals = await api('/api/deals');
    const grouped = {};
    for (const s of FUNNEL_STAGES) grouped[s.id] = [];
    for (const d of deals) {
      if (grouped[d.stage]) grouped[d.stage].push(d);
    }
    $('#funnelKanban').innerHTML = FUNNEL_STAGES.map(stage => `
      <div class="kanban-col">
        <div class="kanban-col-header">
          <div class="name">${stage.label}</div>
          <div class="count">${grouped[stage.id].length}</div>
        </div>
        <div class="kanban-cards">
          ${grouped[stage.id].map(d => `
            <div class="kanban-card" onclick="openLeadDetail(${d.id})">
              <div class="name">${escapeHtml(d.name)}</div>
              <div class="meta">
                <span class="score-mini ${scoreClass(d.replacement_score)}">${d.replacement_score === null ? '—' : d.replacement_score}</span>
                ${d.city_name ? escapeHtml(d.city_name) : ''}
              </div>
            </div>
          `).join('') || '<div style="font-size:12px; color:var(--text-faint); text-align:center; padding:20px;">Leeg</div>'}
        </div>
      </div>
    `).join('');
  } catch (e) { console.error(e); }
}

// === PENDING ===
async function loadPending() {
  const actions = await api('/api/pending');
  const list = $('#pendingList');
  if (actions.length === 0) {
    list.innerHTML = '<div class="empty"><h3>Niets te bevestigen</h3><p>Alle acties zijn afgehandeld of er zijn geen actieve sequences</p></div>';
    return;
  }
  list.innerHTML = actions.map(a => `
    <div class="pending-card">
      <div class="header">
        <div>
          <div style="font-weight:600;">${escapeHtml(a.lead_name)}</div>
          <div style="font-size:11px; color:var(--text-faint);">
            <span class="pill ${a.type}">${a.type}</span> →
            ${escapeHtml(a.recipient || 'geen ontvanger')} · score: ${a.replacement_score || '—'}
          </div>
        </div>
        <button class="ghost tiny" onclick="openLeadDetail(${a.lead_id})">Open lead →</button>
      </div>
      ${a.rendered_subject ? `<div style="font-size:13px; font-weight:500; margin-bottom:6px;">${escapeHtml(a.rendered_subject)}</div>` : ''}
      <div class="preview">${escapeHtml(a.rendered_body || '').substring(0, 400)}${(a.rendered_body || '').length > 400 ? '...' : ''}</div>
      <div class="actions">
        <button onclick="approvePending(${a.id})">✓ Verstuur</button>
        <button class="secondary" onclick="skipPending(${a.id})">Skip stap</button>
        <button class="ghost" onclick="cancelPending(${a.id})">Annuleer</button>
      </div>
    </div>
  `).join('');
}
window.approvePending = async (id) => {
  try {
    await api(`/api/pending/${id}/approve`, { method: 'POST' });
    toast('✓ Verstuurd');
    loadPending();
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
};
window.skipPending = async (id) => {
  await api(`/api/pending/${id}/skip`, { method: 'POST' });
  toast('Stap overgeslagen');
  loadPending();
};
window.cancelPending = async (id) => {
  await api(`/api/pending/${id}`, { method: 'DELETE' });
  loadPending();
};

// === BRANCHES ===
async function loadBranches() {
  state.branches = await api('/api/branches');
  $('#branchesList').innerHTML = state.branches.map(b => `
    <div class="list-item ${b.enabled ? '' : 'disabled'}">
      <label class="toggle-switch"><input type="checkbox" ${b.enabled ? 'checked' : ''} onchange="toggleBranch(${b.id}, this.checked)"><span class="slider"></span></label>
      <span class="name">${escapeHtml(b.name)}</span>
      <button class="tiny ghost" onclick="deleteBranch(${b.id})">×</button>
    </div>
  `).join('');
}
window.toggleBranch = async (id, e) => { await api(`/api/branches/${id}`, { method: 'PATCH', body: { enabled: e } }); };
window.deleteBranch = async (id) => {
  if (!confirm('Verwijderen?')) return;
  await api(`/api/branches/${id}`, { method: 'DELETE' });
  loadBranches();
};
$('#addBranchBtn').addEventListener('click', async () => {
  const name = $('#newBranchInput').value.trim();
  if (!name) return;
  try {
    await api('/api/branches', { method: 'POST', body: { name } });
    $('#newBranchInput').value = '';
    toast('✓ Toegevoegd');
    loadBranches();
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
});
$('#newBranchInput').addEventListener('keypress', e => { if (e.key === 'Enter') $('#addBranchBtn').click(); });

// === CITIES ===
async function loadCities() {
  state.cities = await api('/api/cities');
  $('#citiesList').innerHTML = state.cities.map(c => `
    <div class="list-item ${c.enabled ? '' : 'disabled'}">
      <label class="toggle-switch"><input type="checkbox" ${c.enabled ? 'checked' : ''} onchange="toggleCity(${c.id}, this.checked)"><span class="slider"></span></label>
      <span class="name">${escapeHtml(c.name)}</span>
      <button class="tiny ghost" onclick="deleteCity(${c.id})">×</button>
    </div>
  `).join('');
}
window.toggleCity = async (id, e) => { await api(`/api/cities/${id}`, { method: 'PATCH', body: { enabled: e } }); };
window.deleteCity = async (id) => {
  if (!confirm('Verwijderen?')) return;
  await api(`/api/cities/${id}`, { method: 'DELETE' });
  loadCities();
};
$('#addCityBtn').addEventListener('click', async () => {
  const name = $('#newCityInput').value.trim();
  if (!name) return;
  try {
    await api('/api/cities', { method: 'POST', body: { name } });
    $('#newCityInput').value = '';
    toast('✓ Toegevoegd');
    loadCities();
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
});
$('#newCityInput').addEventListener('keypress', e => { if (e.key === 'Enter') $('#addCityBtn').click(); });

// === TEMPLATES ===
async function loadTemplatesList() {
  state.templates = await api('/api/templates');
  $('#templatesList').innerHTML = state.templates.map(t => `
    <div class="card" onclick="editTemplate(${t.id})">
      <div class="card-title">
        <span class="pill ${t.type}">${t.type}</span>
        ${escapeHtml(t.name)}
      </div>
      ${t.subject ? `<div class="card-meta">📧 ${escapeHtml(t.subject)}</div>` : ''}
      <div class="card-preview">${escapeHtml((t.body || '').substring(0, 200))}${(t.body || '').length > 200 ? '...' : ''}</div>
    </div>
  `).join('');
}

$('#newTemplateBtn').addEventListener('click', () => editTemplate(null));

async function editTemplate(id) {
  const tmpl = id ? await api(`/api/templates/${id}`) : { name: '', type: 'email', subject: '', body: '', enabled: 1 };
  const vars = await api('/api/template-vars');
  $('#templateModalContent').innerHTML = `
    <h2>${id ? 'Template bewerken' : 'Nieuwe template'}</h2>
    <label class="field">Naam</label>
    <input type="text" id="tmplName" value="${escapeHtml(tmpl.name)}">
    <label class="field" style="margin-top:12px;">Type</label>
    <select id="tmplType">
      <option value="email" ${tmpl.type === 'email' ? 'selected' : ''}>Email</option>
      <option value="whatsapp" ${tmpl.type === 'whatsapp' ? 'selected' : ''}>WhatsApp</option>
    </select>
    <div id="subjectWrap" ${tmpl.type !== 'email' ? 'class="hide"' : ''}>
      <label class="field" style="margin-top:12px;">Onderwerp</label>
      <input type="text" id="tmplSubject" value="${escapeHtml(tmpl.subject || '')}">
    </div>
    <label class="field" style="margin-top:12px;">Body</label>
    <textarea id="tmplBody" rows="10" class="code">${escapeHtml(tmpl.body)}</textarea>
    <div style="margin-top:8px; font-size:11px; color:var(--text-faint);">
      <strong>Variabelen:</strong> ${vars.map(v => `<code style="background:var(--bg-elev-2); padding:1px 5px; border-radius:3px; cursor:pointer;" onclick="insertVar('${v}')">{{${v}}}</code>`).join(' ')}
    </div>
    <div class="modal-actions">
      ${id ? `<button class="danger" onclick="deleteTemplate(${id})">Verwijderen</button>` : ''}
      <button class="ghost" onclick="closeModal('templateModal')">Annuleren</button>
      <button onclick="saveTemplate(${id || 'null'})">${id ? 'Opslaan' : 'Aanmaken'}</button>
    </div>
  `;
  $('#tmplType').addEventListener('change', e => {
    $('#subjectWrap').classList.toggle('hide', e.target.value !== 'email');
  });
  $('#templateModal').classList.add('active');
}
window.editTemplate = editTemplate;
window.insertVar = (v) => {
  const ta = $('#tmplBody');
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const txt = `{{${v}}}`;
  ta.value = ta.value.substring(0, start) + txt + ta.value.substring(end);
  ta.focus();
};
window.saveTemplate = async (id) => {
  const data = {
    name: $('#tmplName').value,
    type: $('#tmplType').value,
    subject: $('#tmplType').value === 'email' ? $('#tmplSubject').value : null,
    body: $('#tmplBody').value,
    enabled: true,
  };
  try {
    if (id) await api(`/api/templates/${id}`, { method: 'PATCH', body: data });
    else await api('/api/templates', { method: 'POST', body: data });
    toast('✓ Opgeslagen');
    closeModal('templateModal');
    loadTemplatesList();
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
};
window.deleteTemplate = async (id) => {
  if (!confirm('Template verwijderen?')) return;
  await api(`/api/templates/${id}`, { method: 'DELETE' });
  closeModal('templateModal');
  loadTemplatesList();
};

// === SEQUENCES ===
async function loadSequencesList() {
  state.sequences = await api('/api/sequences');
  $('#sequencesList').innerHTML = state.sequences.map(s => `
    <div class="card" onclick="editSequence(${s.id})">
      <div class="card-title">
        ${s.enabled ? '⚡' : '⏸'} ${escapeHtml(s.name)}
      </div>
      <div class="card-meta">
        Trigger bij stage: <strong>${escapeHtml(s.trigger_stage)}</strong> · ${s.steps.length} stappen
      </div>
      ${s.description ? `<div class="card-preview">${escapeHtml(s.description)}</div>` : ''}
    </div>
  `).join('');
}
$('#newSequenceBtn').addEventListener('click', () => editSequence(null));

async function editSequence(id) {
  if (state.templates.length === 0) state.templates = await api('/api/templates');
  const seq = id ? state.sequences.find(s => s.id === id) || (await api('/api/sequences')).find(s => s.id === id) : { name: '', description: '', trigger_stage: 'contacted', enabled: 1, steps: [] };

  function renderStepsEditor(steps) {
    return steps.map((st, i) => `
      <div class="seq-step">
        <div class="seq-step-num">${i + 1}</div>
        <div class="info" style="flex:1; display:grid; grid-template-columns: 1fr 100px 110px 30px; gap:8px; align-items:center;">
          <select class="step-tmpl">
            ${state.templates.map(t => `<option value="${t.id}" ${st.template_id === t.id ? 'selected' : ''}>${escapeHtml(t.name)} (${t.type})</option>`).join('')}
          </select>
          <input type="number" class="step-delay" value="${st.delay_days || 0}" min="0" placeholder="Dagen">
          <label class="checkbox-label" style="font-size:11px; color:var(--text-dim); display:flex; align-items:center; gap:6px;">
            <input type="checkbox" class="step-approve" ${st.require_approval ? 'checked' : ''}> bevestig
          </label>
          <button class="ghost tiny" onclick="this.closest('.seq-step').remove()">×</button>
        </div>
      </div>
    `).join('');
  }

  $('#sequenceModalContent').innerHTML = `
    <h2>${id ? 'Sequence bewerken' : 'Nieuwe sequence'}</h2>
    <label class="field">Naam</label>
    <input type="text" id="seqName" value="${escapeHtml(seq.name)}">
    <label class="field" style="margin-top:12px;">Omschrijving</label>
    <input type="text" id="seqDesc" value="${escapeHtml(seq.description || '')}">
    <label class="field" style="margin-top:12px;">Trigger bij stage</label>
    <select id="seqTrigger">
      ${STAGES.map(s => `<option value="${s.id}" ${seq.trigger_stage === s.id ? 'selected' : ''}>${s.label}</option>`).join('')}
    </select>
    <h3 style="margin-top:20px; margin-bottom:8px;">Stappen</h3>
    <div class="seq-steps" id="seqStepsEditor">${renderStepsEditor(seq.steps || [])}</div>
    <button class="secondary" style="margin-top:8px;" onclick="addSeqStep()">+ Stap toevoegen</button>
    <div class="modal-actions">
      ${id ? `<button class="danger" onclick="deleteSequence(${id})">Verwijderen</button>` : ''}
      <button class="ghost" onclick="closeModal('sequenceModal')">Annuleren</button>
      <button onclick="saveSequence(${id || 'null'})">${id ? 'Opslaan' : 'Aanmaken'}</button>
    </div>
  `;
  $('#sequenceModal').classList.add('active');
}
window.editSequence = editSequence;
window.addSeqStep = () => {
  const wrap = $('#seqStepsEditor');
  const num = wrap.querySelectorAll('.seq-step').length + 1;
  const div = document.createElement('div');
  div.className = 'seq-step';
  div.innerHTML = `
    <div class="seq-step-num">${num}</div>
    <div class="info" style="flex:1; display:grid; grid-template-columns: 1fr 100px 110px 30px; gap:8px; align-items:center;">
      <select class="step-tmpl">
        ${state.templates.map(t => `<option value="${t.id}">${escapeHtml(t.name)} (${t.type})</option>`).join('')}
      </select>
      <input type="number" class="step-delay" value="0" min="0" placeholder="Dagen">
      <label class="checkbox-label" style="font-size:11px; color:var(--text-dim); display:flex; align-items:center; gap:6px;">
        <input type="checkbox" class="step-approve" checked> bevestig
      </label>
      <button class="ghost tiny" onclick="this.closest('.seq-step').remove()">×</button>
    </div>
  `;
  wrap.appendChild(div);
};
window.saveSequence = async (id) => {
  const steps = $$('#seqStepsEditor .seq-step').map(el => ({
    template_id: parseInt(el.querySelector('.step-tmpl').value),
    delay_days: parseInt(el.querySelector('.step-delay').value) || 0,
    require_approval: el.querySelector('.step-approve').checked,
  }));
  const data = {
    name: $('#seqName').value,
    description: $('#seqDesc').value,
    trigger_stage: $('#seqTrigger').value,
    enabled: true,
    steps,
  };
  try {
    if (id) await api(`/api/sequences/${id}`, { method: 'PATCH', body: data });
    else await api('/api/sequences', { method: 'POST', body: data });
    toast('✓ Opgeslagen');
    closeModal('sequenceModal');
    loadSequencesList();
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
};
window.deleteSequence = async (id) => {
  if (!confirm('Verwijderen?')) return;
  await api(`/api/sequences/${id}`, { method: 'DELETE' });
  closeModal('sequenceModal');
  loadSequencesList();
};

// === PROJECTS ===
async function loadProjects() {
  const projects = await api('/api/projects');
  if (projects.length === 0) {
    $('#projectsList').innerHTML = '<div class="empty"><h3>Geen projecten</h3><p>Wanneer een lead is getekend wordt hier automatisch een project aangemaakt</p></div>';
    return;
  }
  $('#projectsList').innerHTML = projects.map(p => `
    <div class="card">
      <div class="card-title">${escapeHtml(p.name)}</div>
      <div class="card-meta">${escapeHtml(p.status)} · ${timeAgo(p.created_at)}</div>
      ${p.lead_name ? `<div class="card-meta">Lead: ${escapeHtml(p.lead_name)}</div>` : ''}
      ${p.notes ? `<div class="card-preview">${escapeHtml(p.notes)}</div>` : ''}
    </div>
  `).join('');
}

// === SETTINGS ===
async function loadSettings() {
  state.settings = await api('/api/settings');
  $('#setAutopilot').checked = state.settings.autopilot_enabled === '1';
  $('#setSpeed').value = state.settings.searches_per_hour || '3';
  $('#setMaxResults').value = state.settings.max_results_per_search || '20';
  $('#setRepeat').value = state.settings.repeat_interval_days || '14';
  $('#setNight').checked = state.settings.night_mode === '1';
  $('#setAutoFunnel').checked = state.settings.auto_add_high_score_to_funnel === '1';
  $('#setThreshold').value = state.settings.high_score_threshold || '70';
  $('#setSenderName').value = state.settings.sender_name || '';
  $('#setSenderEmail').value = state.settings.sender_email || '';
  $('#setReplyTo').value = state.settings.reply_to || '';
  $('#setCompanyName').value = state.settings.company_name || '';
  $('#setSignature').value = state.settings.signature || '';
}

$('#saveSettingsBtn').addEventListener('click', async () => {
  try {
    await api('/api/settings', {
      method: 'POST',
      body: {
        autopilot_enabled: $('#setAutopilot').checked ? '1' : '0',
        searches_per_hour: $('#setSpeed').value,
        max_results_per_search: $('#setMaxResults').value,
        repeat_interval_days: $('#setRepeat').value,
        night_mode: $('#setNight').checked ? '1' : '0',
        auto_add_high_score_to_funnel: $('#setAutoFunnel').checked ? '1' : '0',
        high_score_threshold: $('#setThreshold').value,
        sender_name: $('#setSenderName').value,
        sender_email: $('#setSenderEmail').value,
        reply_to: $('#setReplyTo').value,
        company_name: $('#setCompanyName').value,
        signature: $('#setSignature').value,
      },
    });
    toast('✓ Opgeslagen');
    loadDashboard();
  } catch (e) { toast('Fout: ' + e.message, 'error'); }
});

// === MODAL CLOSE ON BACKDROP ===
$$('.modal-backdrop').forEach(b => {
  b.addEventListener('click', e => { if (e.target === b) b.classList.remove('active'); });
});

// === USER / LOGOUT ===
async function loadUser() {
  try {
    const me = await api('/api/me');
    if (me.username) {
      const initial = me.username.charAt(0).toUpperCase();
      const ua = $('#userAvatar');
      const un = $('#userName');
      if (ua) ua.textContent = initial;
      if (un) un.textContent = me.username;
    }
  } catch (e) {
    // Niet ingelogd, redirect (server doet dit normaal al)
    window.location = '/login.html';
  }
}

window.logout = async () => {
  if (!confirm('Uitloggen?')) return;
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  window.location = '/login.html';
};

// === INIT ===
loadUser();
loadDashboard();
setInterval(() => {
  if (state.view === 'dashboard') loadDashboard();
  if (state.view === 'pending') loadPending();
}, 15000);
