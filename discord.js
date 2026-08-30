// ============================================================
// Gemeinsame Discord-REST-Hilfsfunktionen (kein Gateway nötig)
// ============================================================
const nacl = require('tweetnacl');

const DISCORD_API = 'https://discord.com/api/v10';

function env(name, fallback) {
  return process.env[name] ?? fallback;
}

async function discordFetch(path, options = {}) {
  return fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${env('DISCORD_BOT_TOKEN')}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

async function getDiscordUserFromToken(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

async function getGuildMember(userId) {
  const res = await discordFetch(`/guilds/${env('DISCORD_GUILD_ID')}/members/${userId}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Mitglied konnte nicht geladen werden (${res.status})`);
  return res.json();
}

async function userHasEditorRole(userId) {
  const editorRoles = (env('DISCORD_EDITOR_ROLE_IDS', '')).split(',').map((s) => s.trim());
  const member = await getGuildMember(userId);
  if (!member) return { allowed: false, reason: 'not_in_guild' };
  const roles = member.roles || [];
  const allowed = roles.some((id) => editorRoles.includes(id));
  return { allowed, reason: allowed ? 'ok' : 'missing_role', username: member.user?.username, roles };
}

async function userHasStaffRole(userId) {
  const staffRoles = (env('TICKET_STAFF_ROLE_IDS', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const member = await getGuildMember(userId);
  if (!member) return false;
  const roles = member.roles || [];
  return roles.some((id) => staffRoles.includes(id));
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
  const channelId = env('DISCORD_LOG_CHANNEL_ID');
  if (!channelId) return;
  const embed = {
    title: `📜 Gesetz geändert: ${lawCode ?? ''} ${lawTitle ?? ''}`.trim(),
    description: summary || 'Keine Zusammenfassung angegeben.',
    color: 0xc9a24b,
    timestamp: new Date().toISOString(),
    fields: editorName ? [{ name: 'Geändert von', value: editorName, inline: true }] : [],
    url: url || undefined,
  };
  await postChannelMessage(channelId, { embeds: [embed] }).catch((e) => console.error(e));
}

async function getTopRoleMention(memberRoleIds) {
  const guildId = env('DISCORD_GUILD_ID');
  const res = await discordFetch(`/guilds/${guildId}/roles`);
  if (!res.ok) return null;
  const guildRoles = await res.json();
  const owned = guildRoles.filter((r) => memberRoleIds.includes(r.id) && r.id !== guildId && !r.managed);
  if (!owned.length) return null;
  owned.sort((a, b) => b.position - a.position);
  return `<@&${owned[0].id}>`;
}

async function listTicketChannels() {
  const guildId = env('DISCORD_GUILD_ID');
  const res = await discordFetch(`/guilds/${guildId}/channels`);
  if (!res.ok) throw new Error(`Kanäle konnten nicht geladen werden (${res.status})`);
  const channels = await res.json();
  return channels
    .filter((c) => c.type === 0 && c.name?.startsWith('ticket-'))
    .map((c) => ({ id: c.id, name: c.name, topic: c.topic }));
}

async function createTicketChannel(creator) {
  const guildId = env('DISCORD_GUILD_ID');
  const staffRoles = (env('TICKET_STAFF_ROLE_IDS', '')).split(',').map((s) => s.trim()).filter(Boolean);
  const name = `ticket-${(creator.username || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20)}-${Date.now().toString().slice(-5)}`;
  const permissionOverwrites = [
    { id: guildId, type: 0, deny: '1024' },
    { id: creator.id, type: 1, allow: (1024 + 2048 + 65536).toString() },
    ...staffRoles.map((roleId) => ({ id: roleId, type: 0, allow: (1024 + 2048 + 65536).toString() })),
  ];
  const res = await discordFetch(`/guilds/${guildId}/channels`, {
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
  const logChannel = env('TICKET_LOG_CHANNEL_ID') || env('DISCORD_LOG_CHANNEL_ID');
  if (logChannel) {
    await postChannelMessage(logChannel, {
      content: `🔒 Ticket <#${channelId}> wurde von <@${closedBy}> geschlossen.`,
    }).catch(() => {});
  }
  const res = await discordFetch(`/channels/${channelId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Ticket-Kanal konnte nicht gelöscht werden (${res.status})`);
}

function verifyDiscordSignature(rawBody, signature, timestamp) {
  const publicKey = env('DISCORD_PUBLIC_KEY');
  if (!publicKey || !signature || !timestamp) return false;
  try {
    return nacl.sign.detached.verify(
      Buffer.concat([Buffer.from(timestamp), rawBody]),
      Buffer.from(signature, 'hex'),
      Buffer.from(publicKey, 'hex')
    );
  } catch (e) {
    return false;
  }
}

module.exports = {
  env,
  discordFetch,
  getDiscordUserFromToken,
  getGuildMember,
  userHasEditorRole,
  userHasStaffRole,
  postChannelMessage,
  editChannelMessage,
  postChangeNotification,
  getTopRoleMention,
  listTicketChannels,
  createTicketChannel,
  closeTicketChannel,
  verifyDiscordSignature,
};
