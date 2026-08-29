// ============================================================
// Strada Gesetzbuch & Verwaltung – Backend-Server
// Alles läuft über normale REST-Anfragen an Discord (keine
// dauerhafte Gateway-Verbindung, siehe README für den Hintergrund).
// ============================================================

require('dotenv').config();
const http = require('http');
const nacl = require('tweetnacl');

const {
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_PUBLIC_KEY,
  DISCORD_GUILD_ID,
  DISCORD_EDITOR_ROLE_IDS,
  DISCORD_LOG_CHANNEL_ID,
  TICKET_STAFF_ROLE_IDS,
  TICKET_LOG_CHANNEL_ID,
  EINSTELLEN_CHANNEL_ID,
  WARN_CHANNEL_ID,
  GITHUB_TOKEN,
  GITHUB_REPO,
  GITHUB_BRANCH = 'main',
  GITHUB_DATA_PATH = 'data/laws.json',
  GITHUB_WARNS_PATH = 'data/warns.json',
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
if (!DISCORD_PUBLIC_KEY) {
  console.warn('WARNUNG: DISCORD_PUBLIC_KEY fehlt – Slash-Commands (/add, /einstellen, /warn, ...) funktionieren nicht.');
}

const EDITOR_ROLE_IDS = DISCORD_EDITOR_ROLE_IDS.split(',').map((s) => s.trim());
const STAFF_ROLE_IDS = (TICKET_STAFF_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DISCORD_API = 'https://discord.com/api/v10';

// ------------------------------------------------------------
// Kleine Discord-REST-Hilfsfunktionen
// ------------------------------------------------------------
async function discordFetch(path, options = {}) {
  const res = await fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  return res;
}

async function getDiscordUserFromToken(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getGuildMember(userId) {
  const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/members/${userId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mitglied konnte nicht geladen werden (${res.status})`);
  return res.json();
}

async function userHasEditorRole(userId) {
  const member = await getGuildMember(userId);
  if (!member) return { allowed: false, reason: 'not_in_guild' };
  const roles = member.roles || [];
  const allowed = roles.some((id) => EDITOR_ROLE_IDS.includes(id));
  return { allowed, reason: allowed ? 'ok' : 'missing_role', username: member.user?.username, roles };
}

async function userHasStaffRole(userId) {
  const member = await getGuildMember(userId);
  if (!member) return false;
  const roles = member.roles || [];
  return roles.some((id) => STAFF_ROLE_IDS.includes(id));
}

async function postChannelMessage(channelId, payload) {
  const res = await discordFetch(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Nachricht konnte nicht gesendet werden (${res.status}): ${t}`);
  }
  return res.json();
}

async function editChannelMessage(channelId, messageId, payload) {
  const res = await discordFetch(`/channels/${channelId}/messages/${messageId}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Nachricht konnte nicht bearbeitet werden (${res.status}): ${t}`);
  }
  return res.json();
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
  await postChannelMessage(DISCORD_LOG_CHANNEL_ID, { embeds: [embed] }).catch((e) => console.error(e));
}

// Höchste (nach Position) Rolle einer Person ermitteln, um sie als "Rang" zu verwenden
async function getTopRoleMention(memberRoleIds) {
  const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/roles`);
  if (!res.ok) return null;
  const guildRoles = await res.json();
  const owned = guildRoles.filter((r) => memberRoleIds.includes(r.id) && r.id !== DISCORD_GUILD_ID && !r.managed);
  if (!owned.length) return null;
  owned.sort((a, b) => b.position - a.position);
  return `<@&${owned[0].id}>`;
}

// ------------------------------------------------------------
// GitHub: JSON-Datei lesen / schreiben (für Gesetze & Verwarnungen)
// ------------------------------------------------------------
async function githubGetFile(path) {
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`,
    { headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } }
  );
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`GitHub-Datei konnte nicht gelesen werden (${res.status})`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: data.sha };
}

