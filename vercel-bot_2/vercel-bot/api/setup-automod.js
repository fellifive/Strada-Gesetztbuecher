// Einmalig im Browser aufrufen: legt eine Discord-AutoMod-Regel an, die jede
// Nachricht im Sperr-Kanal blockiert und dem Absender 2 Tage Timeout gibt.
// AutoMod-Regeln gelten serverweit, daher werden alle ANDEREN Kanäle ausgenommen.
// (Discord erlaubt maximal 50 ausgenommene Kanäle.)
const { handlePreflight } = require('../lib/cors');
const { discordFetch, env } = require('../lib/discord');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    const guildId = env('DISCORD_GUILD_ID');
    const targetChannel = env('TIMEOUT_CHANNEL_ID');
    if (!targetChannel) return res.status(400).json({ error: 'TIMEOUT_CHANNEL_ID fehlt' });

    const chRes = await discordFetch(`/guilds/${guildId}/channels`);
    if (!chRes.ok) return res.status(500).json({ error: 'Kanäle konnten nicht geladen werden' });
    const channels = await chRes.json();
    const exempt = channels.filter((c) => c.id !== targetChannel && c.type !== 4).map((c) => c.id); // 4 = Kategorie
    if (exempt.length > 50) {
      return res.status(400).json({ error: `Zu viele andere Kanäle (${exempt.length}). Discord erlaubt max. 50 Ausnahmen.` });
    }

    const body = {
      name: 'Sperr-Kanal: Timeout',
      event_type: 1,
      trigger_type: 1,
      trigger_metadata: { regex_patterns: ['\\S'] },
      actions: [
        { type: 1 },
        { type: 3, metadata: { duration_seconds: 172800 } },
      ],
      enabled: true,
      exempt_channels: exempt,
    };
    const r = await discordFetch(`/guilds/${guildId}/auto-moderation/rules`, { method: 'POST', body: JSON.stringify(body) });
    return res.status(200).json({ status: r.status, body: await r.text() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
