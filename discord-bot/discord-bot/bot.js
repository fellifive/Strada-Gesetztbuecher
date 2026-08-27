// ============================================================
// Strada Gesetzbuch – Backend-Server
// 1. Rollen prüfen (per Discord-Access-Token des eingeloggten Users)
// 2. Gesetzesänderungen ins GitHub-Repo speichern
// 3. Discord-Nachricht posten, wenn ein Gesetz geändert wurde
// 4. Ticket-System (Button -> privater Channel -> Transcript-Log)
// ============================================================

require('dotenv').config();
const http = require('http');
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  PermissionsBitField,
  PermissionFlagsBits,
  ChannelType,
  AttachmentBuilder,
  Partials,
} = require('discord.js');

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

  // ---- Ticket-System ----
  TICKET_CATEGORY_ID,          // Kategorie, unter der Ticket-Channels erstellt werden
  TICKET_SUPPORT_ROLE_IDS,     // Rollen, die alle Tickets sehen dürfen (Komma-getrennt)
  TICKET_LOG_CHANNEL_ID,       // Channel, in den das Transcript beim Schließen gepostet wird
  TICKET_PANEL_TITLE = 'Support-Ticket',
  TICKET_PANEL_DESCRIPTION = 'Klicke auf den Button unten, um ein Ticket zu erstellen. Unser Team meldet sich dann bei dir.',
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
if (!TICKET_CATEGORY_ID || !TICKET_LOG_CHANNEL_ID) {
  console.warn('WARNUNG: TICKET_CATEGORY_ID/TICKET_LOG_CHANNEL_ID nicht gesetzt – Ticket-System wird nicht sauber funktionieren.');
}

const EDITOR_ROLE_IDS = DISCORD_EDITOR_ROLE_IDS.split(',').map((s) => s.trim());
const SUPPORT_ROLE_IDS = (TICKET_SUPPORT_ROLE_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// "Server Members Intent" + "Message Content Intent" müssen im Developer Portal aktiviert sein!
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel, Partials.Message],
});

client.once('ready', async () => {
  console.log(`Bot eingeloggt als ${client.user.tag}`);
  await registerSlashCommands();
});

// ------------------------------------------------------------
// Discord-Hilfsfunktionen (bestehend)
// ------------------------------------------------------------
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

// ------------------------------------------------------------
// GitHub: laws.json lesen, ein Gesetz ändern, zurückschreiben (bestehend)
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
// TICKET-SYSTEM
// ------------------------------------------------------------

const TICKET_CREATE_ID = 'ticket_create';
const TICKET_CLOSE_ID = 'ticket_close';
const TICKET_CONFIRM_CLOSE_ID = 'ticket_confirm_close';
const TICKET_CANCEL_CLOSE_ID = 'ticket_cancel_close';

// Slash-Command /ticket-panel registrieren (nur in der konfigurierten Guild, damit es sofort verfügbar ist)
async function registerSlashCommands() {
  try {
    const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
    await guild.commands.set([
      {
        name: 'ticket-panel',
        description: 'Postet das Ticket-Erstellungs-Panel in diesem Channel (nur für Team).',
      },
    ]);
    console.log('Slash-Commands registriert.');
  } catch (err) {
    console.error('Slash-Commands konnten nicht registriert werden:', err);
  }
}

function buildPanelEmbedAndRow() {
  const embed = new EmbedBuilder()
    .setTitle(`🎫 ${TICKET_PANEL_TITLE}`)
    .setDescription(TICKET_PANEL_DESCRIPTION)
    .setColor(0xc9a24b);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CREATE_ID)
      .setLabel('Ticket erstellen')
      .setEmoji('🎫')
      .setStyle(ButtonStyle.Primary)
  );

  return { embed, row };
}

function buildCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CLOSE_ID)
      .setLabel('Ticket schließen')
      .setEmoji('🔒')
      .setStyle(ButtonStyle.Danger)
  );
}

function buildConfirmCloseRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(TICKET_CONFIRM_CLOSE_ID)
      .setLabel('Ja, schließen')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(TICKET_CANCEL_CLOSE_ID)
      .setLabel('Abbrechen')
      .setStyle(ButtonStyle.Secondary)
  );
}

// Findet ein bereits offenes Ticket des Users anhand des Channel-Topics (enthält die User-ID)
function findExistingTicketChannel(guild, userId) {
  return guild.channels.cache.find(
    (c) => c.parentId === TICKET_CATEGORY_ID && c.topic === `ticket-owner:${userId}`
  );
}

async function createTicketChannel(interaction) {
  const guild = interaction.guild;
  const user = interaction.user;

  const existing = findExistingTicketChannel(guild, user.id);
  if (existing) {
    return interaction.reply({
      content: `Du hast bereits ein offenes Ticket: <#${existing.id}>`,
      ephemeral: true,
    });
  }

  await interaction.deferReply({ ephemeral: true });

  const overwrites = [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    {
      id: user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AttachFiles,
      ],
    },
    {
      id: client.user.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    },
    ...SUPPORT_ROLE_IDS.map((roleId) => ({
      id: roleId,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
      ],
    })),
  ];

  const safeName = user.username.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 20) || 'user';

  const channel = await guild.channels.create({
    name: `ticket-${safeName}`,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID || undefined,
    topic: `ticket-owner:${user.id}`,
    permissionOverwrites: overwrites,
  });

  const welcomeEmbed = new EmbedBuilder()
    .setTitle('🎫 Neues Ticket')
    .setDescription(
      `Hallo <@${user.id}>, danke für dein Ticket!\nBitte beschreibe kurz dein Anliegen. Unser Team meldet sich in Kürze.`
    )
    .setColor(0xc9a24b)
    .setTimestamp(new Date());

  const mentionRoles = SUPPORT_ROLE_IDS.map((id) => `<@&${id}>`).join(' ');

  await channel.send({
    content: `${mentionRoles} <@${user.id}>`.trim(),
    embeds: [welcomeEmbed],
    components: [buildCloseRow()],
  });

  await interaction.editReply({ content: `Dein Ticket wurde erstellt: <#${channel.id}>` });
}

// Erstellt ein Text-Transcript aus dem gesamten Channel-Verlauf
async function buildTranscript(channel) {
  let allMessages = [];
  let lastId;

  while (true) {
    const options = { limit: 100 };
    if (lastId) options.before = lastId;
    const batch = await channel.messages.fetch(options);
    if (batch.size === 0) break;
    allMessages.push(...batch.values());
    lastId = batch.last().id;
    if (batch.size < 100) break;
  }

  // Chronologisch (älteste zuerst)
  allMessages.reverse();

  const lines = allMessages.map((m) => {
    const time = m.createdAt.toISOString().replace('T', ' ').slice(0, 19);
    const author = `${m.author.tag} (${m.author.id})`;
    const content = m.content || '[kein Text / Embed / Anhang]';
    const attachments = m.attachments.size
      ? '\n  Anhänge: ' + [...m.attachments.values()].map((a) => a.url).join(', ')
      : '';
    return `[${time}] ${author}: ${content}${attachments}`;
  });

  const header = `Transcript für #${channel.name} (${channel.id})\nErstellt am: ${new Date().toISOString()}\n${'='.repeat(60)}\n\n`;
  const text = header + (lines.join('\n') || '(keine Nachrichten)');
  return Buffer.from(text, 'utf-8');
}

