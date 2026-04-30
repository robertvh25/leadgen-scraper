# Lead Hunter v3

Lead generation CRM met:
- 🤖 24/7 auto-pilot Google Maps scraper
- 🎯 Website analyse + screenshots + scoring
- 💼 Funnel/pipeline management
- 📧 Email automation (Resend)
- 💬 WhatsApp automation (Twilio)
- ⚡ Sequence builder met manual approval per stap

## Deploy via Coolify

1. **Push naar GitHub** → commit + push deze folder
2. **Coolify Redeploy** → bouwt nieuwe versie automatisch
3. **Voeg ENV vars toe** in Coolify resource settings:

```
RESEND_API_KEY=re_xxx          # Get from resend.com
TWILIO_ACCOUNT_SID=ACxxx       # Get from twilio.com (optional)
TWILIO_AUTH_TOKEN=xxx          # Optional - for WhatsApp
PAGESPEED_API_KEY=xxx          # Optional - betere scoring
```

## Eerste setup na deploy

1. Open `https://leads.goedonline.net`
2. Ga naar **Instellingen**:
   - Vul Email afzender in (naam, email — moet Resend-geverifieerd zijn)
   - Vul bedrijfsnaam en handtekening in
3. Bekijk de **default templates** in Templates tab — pas aan naar jouw stijl
4. Bekijk de **default sequence** "Standaard outreach" — 3 stappen met approval
5. Zet **Auto-pilot** aan via sidebar toggle
6. Optioneel: zet **Auto-funnel** aan in Settings (hoge score → automatisch in funnel)

## Variabelen in templates

```
{{lead.name}}              - Bedrijfsnaam
{{lead.first_name}}        - Eerste woord van naam
{{lead.website}}           - Website URL
{{lead.website_short}}     - Zonder https://
{{lead.email}}             - Eerste email gevonden
{{lead.phone}}             - Telefoonnummer
{{lead.branch_name}}       - Branche
{{lead.city_name}}         - Stad
{{lead.score}}             - Replacement score
{{lead.pagespeed_score}}   - PageSpeed score
{{lead.first_issue}}       - Eerste issue
{{lead.issues_text}}       - Top 3 issues als bullet list
{{lead.cms_type}}          - CMS naam
{{lead.copyright_year}}    - Copyright jaar uit footer

{{settings.sender_name}}   - Jouw naam
{{settings.company_name}}  - Bedrijfsnaam
{{settings.signature}}     - Handtekening
```

## Persistent storage

- `/data/leads.db` — SQLite database
- `/data/screenshots/` — Website screenshots (~100KB elk)

Maak in Coolify een persistent volume mount op `/data` aan!

## Resend setup

1. Maak account op resend.com
2. Voeg je domein toe (bv. `aitomade.nl`)
3. Stel SPF/DKIM records in volgens Resend's instructies
4. Wacht op verificatie (~10 min)
5. Genereer API key en zet in Coolify env vars
6. Stel in Settings je sender_email in (bv. `info@aitomade.nl`)

## Twilio WhatsApp setup

Voor production WhatsApp moet je:
1. Twilio account aanmaken
2. WhatsApp Business goedkeuring aanvragen (~1-2 weken)
3. Templates door Meta laten goedkeuren

Voor testen:
1. Gebruik Twilio sandbox (`whatsapp:+14155238886`)
2. Stuur "join your-code" naar dat nummer vanaf je telefoon
3. Test berichten werken alleen naar opted-in nummers

## Alternative: wa.me links

Als WhatsApp setup te veel werk is: de app genereert ook **wa.me links** met voorbereide tekst — klik op "📱 wa.me link" in de send dialog. Klant opent hun eigen WhatsApp met je tekst al ingevuld. Werkt zonder Twilio.
