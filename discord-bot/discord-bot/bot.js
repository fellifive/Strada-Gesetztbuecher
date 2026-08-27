// ============================================================
// Strada Gesetzbuch – Backend-Server
// 1. Rollen prüfen (per Discord-Access-Token des eingeloggten Users)
// 2. Gesetzesänderungen ins GitHub-Repo speichern
// 3. Discord-Nachricht posten, wenn ein Gesetz geändert wurde
// ============================================================

require('dotenv').config();
const http = require('http');
const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
  DISCORD_EDITOR_ROLE_IDS,
  DISCORD_LOG_CHANNEL_ID,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  GITHUB_DATA_PATH = 'site/data/laws.json',
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

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

client.once('ready', () => {
  console.log(`Bot eingeloggt als ${client.user.tag}`);
});

async function getDiscordUserFromToken(accessToken) {
  const res = await fetch('https://discord.com/api/users/@me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function userHasEditorRole(userId) {
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  let member;
  try {
    member = await guild.members.fetch(userId);
  } catch (err) {
    return { allowed: false, reason: 'not_in_guild' };
  }
  const roles = member.roles.cache.map((r) => r.id);
  const allowed = roles.some((id) => EDITOR_ROLE_IDS.includes(id));
  return { allowed, reason: allowed ? 'ok' : 'missing_role', username: member.user.username, roles };
}

async function postChangeNotification({ lawCode, lawTitle, editorName, summary, url }) {
  if (!DISCORD_LOG_CHANNEL_ID) return;
  const channel = await client.channels.fetch(DISCORD_LOG_CHANNEL_ID);
  if (!channel || !channel.isTextBased()) return;

  const embed = new EmbedBuilder()
    .setTitle(`📜 Gesetz geändert: ${lawCode ?? ''} ${lawTitle ?? ''}`.trim())
    .setDescription(summary || 'Keine Zusammenfassung angegeben.')
    .setColor(0xc9a24b)
    .setTimestamp(new Date());
  if (editorName) embed.addFields({ name: 'Geändert von', value: editorName, inline: true });
  if (url) embed.setURL(url);

  await channel.send({ embeds: [embed] });
}

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

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, { status: 'ok', botOnline: client.isReady() });
  }

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
      return sendJson(res, 500, { error: 'internal_error' });
    }
  }

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

// Diagnose: falls der Login hängt oder fehlschlägt, wollen wir das sehen
client.on('error', (err) => console.error('DISCORD CLIENT FEHLER:', err));
client.on('shardError', (err) => console.error('DISCORD SHARD FEHLER:', err));

console.log('Versuche, Bot einzuloggen...');
client.login(DISCORD_BOT_TOKEN)
  .then(() => console.log('client.login() Promise aufgelöst.'))
  .catch((err) => console.error('LOGIN FEHLGESCHLAGEN:', err));

setTimeout(() => {
  if (!client.isReady()) {
    console.warn('WARNUNG: Nach 15 Sekunden immer noch nicht eingeloggt. Token/Intents prüfen.');
  }
}, 15000);
