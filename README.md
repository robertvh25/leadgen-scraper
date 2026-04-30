# Lead Hunter v4

Lead generation CRM met auto-pilot, funnel, email/whatsapp automatisering — nu met **login** en **TeamLeader-stijl light theme**.

## Wat is nieuw in v4?

- 🔐 **Login systeem** met bcrypt + sessions
- 🎨 **Light theme** (TeamLeader-stijl) — wit/grijs met teal accent
- 👤 **User chip** in sidebar met uitlogknop
- 🛡️ **Rate limiting** op login (anti-brute-force)
- 🍪 **Secure cookies** (httpOnly, 30 dagen)

## Required env vars (Coolify)

```
ADMIN_USERNAME=robert
ADMIN_PASSWORD=jouw-wachtwoord-hier
```

⚠️ **Belangrijk**: Stel een sterk wachtwoord in via Coolify env vars (niet in code!). Min. 12 tekens, mix van letters/cijfers/symbolen.

## Optionele env vars

```
RESEND_API_KEY=re_xxx          # Voor email versturen
TWILIO_ACCOUNT_SID=ACxxx       # Voor WhatsApp (optioneel)
TWILIO_AUTH_TOKEN=xxx
PAGESPEED_API_KEY=xxx          # Betere scoring
```

Zonder Resend werkt alles behalve email versturen. Zonder Twilio kun je nog wel **wa.me links** genereren.

## Persistent storage

Coolify volume mount op `/data` (database + screenshots).
