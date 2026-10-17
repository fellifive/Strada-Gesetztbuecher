const { setCors } = require('../lib/cors');
const {
  verifyDiscordSignature, discordFetch, postChannelMessage, editChannelMessage,
  getTopRoleMention, env, isSupportUser, isAdminUser, createTicketChannel,
  fetchChannelHistory, deleteChannel, setChannelPermission, removeChannelPermission,
  renameChannel, setMemberRoles, isUsmsAllowed, restrictedRangRoleIds,
  setNickname, sendDirectMessage, addMemberRole, postUsmsKuendigungButton,
} = require('../lib/discord');
const {
  loadWarns, saveWarns, loadTickets, saveTickets, loadPanels, savePanels,
  loadStaff, saveStaff, loadTags, saveTags, loadBlacklist, saveBlacklist,
} = require('../lib/github');

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
const ephemeral = (content) => ({ type: 4, data: { content, flags: 64 } });
const publicReply = (content) => ({ type: 4, data: { content } });

async function postHireFireLog(text) {
  const ch = env('HIRE_LOG_CHANNEL_ID');
  if (ch) await postChannelMessage(ch, { content: text }).catch((e) => console.error(e));
}

async function handleInteraction(interaction) {
  const { type, data, member, channel_id: channelId } = interaction;
  if (type === 1) return { type: 1 };

  if (type === 5) {
    if (data.custom_id === 'usms_kuendigung_modal') {
      const rows = data.components || [];
      const getVal = (id) => rows.flatMap((r) => r.components).find((c) => c.custom_id === id)?.value;
      const name = getVal('name');
      const grund = getVal('grund');
      const usmsChannel = env('USMS_EINSTELLEN_CHANNEL_ID');
      const text = `Hiermit wird ${name} mit sofortiger Wirkung wegen ${grund} gekündigt.`;
      if (usmsChannel) await postChannelMessage(usmsChannel, { content: text });
      await postHireFireLog(`🔻 USMS-Kündigung: ${name} (Grund: ${grund})`);
      return ephemeral('✅ USMS-Kündigung wurde gepostet.');
    }
    return ephemeral('❓ Unbekanntes Formular.');
  }

  if (type === 3) {
    const customId = data.custom_id || '';
    if (customId === 'usms_kuendigung_btn') {
      if (!isUsmsAllowed(member.roles || [])) return ephemeral('❌ Keine Berechtigung.');
      return { type: 9, data: { custom_id: 'usms_kuendigung_modal', title: 'USMS Kündigung', components: [
        { type: 1, components: [{ type: 4, custom_id: 'name', label: 'Name', style: 1, required: true }] },
        { type: 1, components: [{ type: 4, custom_id: 'grund', label: 'Grund', style: 2, required: true }] },
      ] } };
    }
    if (customId.startsWith('open_ticket:')) {
      const panelId = customId.split(':')[1];
      const invokerId = member.user.id;
      const { blacklist } = await loadBlacklist();
      if (blacklist.includes(invokerId)) return ephemeral('❌ Du bist von der Ticket-Nutzung ausgeschlossen.');
      const { panels } = await loadPanels();
      const panel = panels.find((p) => p.id === panelId);
      const { tickets, sha } = await loadTickets();
      const already = tickets.find((t) => t.userId === invokerId && t.status === 'open' && t.panelId === panelId);
      if (already) return ephemeral(`❗ Du hast bereits ein offenes Ticket: <#${already.channelId}>`);
      const channel = await createTicketChannel({ creator: member.user, panel });
      const now = Date.now();
      tickets.push({ id: `${invokerId}-${now}`, channelId: channel.id, userId: invokerId, username: member.user.username, panelId: panel?.id || null, panelName: panel?.name || null, status: 'open', claimedBy: null, addedUsers: [], createdAt: now });
      await saveTickets(tickets, sha, `Ticket eröffnet: ${member.user.username}`);
      return ephemeral(`✅ Dein Ticket wurde erstellt: <#${channel.id}>`);
    }
    return ephemeral('❓ Unbekannte Aktion.');
  }

  if (type === 2) {
    const commandName = data.name;
    const invokerId = member?.user?.id;
    const invokerRoles = member?.roles || [];
    const resolved = data.resolved || {};
    const einstellenChannel = env('EINSTELLEN_CHANNEL_ID');
    const warnChannel = env('WARN_CHANNEL_ID');

    try {
      if (['claim', 'unclaim', 'close', 'closerequest', 'reopen', 'rename', 'add', 'remove', 'transfer'].includes(commandName)) {
        const { tickets, sha } = await loadTickets();
        const { staff } = await loadStaff();
        const ticket = tickets.find((t) => t.channelId === channelId);
        if (!ticket) return ephemeral('❗ Das ist kein Ticket-Kanal.');
        const support = await isSupportUser(invokerId, staff);
        if (commandName === 'claim') {
          if (!support) return ephemeral('❌ Nur Team-Mitglieder dürfen Tickets claimen.');
          ticket.claimedBy = invokerId;
          await saveTickets(tickets, sha, `Ticket geclaimt: ${ticket.id}`);
          return publicReply(`✅ Ticket von <@${invokerId}> übernommen.`);
        }
        if (commandName === 'unclaim') {
          if (!support) return ephemeral('❌ Keine Berechtigung.');
          ticket.claimedBy = null;
          await saveTickets(tickets, sha, `Claim entfernt: ${ticket.id}`);
          return publicReply(`ℹ️ Claim wurde entfernt.`);
        }
        if (commandName === 'close' || commandName === 'closerequest') {
          if (!support && invokerId !== ticket.userId) return ephemeral('❌ Keine Berechtigung.');
          const grund = optionValue(data.options, 'grund') || 'Kein Grund angegeben';
          const transcript = await fetchChannelHistory(channelId);
          ticket.status = 'closed'; ticket.closedAt = Date.now(); ticket.closedBy = invokerId; ticket.closeReason = grund; ticket.transcript = transcript;
          await saveTickets(tickets, sha, `Ticket geschlossen: ${ticket.id}`);
          const logChannel = env('TICKET_LOG_CHANNEL_ID') || env('DISCORD_LOG_CHANNEL_ID');
          if (logChannel) await postChannelMessage(logChannel, { content: `🔒 Ticket **${ticket.username}** geschlossen von <@${invokerId}>. Grund: ${grund}` }).catch(() => {});
          setTimeout(() => deleteChannel(channelId).catch(() => {}), 3000);
          return publicReply(`🔒 Ticket wird geschlossen... Grund: ${grund}`);
        }
        if (commandName === 'reopen') {
          if (!support) return ephemeral('❌ Keine Berechtigung.');
          ticket.status = 'open';
          await saveTickets(tickets, sha, `Ticket wiedereröffnet: ${ticket.id}`);
          return publicReply('🔓 Ticket wiedereröffnet.');
        }
        if (commandName === 'rename') {
          if (!support) return ephemeral('❌ Keine Berechtigung.');
          const newName = optionValue(data.options, 'name');
          await renameChannel(channelId, newName);
          return publicReply(`✏️ Kanal umbenannt zu **${newName}**.`);
        }
        if (commandName === 'add') {
          if (!support) return ephemeral('❌ Keine Berechtigung.');
          const targetId = optionValue(data.options, 'user');
          await setChannelPermission(channelId, targetId, 1, (1024 + 2048 + 65536).toString());
          ticket.addedUsers.push(targetId);
          await saveTickets(tickets, sha, `User hinzugefügt: ${ticket.id}`);
          return publicReply(`✅ <@${targetId}> wurde hinzugefügt.`);
        }
        if (commandName === 'remove') {
          if (!support) return ephemeral('❌ Keine Berechtigung.');
          const targetId = optionValue(data.options, 'user');
          await removeChannelPermission(channelId, targetId);
          ticket.addedUsers = ticket.addedUsers.filter((id) => id !== targetId);
          await saveTickets(tickets, sha, `User entfernt: ${ticket.id}`);
          return publicReply(`✅ <@${targetId}> wurde entfernt.`);
        }
        if (commandName === 'transfer') {
          if (!support) return ephemeral('❌ Keine Berechtigung.');
          const targetId = optionValue(data.options, 'user');
          ticket.claimedBy = targetId;
          await saveTickets(tickets, sha, `Ticket übertragen: ${ticket.id}`);
          return publicReply(`🔄 Ticket übertragen an <@${targetId}>.`);
        }
      }

      if (['addadmin', 'removeadmin', 'addsupport', 'removesupport', 'viewstaff'].includes(commandName)) {
        const { staff, sha } = await loadStaff();
        const isAdmin = await isAdminUser(invokerId, staff);
        if (commandName === 'viewstaff') {
          const admins = staff.admins.map((id) => `<@${id}>`).join(', ') || '–';
          const support = staff.support.map((id) => `<@${id}>`).join(', ') || '–';
          return ephemeral(`**Admins:** ${admins}\n**Support:** ${support}`);
        }
        if (!isAdmin) return ephemeral('❌ Nur Admins dürfen das Team verwalten.');
        const targetId = optionValue(data.options, 'user');
        if (commandName === 'addadmin') { if (!staff.admins.includes(targetId)) staff.admins.push(targetId); }
        if (commandName === 'removeadmin') { staff.admins = staff.admins.filter((id) => id !== targetId); }
        if (commandName === 'addsupport') { if (!staff.support.includes(targetId)) staff.support.push(targetId); }
        if (commandName === 'removesupport') { staff.support = staff.support.filter((id) => id !== targetId); }
        await saveStaff(staff, sha, `Team aktualisiert von ${invokerId}`);
        return ephemeral(`✅ Erledigt.`);
      }

      if (commandName === 'blacklist') {
        const { staff } = await loadStaff();
        if (!(await isAdminUser(invokerId, staff))) return ephemeral('❌ Keine Berechtigung.');
        const targetId = optionValue(data.options, 'user');
        const { blacklist, sha } = await loadBlacklist();
        const idx = blacklist.indexOf(targetId);
        if (idx >= 0) { blacklist.splice(idx, 1); await saveBlacklist(blacklist, sha, `Entfernt: ${targetId}`); return ephemeral(`✅ <@${targetId}> von der Blacklist entfernt.`); }
        blacklist.push(targetId);
        await saveBlacklist(blacklist, sha, `Hinzugefügt: ${targetId}`);
        return ephemeral(`✅ <@${targetId}> auf die Blacklist gesetzt.`);
      }

      if (commandName === 'panel') {
        const { staff } = await loadStaff();
        if (!(await isAdminUser(invokerId, staff))) return ephemeral('❌ Keine Berechtigung.');
        const name = optionValue(data.options, 'name');
        const description = optionValue(data.options, 'beschreibung') || '';
        const targetChannel = optionValue(data.options, 'kanal') || channelId;
        const { panels, sha } = await loadPanels();
        const panel = { id: `panel-${Date.now()}`, name, description, channelId: targetChannel, createdBy: invokerId, createdAt: Date.now() };
        const { postPanelMessage } = require('../lib/discord');
        const msg = await postPanelMessage(targetChannel, panel);
        panel.messageId = msg.id;
        panels.push(panel);
        await savePanels(panels, sha, `Panel erstellt: ${name}`);
        return ephemeral(`✅ Panel "${name}" wurde in <#${targetChannel}> gepostet.`);
      }

      if (commandName === 'usmsknopf') {
        if (!isUsmsAllowed(invokerRoles)) return ephemeral('❌ Keine Berechtigung.');
        await postUsmsKuendigungButton(channelId);
        return ephemeral('✅ USMS-Kündigungs-Knopf gepostet.');
      }

      if (commandName === 'tag') {
        const { tags } = await loadTags();
        const tagName = optionValue(data.options, 'name');
        const tag = tags.find((t) => t.name === tagName);
        if (!tag) return ephemeral('❓ Tag nicht gefunden.');
        return publicReply(tag.content);
      }
      if (commandName === 'managetags') {
        const { staff } = await loadStaff();
        if (!(await isSupportUser(invokerId, staff))) return ephemeral('❌ Keine Berechtigung.');
        const action = optionValue(data.options, 'aktion');
        const tagName = optionValue(data.options, 'name');
        const content = optionValue(data.options, 'inhalt');
        const { tags, sha } = await loadTags();
        if (action === 'list') return ephemeral(tags.map((t) => `\`${t.name}\``).join(', ') || 'Keine Tags vorhanden.');
        if (action === 'delete') { const f = tags.filter((t) => t.name !== tagName); await saveTags(f, sha, `Tag gelöscht: ${tagName}`); return ephemeral('✅ Gelöscht.'); }
        const existing = tags.find((t) => t.name === tagName);
        if (existing) existing.content = content; else tags.push({ name: tagName, content });
        await saveTags(tags, sha, `Tag gespeichert: ${tagName}`);
        return ephemeral('✅ Gespeichert.');
      }

      if (commandName === 'stats') {
        const { tickets } = await loadTickets();
        const open = tickets.filter((t) => t.status === 'open').length;
        const closed = tickets.filter((t) => t.status === 'closed').length;
        return ephemeral(`📊 **Tickets** — Offen: ${open} · Geschlossen: ${closed} · Gesamt: ${tickets.length}`);
      }
      if (commandName === 'about') return ephemeral('📖 Strada Gesetzbuch & Ticket-Bot.');
      if (commandName === 'help') return ephemeral('Nutze /open, /claim, /close, /add, /panel, /warn, /einstellen, /kündigen, /bezahlt, /uprank, /derank, /dm.');

      if (commandName === 'einstellen') {
        const name = optionValue(data.options, 'name');
        const rangRoleId = optionValue(data.options, 'rang');
        if (restrictedRangRoleIds().includes(rangRoleId)) return ephemeral('❌ Dieser Rang darf über diesen Befehl nicht vergeben werden.');
        const zusatz = optionValue(data.options, 'zusatztext');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const text = `[+] Hiermit wird ${name} mit sofortiger Wirkung als <@&${rangRoleId}> eingestellt.` + (zusatz ? `\n${zusatz}` : '') + `\nLG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        if (einstellenChannel) await postChannelMessage(einstellenChannel, { content: text });
        await postHireFireLog(`🟢 Eingestellt: ${name} als <@&${rangRoleId}> (von <@${invokerId}>)`);
        return ephemeral('✅ Einstellungsmeldung wurde gepostet.');
      }

      if (commandName === 'kündigen') {
        const targetId = optionValue(data.options, 'spieler');
        const grund = optionValue(data.options, 'grund');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const text = `[-] Hiermit wird <@${targetId}> mit sofortiger Wirkung gekündigt. Grund: ${grund}\nLG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        if (einstellenChannel) await postChannelMessage(einstellenChannel, { content: text });
        const BUERGER_ROLE_ID = env('BUERGER_ROLE_ID');
        if (BUERGER_ROLE_ID) await setMemberRoles(targetId, [BUERGER_ROLE_ID]).catch((e) => console.error('Rollen-Entzug fehlgeschlagen:', e));
        await postHireFireLog(`🔴 Gekündigt: <@${targetId}> (Grund: ${grund}, von <@${invokerId}>)`);
        return ephemeral('✅ Kündigungsmeldung wurde gepostet und Rollen entfernt.');
      }

      if (commandName === 'usmseinstellen') {
        if (!isUsmsAllowed(invokerRoles)) return ephemeral('❌ Keine Berechtigung.');
        const name = optionValue(data.options, 'name');
        const rangRoleId = optionValue(data.options, 'rang');
        const spielerId = optionValue(data.options, 'spieler');
        const dienstnummer = optionValue(data.options, 'dienstnummer');
        if (restrictedRangRoleIds().includes(rangRoleId)) return ephemeral('❌ Dieser Rang darf über diesen Befehl nicht vergeben werden.');
        const zusatz = optionValue(data.options, 'zusatztext');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const padded = String(dienstnummer).padStart(2, '0');
        const text = `[+] Hiermit wird ${name} (Dienstnummer USMS-${padded}) mit sofortiger Wirkung als <@&${rangRoleId}> eingestellt.` + (zusatz ? `\n${zusatz}` : '') + `\nLG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        const usmsChannel = env('USMS_EINSTELLEN_CHANNEL_ID');
        if (usmsChannel) await postChannelMessage(usmsChannel, { content: text });
        if (spielerId) {
          await setNickname(spielerId, `[USMS-${padded}] ${name}`).catch((e) => console.error('Nickname-Fehler:', e));
          await addMemberRole(spielerId, rangRoleId).catch((e) => console.error(e));
          const baseRole = env('BASE_USMS_ROLE_ID');
          if (baseRole) await addMemberRole(spielerId, baseRole).catch((e) => console.error(e));
        }
        await postHireFireLog(`🟢 USMS Eingestellt: ${name} (USMS-${padded}) als <@&${rangRoleId}> (von <@${invokerId}>)`);
        return ephemeral('✅ USMS-Einstellungsmeldung wurde gepostet und Servername angepasst.');
      }

      if (commandName === 'usmswarn') {
        if (!isUsmsAllowed(invokerRoles)) return ephemeral('❌ Keine Berechtigung.');
        const targetId = optionValue(data.options, 'user');
        const betrag = optionValue(data.options, 'betrag');
        const grund = optionValue(data.options, 'grund');
        const targetUser = resolved.users?.[targetId];
        const { warns, sha } = await loadWarns();
        const now = Date.now();
        const monthMs = 30 * 24 * 60 * 60 * 1000;
        const usmsWarnChannel = env('USMS_WARN_CHANNEL_ID');
        const activeForUser = warns.filter((w) => w.userId === targetId && w.channelId === usmsWarnChannel && now - w.createdAt < monthMs);
        const strikeNumber = Math.min(activeForUser.length + 1, 3);
        const text = `⚠️ <@${targetId}> wurde verwarnt (USMS).\n**Betrag:** ${betrag}$\n**Grund:** ${grund}\n**Strike:** ${strikeNumber}/3\n**Status:** Noch nicht bezahlt`;
        const posted = await postChannelMessage(usmsWarnChannel, { content: text });
        warns.push({ id: `${targetId}-${now}`, userId: targetId, username: targetUser?.username || targetId, amount: betrag, reason: grund, strike: strikeNumber, status: 'unpaid', createdAt: now, issuedBy: invokerId, messageId: posted.id, channelId: usmsWarnChannel });
        await saveWarns(warns, sha, `USMS Verwarnung: ${targetUser?.username || targetId}`);
        return ephemeral('✅ USMS-Verwarnung wurde eingetragen und gepostet.');
      }

      if (commandName === 'uprank' || commandName === 'derank') {
        const targetId = optionValue(data.options, 'spieler');
        const rangRoleId = optionValue(data.options, 'rang');
        const grund = optionValue(data.options, 'grund');
        if (restrictedRangRoleIds().includes(rangRoleId)) return ephemeral('❌ Dieser Rang darf über diesen Befehl nicht vergeben werden.');
        const issuerRang = await getTopRoleMention(invokerRoles);
        const arrow = commandName === 'uprank' ? '↑' : '↓';
        const verb = commandName === 'uprank' ? 'befördert' : 'degradiert';
        const text = `[${arrow}] Hiermit wird <@${targetId}> mit sofortiger Wirkung zu <@&${rangRoleId}> ${verb}. Grund: ${grund}\nLG. ${issuerRang ? issuerRang + ' ' : ''}<@${invokerId}>`;
        const rankChannel = env('UPRANK_DERANK_CHANNEL_ID');
        if (rankChannel) await postChannelMessage(rankChannel, { content: text });
        return ephemeral(`✅ ${commandName === 'uprank' ? 'Beförderung' : 'Degradierung'} wurde gepostet.`);
      }

      if (commandName === 'dm') {
        const targetId = optionValue(data.options, 'user');
        const nachricht = optionValue(data.options, 'nachricht');
        try { await sendDirectMessage(targetId, nachricht); }
        catch (e) { return ephemeral('❌ DM konnte nicht gesendet werden (evtl. DMs deaktiviert).'); }
        const logChannel = env('DM_LOG_CHANNEL_ID');
        if (logChannel) await postChannelMessage(logChannel, { content: `📨 DM von <@${invokerId}> an <@${targetId}>:\n> ${nachricht}` }).catch(() => {});
        return ephemeral('✅ Nachricht wurde gesendet.');
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
        const text = `⚠️ <@${targetId}> wurde verwarnt.\n**Betrag:** ${betrag}$\n**Grund:** ${grund}\n**Strike:** ${strikeNumber}/3\n**Status:** Noch nicht bezahlt`;
        const posted = await postChannelMessage(warnChannel, { content: text });
        warns.push({ id: `${targetId}-${now}`, userId: targetId, username: targetUser?.username || targetId, amount: betrag, reason: grund, strike: strikeNumber, status: 'unpaid', createdAt: now, issuedBy: invokerId, messageId: posted.id, channelId: warnChannel });
        await saveWarns(warns, sha, `Verwarnung: ${targetUser?.username || targetId} (Strike ${strikeNumber}/3)`);
        return ephemeral('✅ Verwarnung wurde eingetragen und gepostet.');
      }

      if (commandName === 'bezahlt') {
        const targetId = optionValue(data.options, 'user');
        const { warns, sha } = await loadWarns();
        const openOnes = warns.filter((w) => w.userId === targetId && w.status === 'unpaid').sort((a, b) => a.createdAt - b.createdAt);
        if (!openOnes.length) return ephemeral('ℹ️ Keine offene Verwarnung gefunden.');
        const w = openOnes[0];
        w.status = 'paid'; w.paidAt = Date.now(); w.paidBy = invokerId;
        await saveWarns(warns, sha, `Verwarnung bezahlt: ${w.username}`);
        if (w.messageId && w.channelId) {
          const newText = `⚠️ <@${w.userId}> wurde verwarnt.\n**Betrag:** ${w.amount}$\n**Grund:** ${w.reason}\n**Strike:** ${w.strike}/3\n**Status:** ✅ Bezahlt`;
          await editChannelMessage(w.channelId, w.messageId, { content: newText }).catch(() => {});
        }
        return ephemeral(`✅ Verwarnung von <@${targetId}> als bezahlt markiert.`);
      }

      return ephemeral('❓ Unbekannter Befehl.');
    } catch (err) {
      console.error('Interaction-Fehler:', err);
      return ephemeral('❌ Fehler: ' + err.message);
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
  if (!verifyDiscordSignature(rawBody, signature, timestamp)) { res.status(401).end('invalid request signature'); return; }
  let interaction;
  try { interaction = JSON.parse(rawBody.toString('utf-8')); }
  catch (e) { return res.status(400).json({ error: 'invalid_json' }); }
  const response = await handleInteraction(interaction);
  return res.status(200).json(response);
};
