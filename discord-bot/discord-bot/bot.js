// ============================================================
// Strada Gesetzbuch & Verwaltung – Backend-Server
// REST-Interactions (keine dauerhafte Gateway-Verbindung) für
// Slash-Commands + ein schlanker Gateway-Client NUR für's
// Mitloggen eingehender DMs an den Bot.
// ============================================================

require('dotenv').config();
const http = require('http');
const nacl = require('tweetnacl');
const { Client, GatewayIntentBits, Partials, EmbedBuilder } = require('discord.js');

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

// ---- Feste IDs (RP-Server-spezifisch) ----
const EINSTELLEN_ALLOWED_ROLE_IDS = ['1537884709537714432', '1537884709537714431', '1537884709537714430'];
const EINSTELLEN_AUTO_ROLE_ID = '1537884709483188307';
const EINSTELLEN_ANNOUNCE_CHANNEL_ID = '1538223126230605967';
const CHANGELOG_CHANNEL_ID = '1538161271374090333';
const DM_LOG_CHANNEL_ID = '1548612480769728523';
const DM_LOG_OWNER_ID = '957211762657230858'; // wird bei eingehender DM gepingt

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
  console.warn('WARNUNG: DISCORD_PUBLIC_KEY fehlt – Slash-Commands funktionieren nicht.');
}

