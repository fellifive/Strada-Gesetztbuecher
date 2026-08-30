const { handlePreflight } = require('../../lib/cors');
const { getDiscordUserFromToken, createTicketChannel, env } = require('../../lib/discord');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const { accessToken } = req.body || {};
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });
    const channel = await createTicketChannel(me);
    return res.status(200).json({
      ok: true,
      channelId: channel.id,
      url: `https://discord.com/channels/${env('DISCORD_GUILD_ID')}/${channel.id}`,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