async function githubUpdateFile(path, newJsonObj, sha, commitMessage) {
  const content = Buffer.from(JSON.stringify(newJsonObj, null, 2), 'utf-8').toString('base64');
  const body = { message: commitMessage, content, branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${GITHUB_REPO}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub-Update fehlgeschlagen (${res.status}): ${errText}`);
  }
  return res.json();
}

async function loadWarns() {
  const { json, sha } = await githubGetFile(GITHUB_WARNS_PATH);
  return { warns: json || [], sha };
}

async function saveWarns(warns, sha, commitMessage) {
  return githubUpdateFile(GITHUB_WARNS_PATH, warns, sha, commitMessage);
}

// ------------------------------------------------------------
// HTTP-Server: Grundgerüst, CORS, Body lesen (roh + JSON)
// ------------------------------------------------------------
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature-Ed25519, X-Signature-Timestamp');
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function verifyDiscordSignature(rawBody, signature, timestamp) {
  if (!DISCORD_PUBLIC_KEY || !signature || !timestamp) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      Buffer.from(signature, 'hex'),
      Buffer.from(DISCORD_PUBLIC_KEY, 'hex')
    );
  } catch (e) {
    return false;
  }
}

// ------------------------------------------------------------
// Slash-Commands registrieren (einmalig per Browser-Aufruf)
// ------------------------------------------------------------
const COMMANDS = [
  {
    name: 'add',
    description: 'Fügt eine Person zu diesem Ticket-Kanal hinzu',
    options: [{ name: 'user', description: 'Person, die hinzugefügt werden soll', type: 6, required: true }],
  },
  {
    name: 'einstellen',
    description: 'Stellt jemanden offiziell ein',
    options: [
      { name: 'name', description: 'Name der Person', type: 3, required: true },
      { name: 'rang', description: 'Rang/Rolle', type: 8, required: true },
    ],
  },
  {
    name: 'kündigen',
    description: 'Kündigt jemandem offiziell',
    options: [
      { name: 'spieler', description: 'Die gekündigte Person', type: 6, required: true },
      { name: 'grund', description: 'Kündigungsgrund', type: 3, required: true },
    ],
  },
  {
    name: 'warn',
    description: 'Verhängt eine Verwarnung/Geldstrafe',
    options: [
      { name: 'user', description: 'Die verwarnte Person', type: 6, required: true },
      { name: 'betrag', description: 'Geldstrafe in Dollar (nur Zahl)', type: 4, required: true },
      { name: 'grund', description: 'Grund der Verwarnung', type: 3, required: true },
    ],
  },
  {
    name: 'bezahlt',
    description: 'Markiert die älteste offene Verwarnung als bezahlt',
    options: [{ name: 'user', description: 'Betroffene Person', type: 6, required: true }],
  },
];

async function registerCommands() {
  const res = await discordFetch(`/applications/${DISCORD_CLIENT_ID}/guilds/${DISCORD_GUILD_ID}/commands`, {
    method: 'PUT',
    body: JSON.stringify(COMMANDS),
  });
  const text = await res.text();
  return { status: res.status, body: text };
}

// ------------------------------------------------------------
// Interaction-Handler (Slash-Commands)
// ------------------------------------------------------------
function optionValue(options, name) {
  const opt = (options || []).find((o) => o.name === name);
  return opt ? opt.value : undefined;
}

async function handleInteraction(interaction) {
  const { type, data, member, guild_id } = interaction;

  if (type === 1) return { type: 1 }; // PING -> PONG

  if (type === 2) {
    const commandName = data.name;
    const invokerId = member?.user?.id;
    const invokerRoles = member?.roles || [];
    const resolved = data.resolved || {};

    const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });
    const publicReply = (content) => ({ type: 4, data: { content } });

    try {
      // ---------------- /add ----------------
      if (commandName === 'add') {
        if (!STAFF_ROLE_IDS.some((id) => invokerRoles.includes(id))) {
          return ephemeral('❌ Du darfst diesen Befehl nicht benutzen.');
        }
        const targetId = optionValue(data.options, 'user');
        const allowBits = (1024 + 2048 + 65536).toString(); // View + Send + Read History
        const permRes = await discordFetch(`/channels/${interaction.channel_id}/permissions/${targetId}`, {
          method: 'PUT',
          body: JSON.stringify({ type: 1, allow: allowBits, deny: '0' }),
        });
        if (!permRes.ok) return ephemeral('❌ Konnte die Person nicht hinzufügen.');
        return publicReply(`✅ <@${targetId}> wurde zum Ticket hinzugefügt.`);
      }

      // ---------------- /einstellen ----------------
      if (commandName === 'einstellen') {
        const name = optionValue(data.options, 'name');
        const rangRoleId = optionValue(data.options, 'rang');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const text =
          `[+] Hiermit wird ${name} mit sofortiger Wirkung als <@&${rangRoleId}> eingestellt.\n` +
          `LG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        if (EINSTELLEN_CHANNEL_ID) await postChannelMessage(EINSTELLEN_CHANNEL_ID, { content: text });
        return ephemeral('✅ Einstellungsmeldung wurde gepostet.');
      }

      // ---------------- /kündigen ----------------
      if (commandName === 'kündigen') {
        const targetId = optionValue(data.options, 'spieler');
        const grund = optionValue(data.options, 'grund');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const text =
          `[-] Hiermit wird <@${targetId}> mit sofortiger Wirkung gekündigt. Grund: ${grund}\n` +
          `LG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        if (EINSTELLEN_CHANNEL_ID) await postChannelMessage(EINSTELLEN_CHANNEL_ID, { content: text });
        return ephemeral('✅ Kündigungsmeldung wurde gepostet.');
      }

      // ---------------- /warn ----------------
      if (commandName === 'warn') {
        const targetId = optionValue(data.options, 'user');
        const betrag = optionValue(data.options, 'betrag');
        const grund = optionValue(data.options, 'grund');
        const targetUser = resolved.users?.[targetId];

        const { warns, sha } = await loadWarns();
        const now = Date.now();
        const monthMs = 30 * 24 * 60 * 60 * 1000;
        const activeForUser = warns.filter((w) => w.userId === targetId && now - w.createdAt < monthMs);
        const strikeNumber = Math.min(activeForUser.length + 1, 3);

        const text =
          `⚠️ <@${targetId}> wurde verwarnt.\n` +
          `**Betrag:** ${betrag}$\n` +
          `**Grund:** ${grund}\n` +
          `**Strike:** ${strikeNumber}/3\n` +
          `**Status:** Noch nicht bezahlt`;

        const posted = await postChannelMessage(WARN_CHANNEL_ID, { content: text });

        warns.push({
          id: `${targetId}-${now}`,
          userId: targetId,
          username: targetUser?.username || targetId,
          amount: betrag,
          reason: grund,
          strike: strikeNumber,
          status: 'unpaid',
          createdAt: now,
          issuedBy: invokerId,
          messageId: posted.id,
          channelId: WARN_CHANNEL_ID,
        });
        await saveWarns(warns, sha, `Verwarnung: ${targetUser?.username || targetId} (Strike ${strikeNumber}/3)`);

        return ephemeral('✅ Verwarnung wurde eingetragen und gepostet.');
      }

      // ---------------- /bezahlt ----------------
      if (commandName === 'bezahlt') {
        const targetId = optionValue(data.options, 'user');
        const { warns, sha } = await loadWarns();
        const openOnes = warns
          .filter((w) => w.userId === targetId && w.status === 'unpaid')
          .sort((a, b) => a.createdAt - b.createdAt);

        if (!openOnes.length) return ephemeral('ℹ️ Keine offene Verwarnung für diese Person gefunden.');

        const warnEntry = openOnes[0];
        warnEntry.status = 'paid';
        warnEntry.paidAt = Date.now();
        warnEntry.paidBy = invokerId;

        await saveWarns(warns, sha, `Verwarnung bezahlt: ${warnEntry.username} (Strike ${warnEntry.strike}/3)`);

        if (warnEntry.messageId && warnEntry.channelId) {
          const newText =
            `⚠️ <@${warnEntry.userId}> wurde verwarnt.\n` +
            `**Betrag:** ${warnEntry.amount}$\n` +
            `**Grund:** ${warnEntry.reason}\n` +
            `**Strike:** ${warnEntry.strike}/3\n` +
            `**Status:** ✅ Bezahlt`;
          await editChannelMessage(warnEntry.channelId, warnEntry.messageId, { content: newText }).catch((e) => console.error(e));
        }

        return ephemeral(`✅ Verwarnung von <@${targetId}> wurde als bezahlt markiert.`);
      }

      return ephemeral('❓ Unbekannter Befehl.');
    } catch (err) {
      console.error('Interaction-Fehler:', err);
      return ephemeral('❌ Es ist ein Fehler aufgetreten: ' + err.message);
    }
  }

  return { type: 4, data: { content: 'Nicht unterstützt.' } };
}

// ------------------------------------------------------------
// Ticket-Dashboard (Webseite): Kanäle live aus Discord lesen
// ------------------------------------------------------------
async function listTicketChannels() {
  const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/channels`);
  if (!res.ok) throw new Error(`Kanäle konnten nicht geladen werden (${res.status})`);
  const channels = await res.json();
  return channels
    .filter((c) => c.type === 0 && c.name?.startsWith('ticket-'))
    .map((c) => ({ id: c.id, name: c.name, topic: c.topic }));
}

