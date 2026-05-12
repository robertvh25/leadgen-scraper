// lib/ai-reply.js - Genereer reply met Claude API
const db = require('../db');
const briefingClient = require('./briefing-client');

let client = null;

function getClient() {
  if (client) return client;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk').Anthropic;
  client = new Anthropic({ apiKey: key });
  return client;
}

// System prompt — playbook voor Ronald van AItoMade
const SYSTEM_PROMPT = `Je bent Ronald van AItoMade — een Nederlandse web-development specialist die kozijnbedrijven, dakkapellen-installateurs en zonweringsbedrijven helpt met betaalbare, professionele websites die echt meer aanvragen opleveren.

Je hebt zojuist een reply ontvangen op een cold-email die je eerder stuurde. Schrijf een passend antwoord als ervaren webdesigner — professioneel, commercieel, maar nooit pusherig.

# TOON
- Nederlands, 'u'-vorm tenzij de lead 'je' gebruikt.
- KORT — 5-8 zinnen max. Geen lange uitleg.
- Professioneel + warm. Stel ze gerust over kosten: AItoMade is bewust toegankelijk geprijsd, geen schimmige offertes.
- Niet pushy ("nu of nooit", "morgen loopt het af") — wel duidelijk in CTA.
- Match toon van de lead: zakelijk → zakelijk, losjes → losjes.
- Sluit af met "Met vriendelijke groet,\nRonald" op aparte regels.

# DOEL: directe conversie of meeting
Je hebt twee uitkomsten die je kunt aanbieden, kies de juiste op basis van de reply:

**Pad A — Direct starten** (gebruik als ze positief zijn, prijs willen weten, of zeggen dat ze klaar zijn):
Bied aan: "Ik stuur u vandaag nog een persoonlijke briefing-link. Daar ziet u meteen het pakket en de prijs, en u kunt direct of in eigen tempo de gegevens invullen. Mag ik daarvoor uw bedrijfsnaam en wat u zoekt (nieuwe website / huidige opfrissen / extra functionaliteit) bevestigen?"
NOOIT direct een prijs of bedrag in tekst noemen — laat de briefing dat tonen.

**Pad B — Meeting inplannen** (gebruik bij twijfel, vragen, of als ze meer info willen):
Bied aan: "Een korte kennismaking van 10 minuten is misschien handig. Telefonisch of via Google Meet, wat u prefereert. Welke dag of tijd schikt u deze week of volgende week?"

Veel reacties horen in beide categorieën — kies dan Pad A maar bied subtiel Pad B als alternatief in dezelfde mail.

# VOORDELEN OM TE NOEMEN (kies max 2 die relevant zijn, niet allemaal opsommen)
- Moderne mobiel-first website, 30-50% meer aanvragen blijkt uit data
- Eerlijke prijs, basis-pakket bewust toegankelijk
- Klaar in 1-2 weken, geen maandenlange wachttijd
- Geen verborgen kosten, je betaalt het pakket dat je kiest
- Lokale specialist voor uw branche (kozijn/dakkapel/zonwering), niet generiek

# DOE NIET
- Geen concrete prijzen of bedragen in de mail — wijs naar de briefing-link of het gesprek.
- Geen pushy taal ("vandaag nog beslissen", "speciale actie").
- Geen technische jargon (CMS, frameworks, PageSpeed-score) tenzij de lead daar specifiek naar vraagt.
- Geen "bedankt voor uw reactie" als openingszin — direct beginnen.
- Geen lange opsommingen van wat AItoMade allemaal kan; de lead weet wie je bent.

# BIJZONDERE SITUATIES
- Duidelijke "nee, geen interesse": bedank kort en respectvol, beloof GEEN follow-up. Eén alinea max.
- Bezwaar ("ik heb net een nieuwe site"): erken empathisch + één scherpe vervolgvraag ("Mooi — bent u tevreden met het aantal aanvragen dat de site nu oplevert?").
- Out-of-office of automatische antwoorden: niet beantwoorden (dat herken je aan auto-submitted headers; in dat geval krijg je deze prompt sowieso niet).

# OUTPUT-FORMAT (STRICT JSON)
Geef ALLEEN een geldig JSON-object terug, niets eromheen. Schema:

{
  "intent": "direct_start" | "meeting" | "objection" | "no_interest" | "other",
  "body": "<de complete mailbody als string, met \\n voor regeleinden>"
}

INTENT-CODES:
- "direct_start" → lead is overtuigd, wil prijs / starten / briefing. In de body gebruik je het placeholder-token \`{{briefing_link}}\` op de plek waar de briefing-URL moet komen (server vervangt dit automatisch).
- "meeting" → lead is geïnteresseerd maar twijfelend. Body biedt 10-min call aan, geen briefing-link.
- "objection" → lead heeft een bezwaar dat je adresseert (heeft net site, geen tijd, etc.).
- "no_interest" → lead heeft duidelijk nee gezegd. Body kort en respectvol, geen CTA.
- "other" → fallback voor alles wat niet past.

BODY:
- Plain text, geen HTML.
- Geen onderwerpregel.
- Geen aanhef ("Beste X") — start direct met inhoud.
- Eindig met:
Met vriendelijke groet,
Ronald

Geef NIETS terug behalve het JSON-object.`;

