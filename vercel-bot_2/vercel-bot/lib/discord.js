const nacl = require('tweetnacl');
const DISCORD_API = 'https://discord.com/api/v10';
function env(name, fallback) { return process.env[name] ?? fallback; }

async function discordFetch(path, options = {}) {
  return fetch(`${DISCORD_API}${path}`, {
    ...options,
    headers: { Authorization: `Bot ${env('DISCORD_BOT_TOKEN')}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
}
async function getDiscordUserFromToken(accessToken) {
  const res = await fetch(`${DISCORD_API}/users/@me`, { headers: { Authorization: `Bearer ${accessToken}` } });
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
function roleBasedStaffIds() { return (env('TICKET_STAFF_ROLE_IDS', '')).split(',').map((s) => s.trim()).filter(Boolean); }
function isSupportByRoles(memberRoleIds) { return roleBasedStaffIds().some((id) => memberRoleIds.includes(id)); }
function isPersonalabteilung(memberRoleIds) { const id = env('PERSONALABTEILUNG_ROLE_ID'); return id ? memberRoleIds.includes(id) : false; }
function isUsmsAllowed(memberRoleIds) { return isSupportByRoles(memberRoleIds) || isPersonalabteilung(memberRoleIds); }
function restrictedRangRoleIds() { return (env('RESTRICTED_RANG_ROLE_IDS', '')).split(',').map((s) => s.trim()).filter(Boolean); }
async function isSupportUser(userId, staff) {
  if (staff.admins.includes(userId) || staff.support.includes(userId)) return true;
  const member = await getGuildMember(userId);
  if (!member) return false;
  return isSupportByRoles(member.roles || []);
}
async function isAdminUser(userId, staff) {
  if (staff.admins.includes(userId)) return true;
  const member = await getGuildMember(userId);
  if (!member) return false;
  return isSupportByRoles(member.roles || []);
}
async function postChannelMessage(channelId, payload) {
  const res = await discordFetch(`/channels/${channelId}/messages`, { method: 'POST', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Nachricht konnte nicht gesendet werden (${res.status}): ${await res.text()}`);
  return res.json();
}
async function editChannelMessage(channelId, messageId, payload) {
  const res = await discordFetch(`/channels/${channelId}/messages/${messageId}`, { method: 'PATCH', body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Nachricht konnte nicht bearbeitet werden (${res.status}): ${await res.text()}`);
  return res.json();
}
async function postChangeNotification({ lawCode, lawTitle, editorName, summary, url }) {
  const channelId = env('DISCORD_LOG_CHANNEL_ID');
  if (!channelId) return;
  const embed = { title: `📜 Gesetz geändert: ${lawCode ?? ''} ${lawTitle ?? ''}`.trim(), description: summary || 'Keine Zusammenfassung angegeben.', color: 0xc9a24b, timestamp: new Date().toISOString(), fields: editorName ? [{ name: 'Geändert von', value: editorName, inline: true }] : [], url: url || undefined };
  await postChannelMessage(channelId, { embeds: [embed] }).catch((e) => console.error(e));
}
async function postPublishAnnouncement({ lawCode, lawTitle, oldBody, newBody, editorName }) {
  const channelId = env('PUBLISH_CHANNEL_ID');
  if (!channelId) return;
  const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '–');
  const text = `Hiermit verkündet das DOJ, dass ab sofort die folgenden Änderungen des ${lawTitle || lawCode} vorgenommen werden.\n\n**Wie es vorher war:**\n${truncate(oldBody, 800)}\n\n**Wie es nachher ist:**\n${truncate(newBody, 800)}\n\n_Geändert von: ${editorName || 'unbekannt'}_`;
  await postChannelMessage(channelId, { content: text.slice(0, 1990) });
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
const PERM_VIEW = 1024, PERM_SEND = 2048, PERM_HISTORY = 65536;
const TICKET_PERMS = (PERM_VIEW + PERM_SEND + PERM_HISTORY).toString();
async function createTicketChannel({ creator, panel }) {
  const guildId = env('DISCORD_GUILD_ID');
  const overwrites = [{ id: guildId, type: 0, deny: PERM_VIEW.toString() }, { id: creator.id, type: 1, allow: TICKET_PERMS }, ...roleBasedStaffIds().map((roleId) => ({ id: roleId, type: 0, allow: TICKET_PERMS }))];
  const name = `ticket-${(creator.username || 'user').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20)}-${Date.now().toString().slice(-5)}`;
  const body = { name, type: 0, topic: `Ticket von ${creator.username} (${creator.id})${panel ? ' • Panel: ' + panel.name : ''}`, permission_overwrites: overwrites };
  if (panel?.categoryId) body.parent_id = panel.categoryId;
  const res = await discordFetch(`/guilds/${guildId}/channels`, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Ticket-Kanal konnte nicht erstellt werden (${res.status}): ${await res.text()}`);
  const channel = await res.json();
  await postChannelMessage(channel.id, { content: `🎫 Willkommen <@${creator.id}>!${panel ? ` Thema: **${panel.name}**` : ''} Das Team kümmert sich gleich um dein Anliegen.` }).catch(() => {});
  return channel;
}
async function fetchChannelHistory(channelId, limit = 100) {
  const res = await discordFetch(`/channels/${channelId}/messages?limit=${limit}`);
  if (!res.ok) return [];
  const msgs = await res.json();
  return msgs.reverse().map((m) => ({ author: m.author?.username || 'unbekannt', authorId: m.author?.id, content: m.content, timestamp: m.timestamp }));
}
async function deleteChannel(channelId) {
  const res = await discordFetch(`/channels/${channelId}`, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Kanal konnte nicht gelöscht werden (${res.status})`);
}
async function setChannelPermission(channelId, targetId, type, allow) {
  const res = await discordFetch(`/channels/${channelId}/permissions/${targetId}`, { method: 'PUT', body: JSON.stringify({ type, allow, deny: '0' }) });
  return res.ok;
}
async function removeChannelPermission(channelId, targetId) {
  const res = await discordFetch(`/channels/${channelId}/permissions/${targetId}`, { method: 'DELETE' });
  return res.ok;
}
async function renameChannel(channelId, newName) {
  const res = await discordFetch(`/channels/${channelId}`, { method: 'PATCH', body: JSON.stringify({ name: newName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 90) }) });
  return res.ok;
}
async function postPanelMessage(channelId, panel) {
  const embed = { title: panel.name, description: panel.description || 'Klicke unten, um ein Ticket zu eröffnen.', color: 0xc9a24b };
  const component = { type: 1, components: [{ type: 2, style: 1, label: '🎫 Ticket öffnen', custom_id: `open_ticket:${panel.id}` }] };
  return postChannelMessage(channelId, { embeds: [embed], components: [component] });
}
async function postUsmsKuendigungButton(channelId) {
  const component = { type: 1, components: [{ type: 2, style: 4, label: '📋 USMS Kündigung', custom_id: 'usms_kuendigung_btn' }] };
  return postChannelMessage(channelId, { content: 'USMS-Kündigung erstellen:', components: [component] });
}
async function getAllGuildMembers() {
  const guildId = env('DISCORD_GUILD_ID');
  let all = []; let after = '0';
  while (true) {
    const res = await discordFetch(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    if (!res.ok) break;
    const batch = await res.json();
    if (!batch.length) break;
    all = all.concat(batch);
    after = batch[batch.length - 1].user.id;
    if (batch.length < 1000) break;
  }
  return all;
}
async function addMemberRole(userId, roleId) {
  const res = await discordFetch(`/guilds/${env('DISCORD_GUILD_ID')}/members/${userId}/roles/${roleId}`, { method: 'PUT' });
  return res.ok;
}
async function setMemberRoles(userId, roleIds) {
  const res = await discordFetch(`/guilds/${env('DISCORD_GUILD_ID')}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ roles: roleIds }) });
  return res.ok;
}
async function setNickname(userId, nickname) {
  const res = await discordFetch(`/guilds/${env('DISCORD_GUILD_ID')}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ nick: nickname }) });
  if (!res.ok) throw new Error(`Nickname konnte nicht gesetzt werden (${res.status}): ${await res.text()}`);
  return true;
}
async function sendDirectMessage(userId, content) {
  const dmRes = await discordFetch(`/users/@me/channels`, { method: 'POST', body: JSON.stringify({ recipient_id: userId }) });
  if (!dmRes.ok) throw new Error(`DM-Kanal konnte nicht erstellt werden (${dmRes.status})`);
  const dmChannel = await dmRes.json();
  return postChannelMessage(dmChannel.id, { content });
}
function verifyDiscordSignature(rawBody, signature, timestamp) {
  const publicKey = env('DISCORD_PUBLIC_KEY');
  if (!publicKey || !signature || !timestamp) return false;
  try {
    return nacl.sign.detached.verify(Buffer.concat([Buffer.from(timestamp), rawBody]), Buffer.from(signature, 'hex'), Buffer.from(publicKey, 'hex'));
  } catch (e) { return false; }
}
module.exports = {
  env, discordFetch, getDiscordUserFromToken, getGuildMember, userHasEditorRole, roleBasedStaffIds,
  isSupportByRoles, isPersonalabteilung, isUsmsAllowed, restrictedRangRoleIds, isSupportUser, isAdminUser,
  postChannelMessage, editChannelMessage, postChangeNotification, postPublishAnnouncement, getTopRoleMention,
  createTicketChannel, fetchChannelHistory, deleteChannel, setChannelPermission, removeChannelPermission,
  renameChannel, postPanelMessage, postUsmsKuendigungButton, getAllGuildMembers, addMemberRole,
  setMemberRoles, setNickname, sendDirectMessage, verifyDiscordSignature,
};
