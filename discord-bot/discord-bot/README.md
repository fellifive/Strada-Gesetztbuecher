# Strada Gesetzbuch — Vollständige Anleitung

Zwei Teile:
1. **`/site`** → statische Webseite für **GitHub Pages**
2. **`/discord-bot`** (dieser Ordner) → Backend-Server für **Railway/Render** (Rollenprüfung, Speichern, Discord-Bot)

---

## Teil A — Discord Application einrichten

1. https://discord.com/developers/applications → **New Application**
2. **OAuth2 → General**: Client ID kopieren
3. **OAuth2 → Redirects**: URL deiner GitHub-Pages-Seite eintragen, z.B.
   `https://deinname.github.io/dein-repo/`
4. **Bot** → "Reset Token" → Token kopieren (geheim!)
5. **Bot → Privileged Gateway Intents** → **"Server Members Intent" aktivieren** (Pflicht!)
6. **OAuth2 → URL Generator**: Scope `bot` ankreuzen, Berechtigungen `View Channels`, `Send Messages`,
   `Embed Links` ankreuzen, generierten Link öffnen und Bot auf euren Server einladen
7. Entwicklermodus in Discord aktivieren (Einstellungen → Erweitert), dann per Rechtsklick kopieren:
   - Server-ID
   - ID der beiden Editor-Rollen
   - ID des Kanals für Änderungsmeldungen

## Teil B — Backend-Server (Railway/Render, kostenlos)

1. Neues GitHub-Repo erstellen (falls noch nicht vorhanden), z.B. `strada-gesetzbuch`
2. Diesen `discord-bot`-Ordner UND den `site`-Ordner ins Repo pushen
3. Auf https://railway.app (oder render.com) → "New Project" → GitHub-Repo verbinden,
   als Root-Verzeichnis `discord-bot` angeben
4. Umgebungsvariablen dort eintragen (Inhalte aus `.env.example`, echte Werte):
   - `DISCORD_BOT_TOKEN`, `DISCORD_GUILD_ID`, `DISCORD_EDITOR_ROLE_IDS`, `DISCORD_LOG_CHANNEL_ID`
   - `GITHUB_TOKEN` (siehe unten), `GITHUB_REPO` (z.B. `deinname/strada-gesetzbuch`), `GITHUB_BRANCH`, `GITHUB_DATA_PATH`
   - `ALLOWED_ORIGIN` = deine GitHub-Pages-Adresse
5. Start-Befehl: `npm install && npm start`
6. Nach dem Deploy bekommst du eine URL wie `https://dein-projekt.up.railway.app` — die brauchst du gleich

### GitHub-Token erzeugen (damit der Server Änderungen speichern darf)

GitHub.com → Einstellungen → Developer settings → Fine-grained personal access tokens → Generate new token
- Repository access: **nur dein Gesetzbuch-Repo** auswählen
- Permissions: **Contents → Read and write**
- Token kopieren → als `GITHUB_TOKEN` in Railway/Render eintragen

## Teil C — GitHub Pages einrichten

1. Im selben Repo: Settings → Pages → Branch auswählen, Ordner `/site` als Root
2. Vor dem Hochladen `site/assets/config.js` ausfüllen:
   ```js
   DISCORD_CLIENT_ID: "...",           // aus Teil A
   BACKEND_URL: "https://dein-projekt.up.railway.app", // aus Teil B
   ```
3. Push → GitHub Pages baut automatisch, Seite ist erreichbar unter
   `https://deinname.github.io/dein-repo/`

## Wie alles zusammenspielt

1. User klickt "Mit Discord einloggen" → Discord-Login im Browser (kein Passwort bei euch gespeichert)
2. Seite bekommt ein Access-Token direkt von Discord, fragt euren Server: "Hat User X die Editor-Rolle?"
3. Falls ja: "Bearbeiten"-Button erscheint bei jedem Gesetz
4. Beim Speichern prüft der Server die Rolle **erneut** (Sicherheit), schreibt die Änderung
   direkt per GitHub-API in `site/data/laws.json` im Repo und postet eine Nachricht im Discord-Kanal
5. GitHub Pages aktualisiert sich automatisch (meist innerhalb weniger Sekunden bis 1–2 Minuten)

## Sicherheitshinweise

- `.env` niemals committen
- `GITHUB_TOKEN` und `DISCORD_BOT_TOKEN` nur in Railway/Render als Umgebungsvariable, nie im Frontend-Code
- `DISCORD_CLIENT_ID` in `config.js` ist bewusst öffentlich sichtbar — das ist normal und kein Sicherheitsrisiko
