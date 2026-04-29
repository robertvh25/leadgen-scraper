# Lead Hunter — Google Maps scraper + website analyzer

Vindt bedrijven via Google Maps, analyseert hun websites en scoort hoe waarschijnlijk het is dat ze een nieuwe website nodig hebben. Bedoeld als prospecting tool voor webdesign/CRM verkoop.

## Wat doet het?

1. **Scrape** Google Maps op een zoekopdracht (bv. "kozijnbedrijf Rotterdam")
2. **Verzamel** naam, adres, telefoon, website, rating per bedrijf
3. **Analyseer** elke website op:
   - HTTPS / SSL
   - Mobiel-vriendelijkheid (viewport meta)
   - CMS detectie (WordPress, Wix, etc.)
   - Verouderde tech (jQuery 1.x, Flash, frames, table layouts)
   - Open Graph / SEO basics
   - Copyright jaartal in footer
   - PageSpeed score (optioneel met API key)
4. **Scoor** elk bedrijf 0-100 op "vervangbaarheid" — hoger = grotere kans op deal
5. **Filter & exporteer** naar CSV voor je outreach

## Lokaal draaien

```bash
npm install
node server.js
```

App draait op http://localhost:3000

## Deployment via Coolify

1. Push deze repo naar GitHub
2. Maak nieuwe Coolify resource → "Docker"
3. Verbind met je GitHub repo
4. Stel domein in (bv. `leads.aitomade.nl`) — DNS via Vimexx
5. Voeg een **persistent volume** toe: mount `/data` (voor de SQLite DB)
6. Optioneel: zet `PAGESPEED_API_KEY` als environment variable
7. Deploy → Coolify bouwt de Docker image automatisch

## PageSpeed API key (optioneel maar aanbevolen)

Gratis, geen creditcard nodig:
1. Ga naar https://console.cloud.google.com/apis/credentials
2. "API key aanmaken"
3. Activeer "PageSpeed Insights API"
4. Zet de key in `.env` als `PAGESPEED_API_KEY=...`

Zonder key werkt alles, je mist alleen de PageSpeed score.

## Disclaimer

Google Maps scrapen is technisch tegen hun ToS. Houd rekening met:
- Rate limiting: max 1-2 zoekopdrachten per uur per IP
- Bij blocks: gebruik een residential proxy of Hetzner VPS met andere IP
- Voor grootschalig gebruik → switch naar de officiële Places API
