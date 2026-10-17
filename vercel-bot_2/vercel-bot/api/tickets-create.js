const { handlePreflight } = require('../lib/cors');
const { getDiscordUserFromToken, createTicketChannel, env } = require('../lib/discord');
const { loadPanels, loadTickets, saveTickets, loadBlacklist } = require('../lib/github');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const { accessToken, panelId } = req.body || {};
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });

    const { blacklist } = await loadBlacklist();
    if (blacklist.includes(me.id)) return res.status(403).json({ error: 'Du bist von Tickets ausgeschlossen.' });

    const { panels } = await loadPanels();
    const panel = panelId ? panels.find((p) => p.id === panelId) : null;

    const { tickets, sha } = await loadTickets();
    const already = tickets.find((t) => t.userId === me.id && t.status === 'open' && (t.panelId || null) === (panel?.id || null));
    if (already) {
      return res.status(200).json({ ok: true, existing: true, channelId: already.channelId, url: `https://discord.com/channels/${env('DISCORD_GUILD_ID')}/${already.channelId}` });
    }

    const channel = await createTicketChannel({ creator: me, panel });
    const now = Date.now();
    tickets.push({ id: `${me.id}-${now}`, channelId: channel.id, userId: me.id, username: me.username, panelId: panel?.id || null, panelName: panel?.name || null, status: 'open', claimedBy: null, addedUsers: [], createdAt: now });
    await saveTickets(tickets, sha, `Ticket eröffnet (Webseite): ${me.username}`);

    return res.status(200).json({ ok: true, channelId: channel.id, url: `https://discord.com/channels/${env('DISCORD_GUILD_ID')}/${channel.id}` });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
