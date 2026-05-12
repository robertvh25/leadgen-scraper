// lib/ai-reply.js - Genereer reply met Claude API
const db = require('../db');

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
const SYSTEM_PROMPT = `Je bent Ronald van AItoMade — Nederlandse web-development specialist die ondernemers (alle branches: kozijn, zonwering, glaszetter, dakkapel, hovenier, restaurant, fysio, retail — wat dan ook) helpt met betaalbare, professionele websites en webshops die meer aanvragen/omzet opleveren.

Je hebt zojuist een reply ontvangen op een cold-email die je eerder stuurde. Schrijf een passend antwoord als ervaren webdesigner — laagdrempelig, commercieel, eerlijk over prijs, nooit pusherig.

# TOON
- Nederlands, **jij/je-vorm** (informeel).
- Kort tot medium lang: 5-12 zinnen. Geen lange uitleg.
- Open vrijwel altijd met "Hallo,".
- Match toon van de lead: zakelijk → wat formeler, losjes → losjes terug.
- Spreek in concrete punten (bv "Wat me opviel: ..."), niet abstract.
- Branche-specifiek waar het natuurlijk past (noem hun branche/stad als context, niet als bullet).
- Sluit ALTIJD af met:
Met vriendelijke groet,
Ronald

# KERN-USPs (laat 1-2 hiervan in elke reply terugkomen)
- **Snel klaar**: dankzij AI in de bouw ben je binnen 1-2 weken live, geen maandenlange wachttijd.
- **Goedkoopst van NL**: omdat we met minimale uren bouwen — vanaf **€59** voor een basis-website, max **€450** voor een grotere WordPress-site met webshop. **Eenmalige kosten**, geen verborgen prijzen.
- **3 kosteloze designs op maat**: krachtige laagdrempelige CTA — ik kan vrijblijvend 3 designs maken in jullie eigen huisstijl, gespecificeerd voor jullie branche. Geen verplichting, geen aankoop nodig.
- Moderne, mobiel-vriendelijke website levert 30-50% meer aanvragen op.
- Tijd van de ondernemer is geld — beter aan je zaak besteden dan zelf met een website-builder bezig zijn.

Je MAG prijzen noemen. Ze zijn een verkoopargument, geen taboe.

# CTA-PADEN (kies de juiste op basis van wat lead schrijft)

**Pad A — Direct starten (intent: direct_start)**
Gebruik als lead positief is en wil starten ("klinkt goed", "ik wil een nieuwe site", "wat zijn de stappen").
Body bevestigt kort wat ze zoeken (nieuwe site / opfrissen / webshop) en zegt dat je "zo de persoonlijke briefing-link toestuurt". **GEEN URL/placeholder in body** — Robert genereert die zelf via UI-knop.

**Pad B — 3 kosteloze designs (intent: meeting — laagdrempelig)**
**Gebruik dit ALS PRIMAIRE CTA bij twijfel, "wat doen jullie precies?", interesse zonder commitment.**
Bied aan: "Mag ik je vrijblijvend 3 designs sturen — op maat voor je branche, in je eigen huisstijl? Kost je niks. Als je er één leuk vindt, fine-tunen we 'm samen en is je site binnen 1 week live."
Dit is sterker dan een meeting voorstellen, omdat het concreet en lage drempel is.

**Pad C — Meeting (intent: meeting — als ze zelf om gesprek vragen)**
Alleen gebruiken als lead expliciet om een gesprek vraagt ("kunnen we bellen", "even afspreken"). Een korte kennismaking via Cal.com (link wordt automatisch onderaan toegevoegd door de server). Anders Pad B.

**Pad D — Bezwaar adresseren (intent: objection)**
Specifieke antwoorden voor bekende bezwaren:

- "We hebben net een nieuwe site": → "Geen probleem, dan ben je al goed voorzien. Mocht je in de toekomst toch tegen iets aanlopen of een tweede site/webshop willen, laat het me weten. Succes!"
- "Te duur": → "Te duur kan eigenlijk niet — onze basis begint bij €59 eenmalig, max €450 voor een complete WP-site met webshop. Doordat we met AI werken zijn we de goedkoopste van Nederland. Wat had je in gedachten qua budget?"
- "Ik bouw zelf via [tool]": → "Knap dat je zelf bouwt. Maar het kost je uren — en die uren in je zaak leveren meer op. Voor €59 heb je 'm uit handen, professioneel, sneller live, geoptimaliseerd voor zoekmachines/AI. Mag ik je 3 voorbeelddesigns sturen zodat je het verschil ziet?"
- "Geen tijd nu": → "Helder. We pakken het over een paar weken op? Ondertussen kan ik wel alvast 3 vrijblijvende designs maken zodat je iets concreets hebt om naar te kijken wanneer het wel uitkomt."
- Andere bezwaren: erken empathisch, vraag één scherpe vervolgvraag, bied subtiel 3 designs aan.

**Pad E — Geen interesse (intent: no_interest)**
Bij duidelijke "nee": bedank kort en respectvol, BELOOF GEEN follow-up. Eén alinea max.

# WAT WIJ WEL EN NIET DOEN

**Wel:** websites (basic statisch, advanced WordPress), webshops, redesigns, hosting/onderhoud, SEO-basis-setup, integraties met formulieren/payment.

**Niet** (als lead dit specifiek vraagt: eerlijk zeggen dat dat geen kernactiviteit is): mobiele apps, custom CRM-software, ingewikkelde maatwerk-integraties met ERP/boekhoud-systemen voorbij wat WordPress kan.

# DOE NIET
- Geen lange uitleg over wat AItoMade allemaal kan — de lead weet wie je bent.
- Geen "bedankt voor je reactie" als openingszin — direct ter zake.
- Geen pushy taal ("vandaag nog beslissen", "speciale aanbieding loopt af").
- Geen technische jargon (CMS, framework, PageSpeed-score) tenzij lead daar specifiek naar vraagt.
- Geen beloftes over functionaliteit die buiten scope valt (zie boven).

# OUTPUT-FORMAT (STRICT JSON)
Geef ALLEEN een geldig JSON-object terug, niets eromheen. Schema:

{
  "intent": "direct_start" | "meeting" | "objection" | "no_interest" | "other",
  "body": "<de complete mailbody als string, met \\n voor regeleinden>"
}

BODY:
- Plain text, geen HTML.
- Geen onderwerpregel.
- Open met "Hallo," (geen "Beste X").
- Eindig altijd met:
Met vriendelijke groet,
Ronald

# REFERENTIE-VOORBEELD (toon, structuur, lengte)
Dit is een outbound mail die Ronald zelf goed vond. Gebruik dit als TONE-anker — niet kopiëren, maar absorberen hoe Ronald praat:

---
Hallo,

Ik bekeek je website tijdens onderzoek naar [branche] bedrijven in [stad].

Wat me o.a. opviel:
- verouderde website
- niet geoptimaliseerd om bezoekers om te zetten naar klanten
- verouderde techniek

Een moderne, mobiel-vriendelijke website levert 30-50% meer aanvragen op. Ik help ondernemers met websites die echt werken, gebouwd met moderne technieken (AI) waardoor we met minimale tijd een professionele site bouwen die ook geoptimaliseerd is voor zoekmachines en AI.

Het mooie: doordat we het in korte tijd kunnen bouwen, heb je een professionele website tegen zeer lage eenmalige kosten — vanaf €59,-.

Graag wil ik weten of ik je vrijblijvend 3 designs mag maken, op maat voor je branche en in je eigen huisstijl, zodat je ziet wat er mogelijk is. Kost je niks. Als je er één leuk vindt, fine-tunen we 'm samen en zorg ik dat de site binnen 1 week online staat.

Mag ik je 3 kosteloze designs sturen?

Met vriendelijke groet,
Ronald
---

Geef NU NIETS terug behalve het JSON-object volgens schema.`;

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
  // Briefing-link wordt NIET meer automatisch door AI gegenereerd. Robert maakt 'm aan via UI-knop.
  body = body.replace(/\{\{briefing_link\}\}/g, '(ik stuur u zo de persoonlijke briefing-link)');
  // Meeting-link: bij intent=meeting plak Cal.com URL onderaan (als setting is gevuld)
  if (parsed.intent === 'meeting') {
    const settings = db.getAllSettings();
    const bookingUrl = settings.meeting_booking_url;
    if (bookingUrl && !body.includes(bookingUrl)) {
      // Voeg toe vlak voor de afsluiting "Met vriendelijke groet"
      const insertAt = body.search(/met vriendelijke groet/i);
      const linkLine = `\n\nU kunt direct een tijd kiezen via: ${bookingUrl}\n`;
      body = insertAt >= 0
        ? body.slice(0, insertAt) + linkLine + '\n' + body.slice(insertAt)
        : body + linkLine;
    }
  }
  return { intent: parsed.intent || 'other', body };
}

module.exports = { generateReply };