async function createTicketChannel(creator) {
  const name = `ticket-${(creator.username || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20)}-${Date.now().toString().slice(-5)}`;
  const permissionOverwrites = [
    { id: DISCORD_GUILD_ID, type: 0, deny: '1024' }, // @everyone: View Channel verbieten
    { id: creator.id, type: 1, allow: (1024 + 2048 + 65536).toString() },
    ...STAFF_ROLE_IDS.map((roleId) => ({ id: roleId, type: 0, allow: (1024 + 2048 + 65536).toString() })),
  ];
  const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/channels`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 0,
      topic: `Ticket von ${creator.username} (${creator.id})`,
      permission_overwrites: permissionOverwrites,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Ticket-Kanal konnte nicht erstellt werden (${res.status}): ${t}`);
  }
  const channel = await res.json();
  await postChannelMessage(channel.id, {
    content: `🎫 Willkommen <@${creator.id}>! Das Team kümmert sich gleich um dein Anliegen.`,
  }).catch(() => {});
  return channel;
}

async function closeTicketChannel(channelId, closedBy) {
  const logChannel = TICKET_LOG_CHANNEL_ID || DISCORD_LOG_CHANNEL_ID;
  if (logChannel) {
    await postChannelMessage(logChannel, {
      content: `🔒 Ticket <#${channelId}> wurde von <@${closedBy}> geschlossen.`,
    }).catch(() => {});
  }
  const res = await discordFetch(`/channels/${channelId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Ticket-Kanal konnte nicht gelöscht werden (${res.status})`);
}