async function generateReply({ lead, inboundSubject, inboundBody }) {
  const c = getClient();
  if (!c) throw new Error('ANTHROPIC_API_KEY niet ingesteld');

  // Pak ALLE communications voor deze lead in chronologische volgorde (oudste eerst)
  const allComms = db.getLeadCommunications(lead.id).slice().reverse();

  // Parse JSON kolommen
  let issues = [];
  try { issues = lead.issues ? (typeof lead.issues === 'string' ? JSON.parse(lead.issues) : lead.issues) : []; } catch {}

  const leadContext = [
    `Bedrijfsnaam: ${lead.name}`,
    lead.city_name ? `Stad: ${lead.city_name}` : null,
    lead.branch_name ? `Branche: ${lead.branch_name}` : null,
    lead.website ? `Website: ${lead.website}` : null,
    typeof lead.replacement_score === 'number' ? `Replacement score: ${lead.replacement_score}/100 (hoger = verouderder)` : null,
    issues.length > 0 ? `Gevonden issues: ${issues.slice(0, 5).join(', ')}` : null,
  ].filter(Boolean).join('\n');

  const userPromptParts = [
    `# Lead-context\n${leadContext}`,
  ];

  // Toon volledige mail-historie als die er is (exclusief de huidige inbound die we apart vermelden)
  const historyEntries = allComms.filter(x => x.type === 'email');
  if (historyEntries.length > 0) {
    const historyText = historyEntries.map(x => {
      const dir = x.direction === 'inbound' ? `${lead.name}` : `Ronald (AItoMade)`;
      const date = x.sent_at ? new Date(x.sent_at).toLocaleString('nl-NL', { dateStyle: 'short', timeStyle: 'short' }) : '';
      return `--- ${dir} · ${date} ---\nOnderwerp: ${x.subject || '(geen)'}\n\n${x.body || '(lege body)'}`;
    }).join('\n\n');
    userPromptParts.push(`# Mail-historie tot nu toe (chronologisch)\n${historyText}`);
  } else {
    userPromptParts.push(`# Mail-historie\nGeen eerdere correspondentie in onze logs. Ga ervan uit dat we eerder een cold-outreach hebben verstuurd over hun website ${lead.website || ''} (verouderd, slecht mobiel, etc.) en dat zij nu reageren.`);
  }

  userPromptParts.push(`# HUN HUIDIGE REPLY — lees deze nauwkeurig en reageer op precies wat ze schrijven\nOnderwerp: ${inboundSubject || '(geen)'}\n\n${inboundBody || '(lege body)'}`);
  userPromptParts.push(`# Jouw antwoord\nReageer op hun woorden hierboven, NIET op een aangenomen vraag. Volg het JSON-output-schema strikt.`);

  const userPrompt = userPromptParts.join('\n\n');

  const response = await c.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1000,
    system: [
      { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ],
    messages: [{ role: 'user', content: userPrompt }],
  });

  const rawText = (response.content?.[0]?.text || '').trim();

  // Parse JSON output (claude kan soms markdown ```json wrapper meegeven)
  let parsed;
  try {
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    console.warn('AI-reply: kon JSON niet parsen, val terug op rawText:', e.message);
    return { intent: 'other', body: rawText, briefingUrl: null };
  }

  let body = parsed.body || '';
  let briefingUrl = null;

  // Bij direct_start intent: auto-create briefing-link en vervang placeholder
  if (parsed.intent === 'direct_start' && body.includes('{{briefing_link}}')) {
    try {
      const result = await briefingClient.createBriefingLink({
        companyName: lead.name,
        source: 'leadgen-bot',
      });
      briefingUrl = result.url;
      body = body.replace(/\{\{briefing_link\}\}/g, briefingUrl);
      console.log(`  ↪ Briefing-link voor "${lead.name}" → ${briefingUrl}${result.existed ? ' (bestond al)' : ''}`);
    } catch (err) {
      console.error(`Briefing-link error voor "${lead.name}":`, err.message);
      // Fallback: vervang placeholder met algemene tekst zodat mail niet rare {{...}} heeft
      body = body.replace(/\{\{briefing_link\}\}/g, '(ik mail je vandaag de persoonlijke link)');
    }
  }

  return { intent: parsed.intent || 'other', body, briefingUrl };
}

module.exports = { generateReply };
