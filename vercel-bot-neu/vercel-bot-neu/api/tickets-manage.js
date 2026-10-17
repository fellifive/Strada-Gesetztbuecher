const { handlePreflight } = require('../lib/cors');
const { getDiscordUserFromToken, isSupportUser, isAdminUser, env, postPanelMessage, deleteChannel, fetchChannelHistory, postChannelMessage } = require('../lib/discord');
const { loadPanels, savePanels, loadTickets, saveTickets, loadStaff, saveStaff, loadTags, saveTags, loadBlacklist, saveBlacklist } = require('../lib/github');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const { accessToken, action, payload = {} } = req.body || {};
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });

    const { staff } = await loadStaff();
    const support = await isSupportUser(me.id, staff);
    const admin = await isAdminUser(me.id, staff);
    if (!support) return res.status(403).json({ error: 'keine Berechtigung' });

    if (action === 'list-panels') { const { panels } = await loadPanels(); return res.status(200).json({ panels }); }
    if (action === 'create-panel') {
      if (!admin) return res.status(403).json({ error: 'nur Admins' });
      const { panels, sha } = await loadPanels();
      const panel = { id: `panel-${Date.now()}`, name: payload.name, description: payload.description || '', channelId: payload.channelId, categoryId: payload.categoryId || null, createdBy: me.id, createdAt: Date.now() };
      const msg = await postPanelMessage(payload.channelId, panel);
      panel.messageId = msg.id;
      panels.push(panel);
      await savePanels(panels, sha, `Panel erstellt: ${panel.name} (von ${me.username})`);
      return res.status(200).json({ ok: true, panel });
    }
    if (action === 'delete-panel') {
      if (!admin) return res.status(403).json({ error: 'nur Admins' });
      const { panels, sha } = await loadPanels();
      await savePanels(panels.filter((p) => p.id !== payload.panelId), sha, `Panel gelöscht (von ${me.username})`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'list-tickets') {
      const { tickets } = await loadTickets();
      const status = payload.status || 'open';
      return res.status(200).json({ tickets: tickets.filter((t) => t.status === status) });
    }
    if (action === 'claim-ticket') {
      const { tickets, sha } = await loadTickets();
      const t = tickets.find((x) => x.id === payload.ticketId);
      if (!t) return res.status(404).json({ error: 'nicht gefunden' });
      t.claimedBy = me.id;
      await saveTickets(tickets, sha, `Geclaimt von ${me.username}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'close-ticket') {
      const { tickets, sha } = await loadTickets();
      const t = tickets.find((x) => x.id === payload.ticketId);
      if (!t) return res.status(404).json({ error: 'nicht gefunden' });
      const transcript = await fetchChannelHistory(t.channelId);
      t.status = 'closed'; t.closedAt = Date.now(); t.closedBy = me.id; t.closeReason = payload.reason || 'Über Dashboard geschlossen'; t.transcript = transcript;
      await saveTickets(tickets, sha, `Geschlossen von ${me.username}`);
      const logChannel = env('TICKET_LOG_CHANNEL_ID') || env('DISCORD_LOG_CHANNEL_ID');
      if (logChannel) await postChannelMessage(logChannel, { content: `🔒 Ticket **${t.username}** geschlossen von ${me.username}.` }).catch(() => {});
      deleteChannel(t.channelId).catch(() => {});
      return res.status(200).json({ ok: true });
    }
    if (action === 'list-transcripts') { const { tickets } = await loadTickets(); return res.status(200).json({ tickets: tickets.filter((t) => t.status === 'closed') }); }
    if (action === 'list-staff') return res.status(200).json({ staff });
    if (action === 'add-staff') {
      if (!admin) return res.status(403).json({ error: 'nur Admins' });
      const { staff: s, sha } = await loadStaff();
      const list = payload.role === 'admin' ? s.admins : s.support;
      if (!list.includes(payload.userId)) list.push(payload.userId);
      await saveStaff(s, sha, `Team aktualisiert von ${me.username}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'remove-staff') {
      if (!admin) return res.status(403).json({ error: 'nur Admins' });
      const { staff: s, sha } = await loadStaff();
      if (payload.role === 'admin') s.admins = s.admins.filter((id) => id !== payload.userId);
      else s.support = s.support.filter((id) => id !== payload.userId);
      await saveStaff(s, sha, `Team aktualisiert von ${me.username}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'list-tags') { const { tags } = await loadTags(); return res.status(200).json({ tags }); }
    if (action === 'save-tag') {
      const { tags, sha } = await loadTags();
      const existing = tags.find((t) => t.name === payload.name);
      if (existing) existing.content = payload.content; else tags.push({ name: payload.name, content: payload.content });
      await saveTags(tags, sha, `Tag gespeichert von ${me.username}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'delete-tag') {
      const { tags, sha } = await loadTags();
      await saveTags(tags.filter((t) => t.name !== payload.name), sha, `Tag gelöscht von ${me.username}`);
      return res.status(200).json({ ok: true });
    }
    if (action === 'list-blacklist') { const { blacklist } = await loadBlacklist(); return res.status(200).json({ blacklist }); }
    if (action === 'toggle-blacklist') {
      if (!admin) return res.status(403).json({ error: 'nur Admins' });
      const { blacklist, sha } = await loadBlacklist();
      const idx = blacklist.indexOf(payload.userId);
      if (idx >= 0) blacklist.splice(idx, 1); else blacklist.push(payload.userId);
      await saveBlacklist(blacklist, sha, `Blacklist aktualisiert von ${me.username}`);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'unbekannte_aktion' });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
