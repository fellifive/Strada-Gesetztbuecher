# Umzug Backend Render -> Vercel

## Warum
Discord/Cloudflare hat die geteilten IP-Adressen von Render (kostenlos)
vorübergehend gesperrt (Error 1015). Vercel nutzt einen anderen
IP-Bereich und benötigt keine Kreditkarte.

## 1. Neuen Ordner ins Repo pushen

Diesen kompletten `vercel-bot`-Ordner in dein bestehendes GitHub-Repo
hochladen (z.B. als `discord-bot/vercel-bot` oder direkt ins Root
eines neuen Unterordners – Hauptsache eigenständig).

## 2. Bei Vercel registrieren

1. https://vercel.com → "Sign Up" → mit GitHub anmelden (keine
   Kreditkarte nötig)
2. "Add New..." → "Project" → dein Repo auswählen
3. Bei "Root Directory" den Ordner mit `vercel-bot` auswählen
   (z.B. `discord-bot/vercel-bot`)
4. Framework Preset: "Other" lassen
5. Bei "Environment Variables" alle Werte aus `.env.example`
   eintragen (echte Werte, wie zuvor bei Render)
6. "Deploy" klicken

Nach dem Deploy bekommst du eine URL wie
`https://strada-backend.vercel.app`

## 3. Webseite umstellen

In `assets/config.js` auf GitHub:
```js
BACKEND_URL: "https://strada-backend.vercel.app",
```
(ohne `/api` am Ende – das hängen die einzelnen Aufrufe selbst an,
falls nötig, siehe Schritt 4)

## 4. Wichtig: Pfade haben sich leicht geändert!

Bei Vercel liegen alle Funktionen unter `/api/...`. Das heißt in
`app.js` müssen die Aufrufe angepasst werden:
- `${CFG.BACKEND_URL}/check-role` → `${CFG.BACKEND_URL}/api/check-role`
- `${CFG.BACKEND_URL}/save-law` → `${CFG.BACKEND_URL}/api/save-law`
- `${CFG.BACKEND_URL}/tickets/list` → `${CFG.BACKEND_URL}/api/tickets/list`
- `${CFG.BACKEND_URL}/tickets/create` → `${CFG.BACKEND_URL}/api/tickets/create`
- `${CFG.BACKEND_URL}/tickets/close` → `${CFG.BACKEND_URL}/api/tickets/close`

(Eine bereits angepasste `app.js` liegt bei diesem Paket, siehe unten.)

## 5. Discord Developer Portal aktualisieren

- **Interaktions-Endpunkt-URL**: `https://strada-backend.vercel.app/api/discord-interactions`
- Danach einmalig aufrufen: `https://strada-backend.vercel.app/api/register-commands`

## 6. Render-Service kannst du danach löschen/pausieren

Optional – schadet aber nicht, ihn einfach ungenutzt zu lassen.

## Hinweis: kein UptimeRobot mehr nötig

Vercel-Funktionen "schlafen" nicht wie bei Render – jede Anfrage
startet die Funktion bei Bedarf innerhalb von Millisekunden neu.
Der UptimeRobot-Monitor kann bleiben, ist aber nicht mehr zwingend
erforderlich. (Ausnahme: die GitHub Pages Webseite selbst braucht
sowieso keinen Wach-Halte-Dienst, die läuft immer.)
