const { setCors } = require('../lib/cors');
const {
  verifyDiscordSignature,
  discordFetch,
  postChannelMessage,
  editChannelMessage,
  getTopRoleMention,
  env,
} = require('../lib/discord');
const { loadWarns, saveWarns } = require('../lib/github');

// Vercel darf den Body NICHT automatisch parsen, wir brauchen den
// unveränderten (rohen) Inhalt, um die Discord-Signatur zu prüfen.
module.exports.config = { api: { bodyParser: false } };

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function optionValue(options, name) {
  const opt = (options || []).find((o) => o.name === name);
  return opt ? opt.value : undefined;
}

async function handleInteraction(interaction) {
  const { type, data, member } = interaction;
  if (type === 1) return { type: 1 };

  if (type === 2) {
    const commandName = data.name;
    const invokerId = member?.user?.id;
    const invokerRoles = member?.roles || [];
    const resolved = data.resolved || {};
    const staffRoles = (env('TICKET_STAFF_ROLE_IDS', '')).split(',').map((s) => s.trim()).filter(Boolean);
    const einstellenChannel = env('EINSTELLEN_CHANNEL_ID');
    const warnChannel = env('WARN_CHANNEL_ID');

    const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });
    const publicReply = (content) => ({ type: 4, data: { content } });

    try {
      if (commandName === 'add') {
        if (!staffRoles.some((id) => invokerRoles.includes(id))) {
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

      if (commandName === 'einstellen') {
        const name = optionValue(data.options, 'name');
        const rangRoleId = optionValue(data.options, 'rang');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const text =
          `[+] Hiermit wird ${name} mit sofortiger Wirkung als <@&${rangRoleId}> eingestellt.\n` +
          `LG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        if (einstellenChannel) await postChannelMessage(einstellenChannel, { content: text });
        return ephemeral('✅ Einstellungsmeldung wurde gepostet.');
      }

      if (commandName === 'kündigen') {
        const targetId = optionValue(data.options, 'spieler');
        const grund = optionValue(data.options, 'grund');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const text =
          `[-] Hiermit wird <@${targetId}> mit sofortiger Wirkung gekündigt. Grund: ${grund}\n` +
          `LG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        if (einstellenChannel) await postChannelMessage(einstellenChannel, { content: text });
        return ephemeral('✅ Kündigungsmeldung wurde gepostet.');
      }

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

        const posted = await postChannelMessage(warnChannel, { content: text });

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
          channelId: warnChannel,
        });
        await saveWarns(warns, sha, `Verwarnung: ${targetUser?.username || targetId} (Strike ${strikeNumber}/3)`);

        return ephemeral('✅ Verwarnung wurde eingetragen und gepostet.');
      }

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

module.exports = async (req, res) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).end();

  const rawBody = await readRawBody(req);
  const signature = req.headers['x-signature-ed25519'];
  const timestamp = req.headers['x-signature-timestamp'];

  if (!verifyDiscordSignature(rawBody, signature, timestamp)) {
    res.status(401).end('invalid request signature');
    return;
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody.toString('utf-8'));
  } catch (e) {
    return res.status(400).json({ error: 'invalid_json' });
  }

  const response = await handleInteraction(interaction);
  return res.status(200).json(response);
};