// ------------------------------------------------------------
// HTTP-Routen
// ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const rawBody = await readRawBody(req);

  // GET / oder /health -> für Wach-Halte-Dienst
  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, { status: 'ok' });
  }

  // GET /register-commands -> einmalig im Browser aufrufen
  if (req.method === 'GET' && req.url === '/register-commands') {
    try {
      const result = await registerCommands();
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // POST /discord-interactions -> Slash-Commands (Discord ruft das auf)
  if (req.method === 'POST' && req.url === '/discord-interactions') {
    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    if (!verifyDiscordSignature(rawBody, signature, timestamp)) {
      res.writeHead(401);
      return res.end('invalid request signature');
    }
    let interaction;
    try {
      interaction = JSON.parse(rawBody.toString('utf-8'));
    } catch (e) {
      return sendJson(res, 400, { error: 'invalid_json' });
    }
    const response = await handleInteraction(interaction);
    return sendJson(res, 200, response);
  }

  // Ab hier: normale JSON-Endpunkte für die Webseite
  let bodyJson = {};
  try {
    bodyJson = rawBody.length ? JSON.parse(rawBody.toString('utf-8')) : {};
  } catch (e) {
    // ignore, bleibt {}
  }

  // POST /check-role   { accessToken }
  if (req.method === 'POST' && req.url === '/check-role') {
    try {
      const { accessToken } = bodyJson;
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
      const { accessToken, slug, lawCode, lawTitle, newBody } = bodyJson;
      if (!accessToken || !slug || typeof newBody !== 'string') {
        return sendJson(res, 400, { error: 'Fehlende Felder' });
      }
      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const roleCheck = await userHasEditorRole(me.id);
      if (!roleCheck.allowed) return sendJson(res, 403, { error: 'keine Berechtigung' });

      const { json, sha } = await githubGetFile(GITHUB_DATA_PATH);
      const law = json.laws.find((l) => l.slug === slug);
      if (!law) return sendJson(res, 404, { error: 'Gesetz nicht gefunden' });

      law.body = newBody;
      await githubUpdateFile(GITHUB_DATA_PATH, json, sha, `Gesetz geändert: ${lawCode || slug} (von ${me.username})`);
      await postChangeNotification({ lawCode, lawTitle, editorName: me.username, summary: 'Der Gesetzestext wurde über die Webseite bearbeitet.' });

      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  }

  // POST /tickets/list   { accessToken }
  if (req.method === 'POST' && req.url === '/tickets/list') {
    try {
      const { accessToken } = bodyJson;
      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const isStaff = await userHasStaffRole(me.id);
      if (!isStaff) return sendJson(res, 403, { error: 'keine Berechtigung' });
      const tickets = await listTicketChannels();
      return sendJson(res, 200, { tickets });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  }

  // POST /tickets/create   { accessToken }
  if (req.method === 'POST' && req.url === '/tickets/create') {
    try {
      const { accessToken } = bodyJson;
      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const channel = await createTicketChannel(me);
      return sendJson(res, 200, { ok: true, channelId: channel.id, url: `https://discord.com/channels/${DISCORD_GUILD_ID}/${channel.id}` });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  }

  // POST /tickets/close   { accessToken, channelId }
  if (req.method === 'POST' && req.url === '/tickets/close') {
    try {
      const { accessToken, channelId } = bodyJson;
      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const isStaff = await userHasStaffRole(me.id);
      if (!isStaff) return sendJson(res, 403, { error: 'keine Berechtigung' });
      await closeTicketChannel(channelId, me.id);
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
