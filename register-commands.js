const { handlePreflight } = require('../lib/cors');
const { discordFetch, env } = require('../lib/discord');

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

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    const appId = env('DISCORD_CLIENT_ID');
    const guildId = env('DISCORD_GUILD_ID');
    const result = await discordFetch(`/applications/${appId}/guilds/${guildId}/commands`, {
      method: 'PUT',
      body: JSON.stringify(COMMANDS),
    });
    const text = await result.text();
    return res.status(200).json({ status: result.status, body: text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
