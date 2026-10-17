const { handlePreflight } = require('../lib/cors');
const { discordFetch, env } = require('../lib/discord');
const USER = 6, STRING = 3, ROLE = 8, CHANNEL = 7, INTEGER = 4;

const COMMANDS = [
  { name: 'add', description: 'Fügt eine Person zu diesem Ticket hinzu', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'remove', description: 'Entfernt eine Person aus diesem Ticket', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'claim', description: 'Übernimmt dieses Ticket' },
  { name: 'unclaim', description: 'Gibt den Claim frei' },
  { name: 'close', description: 'Schließt dieses Ticket', options: [{ name: 'grund', description: 'Grund', type: STRING, required: false }] },
  { name: 'closerequest', description: 'Fragt nach Bestätigung zum Schließen', options: [{ name: 'grund', description: 'Grund', type: STRING, required: false }] },
  { name: 'reopen', description: 'Öffnet dieses Ticket wieder' },
  { name: 'rename', description: 'Benennt dieses Ticket um', options: [{ name: 'name', description: 'Neuer Name', type: STRING, required: true }] },
  { name: 'transfer', description: 'Überträgt dieses Ticket an jemand anderen', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'addadmin', description: 'Macht jemanden zum Ticket-Admin', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'removeadmin', description: 'Entfernt Ticket-Admin-Rechte', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'addsupport', description: 'Macht jemanden zum Ticket-Support', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'removesupport', description: 'Entfernt Ticket-Support-Rechte', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'viewstaff', description: 'Zeigt das Ticket-Team' },
  { name: 'blacklist', description: 'Sperrt/entsperrt jemanden für Tickets', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'panel', description: 'Erstellt ein Ticket-Panel', options: [{ name: 'name', description: 'Panel-Name', type: STRING, required: true }, { name: 'beschreibung', description: 'Beschreibung', type: STRING, required: false }, { name: 'kanal', description: 'Zielkanal', type: CHANNEL, required: false }] },
  { name: 'tag', description: 'Sendet einen gespeicherten Textbaustein', options: [{ name: 'name', description: 'Tag-Name', type: STRING, required: true }] },
  { name: 'managetags', description: 'Verwaltet Textbausteine', options: [{ name: 'aktion', description: 'add/delete/list', type: STRING, required: true, choices: [{ name: 'add', value: 'add' }, { name: 'delete', value: 'delete' }, { name: 'list', value: 'list' }] }, { name: 'name', description: 'Tag-Name', type: STRING, required: false }, { name: 'inhalt', description: 'Inhalt', type: STRING, required: false }] },
  { name: 'stats', description: 'Zeigt Ticket-Statistiken' },
  { name: 'about', description: 'Infos zum Bot' },
  { name: 'help', description: 'Zeigt verfügbare Befehle' },
  { name: 'einstellen', description: 'Stellt jemanden offiziell ein', options: [{ name: 'name', description: 'Name der Person', type: STRING, required: true }, { name: 'rang', description: 'Rang/Rolle', type: ROLE, required: true }, { name: 'zusatztext', description: 'Zusätzlicher Text', type: STRING, required: false }] },
  { name: 'kündigen', description: 'Kündigt jemandem offiziell', options: [{ name: 'spieler', description: 'Die gekündigte Person', type: USER, required: true }, { name: 'grund', description: 'Kündigungsgrund', type: STRING, required: true }] },
  { name: 'warn', description: 'Verhängt eine Verwarnung/Geldstrafe', options: [{ name: 'user', description: 'Die verwarnte Person', type: USER, required: true }, { name: 'betrag', description: 'Geldstrafe in Dollar', type: INTEGER, required: true }, { name: 'grund', description: 'Grund', type: STRING, required: true }] },
  { name: 'bezahlt', description: 'Markiert älteste offene Verwarnung als bezahlt', options: [{ name: 'user', description: 'Person', type: USER, required: true }] },
  { name: 'usmseinstellen', description: 'Stellt jemanden bei der USMS offiziell ein', options: [{ name: 'name', description: 'Name der Person', type: STRING, required: true }, { name: 'rang', description: 'Rang/Rolle', type: ROLE, required: true }, { name: 'spieler', description: 'Discord-Mitglied (für Servername)', type: USER, required: true }, { name: 'dienstnummer', description: 'Dienstnummer, z.B. 1', type: INTEGER, required: true }, { name: 'zusatztext', description: 'Zusätzlicher Text', type: STRING, required: false }] },
  { name: 'usmswarn', description: 'Verhängt eine USMS-Verwarnung/Geldstrafe', options: [{ name: 'user', description: 'Die verwarnte Person', type: USER, required: true }, { name: 'betrag', description: 'Geldstrafe in Dollar', type: INTEGER, required: true }, { name: 'grund', description: 'Grund', type: STRING, required: true }] },
  { name: 'usmsknopf', description: 'Postet den USMS-Kündigungs-Knopf in diesen Kanal' },
  { name: 'uprank', description: 'Befördert jemanden', options: [{ name: 'spieler', description: 'Person', type: USER, required: true }, { name: 'rang', description: 'Neuer Rang', type: ROLE, required: true }, { name: 'grund', description: 'Grund', type: STRING, required: true }] },
  { name: 'derank', description: 'Degradiert jemanden', options: [{ name: 'spieler', description: 'Person', type: USER, required: true }, { name: 'rang', description: 'Neuer Rang', type: ROLE, required: true }, { name: 'grund', description: 'Grund', type: STRING, required: true }] },
  { name: 'dm', description: 'Sendet einer Person eine Direktnachricht', options: [{ name: 'user', description: 'Empfänger', type: USER, required: true }, { name: 'nachricht', description: 'Nachricht', type: STRING, required: true }] },
];

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    const appId = env('DISCORD_CLIENT_ID');
    const guildId = env('DISCORD_GUILD_ID');
    const result = await discordFetch(`/applications/${appId}/guilds/${guildId}/commands`, { method: 'PUT', body: JSON.stringify(COMMANDS) });
    const text = await result.text();
    return res.status(200).json({ status: result.status, count: COMMANDS.length, body: text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