async function closeTicketChannel(channel, closedByUser) {
  const ownerMatch = channel.topic && channel.topic.match(/^ticket-owner:(\d+)$/);
  const ownerId = ownerMatch ? ownerMatch[1] : null;

  const transcriptBuffer = await buildTranscript(channel);
  const attachment = new AttachmentBuilder(transcriptBuffer, { name: `${channel.name}-transcript.txt` });

  if (TICKET_LOG_CHANNEL_ID) {
    try {
      const logChannel = await client.channels.fetch(TICKET_LOG_CHANNEL_ID);
      if (logChannel && logChannel.isTextBased()) {
        const logEmbed = new EmbedBuilder()
          .setTitle('🔒 Ticket geschlossen')
          .addFields(
            { name: 'Channel', value: `#${channel.name}`, inline: true },
            { name: 'Geschlossen von', value: `<@${closedByUser.id}>`, inline: true },
            { name: 'Ticket-Ersteller', value: ownerId ? `<@${ownerId}>` : 'unbekannt', inline: true }
          )
          .setColor(0xc9a24b)
          .setTimestamp(new Date());
        await logChannel.send({ embeds: [logEmbed], files: [attachment] });
      }
    } catch (err) {
      console.error('Transcript konnte nicht ins Log gepostet werden:', err);
    }
  }

  await channel.send('🔒 Dieses Ticket wird in 5 Sekunden geschlossen...');
  setTimeout(() => {
    channel.delete().catch((err) => console.error('Channel konnte nicht gelöscht werden:', err));
  }, 5000);
}

// ------------------------------------------------------------
// Interaction-Handler (Slash-Commands + Buttons)
// ------------------------------------------------------------
client.on('interactionCreate', async (interaction) => {
  try {
    // /ticket-panel
    if (interaction.isChatInputCommand() && interaction.commandName === 'ticket-panel') {
      const hasPerm = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
      if (!hasPerm) {
        return interaction.reply({ content: 'Dafür fehlt dir die Berechtigung "Kanäle verwalten".', ephemeral: true });
      }
      const { embed, row } = buildPanelEmbedAndRow();
      await interaction.channel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: 'Panel gepostet ✅', ephemeral: true });
    }

    if (!interaction.isButton()) return;

    // Ticket erstellen
    if (interaction.customId === TICKET_CREATE_ID) {
      return createTicketChannel(interaction);
    }

    // Ticket schließen -> Bestätigung anzeigen
    if (interaction.customId === TICKET_CLOSE_ID) {
      return interaction.reply({
        content: 'Bist du sicher, dass du dieses Ticket schließen möchtest?',
        components: [buildConfirmCloseRow()],
        ephemeral: true,
      });
    }

    if (interaction.customId === TICKET_CANCEL_CLOSE_ID) {
      return interaction.update({ content: 'Abgebrochen.', components: [] });
    }

    if (interaction.customId === TICKET_CONFIRM_CLOSE_ID) {
      await interaction.update({ content: 'Ticket wird geschlossen...', components: [] });
      return closeTicketChannel(interaction.channel, interaction.user);
    }
  } catch (err) {
    console.error('Fehler im Interaction-Handler:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: 'Es ist ein Fehler aufgetreten.', ephemeral: true }).catch(() => {});
    }
  }
});

// ------------------------------------------------------------
// HTTP-Server mit CORS für die GitHub-Pages-Seite (bestehend)
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
    return sendJson(res, 200, { status: 'ok', botOnline: client.isReady() });
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
      return sendJson(res, 500, { error: 'internal_error' });
    }
  }

  // POST /save-law   { accessToken, slug, lawCode, lawTitle, newBody }
  if (req.method === 'POST' && req.url === '/save-law') {
    try {
      const { accessToken, slug, lawCode, lawTitle, newBody } = await readBody(req);
      if (!accessToken || !slug || typeof newBody !== 'string') {
        return sendJson(res, 400, { error: 'Fehlende Felder' });
      }

      // Wichtig: Rolle IMMER server-seitig neu prüfen, dem Client nicht vertrauen
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

client.on('error', (err) => {
  console.error('Discord-Client-Fehler:', err);
});

client.on('shardError', (err) => {
  console.error('Shard-Fehler (Verbindungsproblem zu Discord):', err);
});

process.on('unhandledRejection', (err) => {
  console.error('Unbehandelter Fehler (unhandledRejection):', err);
});

console.log('Versuche, Bot einzuloggen...');
client.login(DISCORD_BOT_TOKEN)
  .then(() => console.log('client.login() erfolgreich aufgeloest.'))
  .catch((err) => {
    console.error('FEHLER beim Login:', err);
  });