const EDITOR_ROLE_IDS = DISCORD_EDITOR_ROLE_IDS.split(',').map((s) => s.trim());
const STAFF_ROLE_IDS = (TICKET_STAFF_ROLE_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const DISCORD_API = 'https://discord.com/api/v10';

// ------------------------------------------------------------
// Berechtigungs-Bitflags
// ------------------------------------------------------------
const PERMS = {
  BAN_MEMBERS: 1n << 2n,
  MANAGE_MESSAGES: 1n << 13n,
  MANAGE_ROLES: 1n << 28n,
  MODERATE_MEMBERS: 1n << 40n,
};

function hasPermission(permissionsStr, flag) {
  try {
    return (BigInt(permissionsStr) & flag) === flag;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// Discord-REST-Hilfsfunktionen
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

async function addRoleToMember(userId, roleId) {
  const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`, {
    method: 'PUT',
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Rolle konnte nicht vergeben werden (${res.status}): ${t}`);
  }
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
// GitHub: JSON-Datei lesen / schreiben
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
// Changelog-Nachricht bauen
// ------------------------------------------------------------
function formatDateGerman(date) {
  return date.toLocaleDateString('de-DE', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildChangelogMessage({ added = [], edited = [], removed = [] }) {
  const date = formatDateGerman(new Date());

  let text = `**Gesetzesupdate — ${date}**\n`;
  text += `Das Department of Justice hat umfangreiche Gesetzesänderungen vorgenommen. `;
  text += `Insgesamt wurden ${added.length} neue Paragraphen eingeführt, ${edited.length} bestehende überarbeitet`;
  text += removed.length ? ` und ${removed.length} Paragraph${removed.length === 1 ? '' : 'en'} entfernt.\n\n` : `.\n\n`;
  text += `Hier die wichtigsten Änderungen im Überblick:\n\n`;

  const allChanges = [
    ...added.map((c) => ({ ...c, kind: 'added' })),
    ...edited.map((c) => ({ ...c, kind: 'edited' })),
    ...removed.map((c) => ({ ...c, kind: 'removed' })),
  ];

  const byBook = {};
  for (const change of allChanges) {
    const book = change.book || 'Weitere Änderungen';
    if (!byBook[book]) byBook[book] = [];
    byBook[book].push(change);
  }

  for (const [book, changes] of Object.entries(byBook)) {
    text += `**${book}**\n`;
    for (const c of changes) {
      text += `› §${c.paragraph} ${c.title} — ${c.note}\n`;
    }
    text += `\n`;
  }

  text += `— Department of Justice, Office of the Attorney General`;
  return text;
}

// ------------------------------------------------------------
// HTTP-Server: Grundgerüst, CORS, Body lesen
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
// Slash-Commands registrieren
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
      { name: 'spieler', description: 'Person, die eingestellt wird', type: 6, required: true },
      { name: 'rang', description: 'Rang/Rolle', type: 8, required: true },
    ],
  },
  {
    name: 'kündigung',
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
  {
    name: 'dm',
    description: 'Sendet einer Person eine offizielle Nachricht per DM',
    options: [
      { name: 'user', description: 'Empfänger', type: 6, required: true },
      { name: 'nachricht', description: 'Nachricht, die gesendet wird', type: 3, required: true },
    ],
  },
  {
    name: 'ban',
    description: 'Bannt eine Person vom Server',
    options: [
      { name: 'user', description: 'Zu bannende Person', type: 6, required: true },
      { name: 'grund', description: 'Grund des Banns', type: 3, required: false },
    ],
  },
  {
    name: 'timeout',
    description: 'Versetzt eine Person in Timeout',
    options: [
      { name: 'user', description: 'Betroffene Person', type: 6, required: true },
      { name: 'minuten', description: 'Dauer in Minuten', type: 4, required: true },
      { name: 'grund', description: 'Grund', type: 3, required: false },
    ],
  },
  {
    name: 'clear',
    description: 'Löscht mehrere Nachrichten in diesem Kanal',
    options: [
      { name: 'anzahl', description: 'Anzahl der zu löschenden Nachrichten (1-100)', type: 4, required: true },
    ],
  },
  {
    name: 'rolle',
    description: 'Rollenverwaltung',
    options: [
      {
        name: 'geben',
        description: 'Vergibt einer Person eine Rolle',
        type: 1,
        options: [
          { name: 'user', description: 'Betroffene Person', type: 6, required: true },
          { name: 'rolle', description: 'Zu vergebende Rolle', type: 8, required: true },
        ],
      },
    ],
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
// Interaction-Handler
// ------------------------------------------------------------
function optionValue(options, name) {
  const opt = (options || []).find((o) => o.name === name);
  return opt ? opt.value : undefined;
}

async function handleInteraction(interaction) {
  const { type, data, member, guild_id } = interaction;

  if (type === 1) return { type: 1 };

  if (type === 2) {
    const commandName = data.name;
    const invokerId = member?.user?.id;
    const invokerRoles = member?.roles || [];
    const invokerPerms = member?.permissions;
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
        const allowBits = (1024 + 2048 + 65536).toString();
        const permRes = await discordFetch(`/channels/${interaction.channel_id}/permissions/${targetId}`, {
          method: 'PUT',
          body: JSON.stringify({ type: 1, allow: allowBits, deny: '0' }),
        });
        if (!permRes.ok) return ephemeral('❌ Konnte die Person nicht hinzufügen.');
        return publicReply(`✅ <@${targetId}> wurde zum Ticket hinzugefügt.`);
      }

      // ---------------- /einstellen ----------------
      if (commandName === 'einstellen') {
        if (!EINSTELLEN_ALLOWED_ROLE_IDS.some((id) => invokerRoles.includes(id))) {
          return ephemeral('❌ Du darfst diesen Befehl nicht benutzen.');
        }
        const spielerId = optionValue(data.options, 'spieler');
        const rangRoleId = optionValue(data.options, 'rang');
        const issuerRang = await getTopRoleMention(invokerRoles);

        try {
          await addRoleToMember(spielerId, EINSTELLEN_AUTO_ROLE_ID);
        } catch (err) {
          console.error(err);
          return ephemeral('❌ Rolle konnte nicht vergeben werden: ' + err.message);
        }

        const text =
          `Hiermit wird mit sofortiger Wirkung <@${spielerId}> als <@&${rangRoleId}> eingestellt.\n` +
          `LG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;

        await postChannelMessage(EINSTELLEN_ANNOUNCE_CHANNEL_ID, { content: text });
        return ephemeral('✅ Einstellungsmeldung wurde gepostet und Rolle vergeben.');
      }

      // ---------------- /kündigung ----------------
      if (commandName === 'kündigung') {
        if (!EINSTELLEN_ALLOWED_ROLE_IDS.some((id) => invokerRoles.includes(id))) {
          return ephemeral('❌ Du darfst diesen Befehl nicht benutzen.');
        }
        const spielerId = optionValue(data.options, 'spieler');
        const grund = optionValue(data.options, 'grund');
        const issuerRang = await getTopRoleMention(invokerRoles);

        const text =
          `Hiermit wird mit sofortiger Wirkung <@${spielerId}> gekündigt. Grund: ${grund}\n` +
          `LG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;

        await postChannelMessage(EINSTELLEN_ANNOUNCE_CHANNEL_ID, { content: text });
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

      // ---------------- /dm ----------------
      if (commandName === 'dm') {
        if (!STAFF_ROLE_IDS.some((id) => invokerRoles.includes(id))) {
          return ephemeral('❌ Du darfst diesen Befehl nicht benutzen.');
        }
        const targetId = optionValue(data.options, 'user');
        const nachricht = optionValue(data.options, 'nachricht');
        try {
          const dmChannelRes = await discordFetch('/users/@me/channels', {
            method: 'POST',
            body: JSON.stringify({ recipient_id: targetId }),
          });
          if (!dmChannelRes.ok) throw new Error(`DM-Kanal konnte nicht erstellt werden (${dmChannelRes.status})`);
          const dmChannel = await dmChannelRes.json();
          await postChannelMessage(dmChannel.id, { content: nachricht });
          return ephemeral('✅ DM wurde gesendet.');
        } catch (err) {
          console.error(err);
          return ephemeral('❌ DM konnte nicht gesendet werden (Person hat evtl. DMs deaktiviert).');
        }
      }

      // ---------------- /ban ----------------
      if (commandName === 'ban') {
        if (!hasPermission(invokerPerms, PERMS.BAN_MEMBERS)) {
          return ephemeral('❌ Dir fehlt die Berechtigung "Mitglieder bannen".');
        }
        const targetId = optionValue(data.options, 'user');
        const grund = optionValue(data.options, 'grund') || 'Kein Grund angegeben';
        const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/bans/${targetId}`, {
          method: 'PUT',
          headers: { 'X-Audit-Log-Reason': encodeURIComponent(grund) },
          body: JSON.stringify({}),
        });
        if (!res.ok) return ephemeral('❌ Bann fehlgeschlagen (Bot-Rolle evtl. zu niedrig in der Hierarchie).');
        return publicReply(`🔨 <@${targetId}> wurde gebannt.\n**Grund:** ${grund}`);
      }

      // ---------------- /timeout ----------------
      if (commandName === 'timeout') {
        if (!hasPermission(invokerPerms, PERMS.MODERATE_MEMBERS)) {
          return ephemeral('❌ Dir fehlt die Berechtigung "Mitglieder zeitweise stummschalten".');
        }
        const targetId = optionValue(data.options, 'user');
        const minuten = optionValue(data.options, 'minuten');
        const grund = optionValue(data.options, 'grund') || 'Kein Grund angegeben';
        if (!minuten || minuten < 1 || minuten > 40320) {
          return ephemeral('❌ Bitte eine Dauer zwischen 1 und 40320 Minuten (28 Tage) angeben.');
        }
        const until = new Date(Date.now() + minuten * 60 * 1000).toISOString();
        const res = await discordFetch(`/guilds/${DISCORD_GUILD_ID}/members/${targetId}`, {
          method: 'PATCH',
          headers: { 'X-Audit-Log-Reason': encodeURIComponent(grund) },
          body: JSON.stringify({ communication_disabled_until: until }),
        });
        if (!res.ok) return ephemeral('❌ Timeout fehlgeschlagen (Bot-Rolle evtl. zu niedrig).');
        return publicReply(`🔇 <@${targetId}> wurde für ${minuten} Minute(n) stummgeschaltet.\n**Grund:** ${grund}`);
      }

      // ---------------- /clear ----------------
      if (commandName === 'clear') {
        if (!hasPermission(invokerPerms, PERMS.MANAGE_MESSAGES)) {
          return ephemeral('❌ Dir fehlt die Berechtigung "Nachrichten verwalten".');
        }
        const anzahl = optionValue(data.options, 'anzahl');
        if (!anzahl || anzahl < 1 || anzahl > 100) {
          return ephemeral('❌ Bitte eine Zahl zwischen 1 und 100 angeben.');
        }

        const listRes = await discordFetch(`/channels/${interaction.channel_id}/messages?limit=${anzahl}`);
        if (!listRes.ok) return ephemeral('❌ Nachrichten konnten nicht geladen werden.');
        const messages = await listRes.json();

        const twoWeeksAgo = Date.now() - 14 * 24 * 60 * 60 * 1000;
        const deletable = messages.filter((m) => new Date(m.timestamp).getTime() > twoWeeksAgo).map((m) => m.id);
        const skipped = messages.length - deletable.length;

        if (deletable.length === 1) {
          await discordFetch(`/channels/${interaction.channel_id}/messages/${deletable[0]}`, { method: 'DELETE' });
        } else if (deletable.length > 1) {
          await discordFetch(`/channels/${interaction.channel_id}/messages/bulk-delete`, {
            method: 'POST',
            body: JSON.stringify({ messages: deletable }),
          });
        }

        let msg = `✅ ${deletable.length} Nachricht(en) gelöscht.`;
        if (skipped > 0) msg += ` (${skipped} übersprungen, da älter als 14 Tage)`;
        return ephemeral(msg);
      }

      // ---------------- /rolle geben ----------------
      if (commandName === 'rolle') {
        const sub = data.options?.[0];
        if (sub?.name === 'geben') {
          if (!hasPermission(invokerPerms, PERMS.MANAGE_ROLES)) {
            return ephemeral('❌ Dir fehlt die Berechtigung "Rollen verwalten".');
          }
          const targetId = optionValue(sub.options, 'user');
          const roleId = optionValue(sub.options, 'rolle');
          try {
            await addRoleToMember(targetId, roleId);
            return ephemeral(`✅ <@&${roleId}> wurde an <@${targetId}> vergeben.`);
          } catch (err) {
            return ephemeral('❌ Rolle konnte nicht vergeben werden: ' + err.message);
          }
        }
        return ephemeral('❓ Unbekannter Unterbefehl.');
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
// Ticket-Dashboard
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
    { id: DISCORD_GUILD_ID, type: 0, deny: '1024' },
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
// Gateway-Client NUR für's Mitloggen eingehender DMs an den Bot
// (Message Content Intent muss im Developer Portal aktiv sein!)
// ------------------------------------------------------------
const gatewayClient = new Client({
  intents: [GatewayIntentBits.DirectMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel, Partials.Message],
});

gatewayClient.once('ready', async () => {
  console.log(`Gateway-Client eingeloggt als ${gatewayClient.user.tag}`);

  // Slash-Commands automatisch bei Discord registrieren
  try {
    const result = await registerCommands();
    if (result.status >= 200 && result.status < 300) {
      console.log('✅ Slash-Commands erfolgreich registriert:', result.body);
    } else {
      console.error('❌ Registrierung fehlgeschlagen. Status:', result.status, 'Antwort:', result.body);
    }
  } catch (err) {
    console.error('❌ Fehler beim Registrieren der Commands:', err);
  }
});

gatewayClient.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== 1) return; // 1 = DM-Kanal

  try {
    const embed = new EmbedBuilder()
      .setAuthor({
        name: `${message.author.tag} (${message.author.id})`,
        iconURL: message.author.displayAvatarURL?.(),
      })
      .setTitle('📩 Neue DM-Antwort')
      .setDescription(message.content || '*[kein Text / nur Anhang]*')
      .setColor(0xc9a24b)
      .setFooter({ text: `User ID: ${message.author.id}` })
      .setTimestamp(message.createdAt);

    const attachmentLinks = message.attachments.size
      ? [...message.attachments.values()].map((a) => a.url).join('\n')
      : undefined;

    if (attachmentLinks) {
      embed.addFields({ name: '📎 Anhänge', value: attachmentLinks, inline: false });
    }

    await postChannelMessage(DM_LOG_CHANNEL_ID, {
      content: `<@${DM_LOG_OWNER_ID}> Antwort von <@${message.author.id}>`,
      embeds: [embed.toJSON()],
    });
  } catch (err) {
    console.error('DM konnte nicht geloggt werden:', err);
  }
});

gatewayClient.login(DISCORD_BOT_TOKEN);

// ------------------------------------------------------------
// HTTP-Routen
// ------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const rawBody = await readRawBody(req);

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'GET' && req.url === '/register-commands') {
    try {
      const result = await registerCommands();
      return sendJson(res, 200, result);
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

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

  let bodyJson = {};
  try {
    bodyJson = rawBody.length ? JSON.parse(rawBody.toString('utf-8')) : {};
  } catch (e) {}

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

  if (req.method === 'POST' && req.url === '/publish-changelog') {
    try {
      const { accessToken, added, edited, removed } = bodyJson;
      if (!accessToken) return sendJson(res, 400, { error: 'accessToken fehlt' });

      const me = await getDiscordUserFromToken(accessToken);
      if (!me) return sendJson(res, 401, { error: 'ungueltiges Token' });
      const roleCheck = await userHasEditorRole(me.id);
      if (!roleCheck.allowed) return sendJson(res, 403, { error: 'keine Berechtigung' });

      const message = buildChangelogMessage({ added, edited, removed });
      await postChannelMessage(CHANGELOG_CHANNEL_ID, { content: message });

      return sendJson(res, 200, { ok: true });
    } catch (err) {
      console.error(err);
      return sendJson(res, 500, { error: 'internal_error', message: err.message });
    }
  }

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
