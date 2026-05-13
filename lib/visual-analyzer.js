// lib/visual-analyzer.js — beoordeel screenshot op visuele "ouderwetsheid"
// via Claude (multimodal). Returns { score: 0..100, issues: [...] } of null
// als ANTHROPIC_API_KEY niet gezet is of de call mislukt.
const fs = require('fs');
const path = require('path');

let client = null;
function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk').Anthropic;
  client = new Anthropic({ apiKey: key });
  return client;
}

const SYSTEM_PROMPT = `Je beoordeelt de visuele kwaliteit van een bedrijfswebsite-screenshot voor een lead-gen tool. Doel: hoe ouderwets / amateuristisch ziet het design eruit. Een hoge score = grote kans dat de eigenaar baat heeft bij een nieuwe website.

Score-schaal (0-100):
- 0-20: modern, professioneel, hoge productiekwaliteit (2023+ design-taal: ruimte, sterke typografie, duidelijke hiërarchie)
- 21-40: degelijk maar generiek; recent template-werk
- 41-60: gedateerd (~2015-2018); zichtbaar verouderde UX-conventies
- 61-80: duidelijk ouderwets; jaren-2010 amateur of corporate-old; slechte typografie, kleurgebruik, hierarchie
- 81-100: jaren-90/2000 stijl; Comic Sans, table-layout, geblokkeerde knoppen, drukke achtergrond, slechte beeldkwaliteit, knipperende elementen

Geef 2-4 concrete visuele issues in Nederlands, kort (max 6 woorden per issue). Voorbeelden van valide issues:
- "Comic Sans typografie"
- "Kleurschema jaren 2000"
- "Geen visuele hierarchie"
- "Slechte beeldkwaliteit"
- "Table-based layout zichtbaar"
- "Drukke achtergrond patroon"
- "Zware drop-shadows op buttons"
- "Te kleine letters / dichte tekst"
- "Lage-kwaliteit stockfoto's"
- "Geen witruimte tussen secties"

Output STRIKT alleen geldig JSON, niets eromheen, geen markdown:
{"score": <int 0..100>, "issues": ["...", "..."]}`;

async function analyzeVisualDesign(screenshotAbsPath) {
  const c = getClient();
  if (!c) return null;

  let imageBuffer;
  try {
    imageBuffer = fs.readFileSync(screenshotAbsPath);
  } catch (e) {
    return null;
  }
  const ext = (path.extname(screenshotAbsPath) || '.jpg').toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  const base64 = imageBuffer.toString('base64');

  try {
    const response = await c.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 300,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          { type: 'text', text: 'Beoordeel deze website-screenshot volgens het schema. Alleen JSON.' },
        ],
      }],
    });
    const raw = (response.content?.[0]?.text || '').trim();
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    const parsed = JSON.parse(cleaned);
    const score = Math.max(0, Math.min(100, parseInt(parsed.score)));
    if (!Number.isFinite(score)) return null;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter(i => typeof i === 'string' && i.length > 0).slice(0, 4)
      : [];
    return { score, issues };
  } catch (err) {
    console.warn('visual-analyzer: call faalde:', err.message);
    return null;
  }
}

// Helper: resolve een DB-screenshot_path (bv "/screenshots/123.jpg") naar abs pad
function resolveScreenshotPath(dbPath, screenshotDir) {
  if (!dbPath) return null;
  const filename = path.basename(dbPath);
  return path.join(screenshotDir, filename);
}

module.exports = { analyzeVisualDesign, resolveScreenshotPath };
