// ============================================================
// Strada Gesetzbuch – Backend-Server
// 1. Rollen prüfen (per Discord-Access-Token des eingeloggten Users)
// 2. Gesetzesänderungen ins GitHub-Repo speichern
// 3. Discord-Nachricht posten, wenn ein Gesetz geändert wurde
//
// WICHTIG: Diese Version nutzt NUR normale REST-Anfragen an die
// Discord-API (keine dauerhafte "Gateway"-Verbindung). Das umgeht
// ein Problem, bei dem manche kostenlosen Hosting-Anbieter die
// dauerhafte WebSocket-Verbindung von Discord-Bots blockieren.
// Nachteil: Der Bot zeigt in Discord kein grünes "Online"-Symbol.
// Vorteil: Rollen prüfen & Nachrichten senden funktionieren trotzdem.
// ============================================================

require('dotenv').config();
const http = require('http');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_EDITOR_ROLE_IDS,
  DISCORD_LOG_CHANNEL_ID,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  GITHUB_DATA_PATH = 'data/laws.json',
  ALLOWED_ORIGIN = '*',
  PORT = 4000,
} = process.env;

const required = { DISCORD_BOT_TOKEN, DISCORD_GUILD_ID, DISCORD_EDITOR_ROLE_IDS };
for (const [key, value] of Object.entries(required)) {
  if (!value) {
    console.error(`FEHLER: ${key} fehlt in deiner .env Datei.`);
    process.exit(1);
  }
}
if (!GITHUB_TOKEN || !GITHUB_REPO) {
  console.warn('WARNUNG: GITHUB_TOKEN/GITHUB_REPO nicht gesetzt – Speichern von Änderungen wird fehlschlagen.');
}

const EDITOR_ROLE_IDS = DISCORD_EDITOR_ROLE_IDS.split(',').map((s) => s.trim());
const DISCORD_API = 'https://discord.com/api/v10';

// ------------------------------------------------------------
// Discord-Hilfsfunktionen (reine REST-Aufrufe, kein Gateway nötig)
// ------------------------------------------------------------
async function getDiscordUserFromToken(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function userHasEditorRole(userId) {
  const res = await fetch(`${DISCORD_API}/guilds/${DISCORD_GUILD_ID}/members/${userId}`, {
    headers: { Authorization: `Bot ${DISCORD_BOT_TOKEN}` },
  });
  if (res.status === 404) return { allowed: false, reason: 'not_in_guild' };
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Mitglied konnte nicht geprüft werden (${res.status}): ${text}`);
  }
  const member = await res.json();
  const roles = member.roles || [];
  const allowed = roles.some((id) => EDITOR_ROLE_IDS.includes(id));
  return { allowed, reason: allowed ? 'ok' : 'missing_role', username: member.user?.username, roles };
}

async function postChangeNotification({ lawCode, lawTitle, editorName, summary, url }) {
  if (!DISCORD_LOG_CHANNEL_ID) return;
  const embed = {
    title: `📜 Gesetz geändert: ${lawCode ?? ''} ${lawTitle ?? ''}`.trim(),
    description: summary || 'Keine Zusammenfassung angegeben.',
    color: 0xc9a24b,
    timestamp: new Date().toISOString(),
    fields: editorName ? [{ name: 'Geändert von', value: editorName, inline: true }] : [],
    url: url || undefined,
  };
  const res = await fetch(`${DISCORD_API}/channels/${DISCORD_LOG_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ embeds: [embed] }),
  });
  if (!res.ok) {
    console.error('Discord-Nachricht konnte nicht gesendet werden:', res.status, await res.text());
  }
}

// ------------------------------------------------------------
// GitHub: laws.json lesen, ein Gesetz ändern, zurückschreiben
// ------------------------------------------------------------
async function githubGetFile() {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}?ref=${GITHUB_BRANCH}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
  );
  if (!res.ok) throw new Error(`GitHub-Datei konnte nicht gelesen werden (${res.status})`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: data.sha };
}

async function githubUpdateFile(newJsonObj, sha, commitMessage) {
  const content = Buffer.from(JSON.stringify(newJsonObj, null, 2), 'utf-8').toString('base64');
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_DATA_PATH}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: commitMessage,
        content,
        sha,
        branch: GITHUB_BRANCH,
      }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub-Update fehlgeschlagen (${res.status}): ${errText}`);
  }
  return res.json();
}

// ------------------------------------------------------------
// HTTP-Server mit CORS für die GitHub-Pages-Seite
// ------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  // GET / oder /health -> für den Wach-Halte-Dienst (z.B. UptimeRobot)
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, { status: 'ok' });
  }

  // POST /check-role   { accessToken }
  if (req.method === 'POST' && req.url === '/check-role') {
    try {
      const { accessToken } = await readBody(req);
      if (!accessToken) return sendJson(res, 400, { error: 'accessToken fehlt' });
      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const result = await userHasEditorRole(me.id);
      return sendJson(res, 200, result);
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  }

  // POST /save-law   { accessToken, slug, lawCode, lawTitle, newBody }
  if (req.method === 'POST' && req.url === '/save-law') {
    try {
      const { accessToken, slug, lawCode, lawTitle, newBody } = await readBody(req);
      if (!accessToken || !slug || typeof newBody !== 'string') {
        return sendJson(res, 400, { error: 'Fehlende Felder' });
      }

      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const roleCheck = await userHasEditorRole(me.id);
      if (!roleCheck.allowed) return sendJson(res, 403, { error: 'keine Berechtigung' });

      const { json, sha } = await githubGetFile();
      const law = json.laws.find((l) => l.slug === slug);
      if (!law) return sendJson(res, 404, { error: 'Gesetz nicht gefunden' });

      law.body = newBody;
      await githubUpdateFile(json, sha, `Gesetz geändert: ${lawCode || slug} (von ${me.username})`);

      await postChangeNotification({
        lawCode,
        lawTitle,
        editorName: me.username,
        summary: 'Der Gesetzestext wurde über die Webseite bearbeitet.',
      });

      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  }

  sendJson(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => {
  console.log(`Backend-Server läuft auf Port ${PORT}`);
});
