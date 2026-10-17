// Wird regelmäßig aufgerufen (z.B. per UptimeRobot alle 5 Min), da wir keine
// Dauerverbindung zu Discord haben. Prüft: Wer mit bestimmten Rollen den Server
// verlassen hat, und ob viele neue Mitglieder auf einmal beigetreten sind (Anti-Raid).
const { handlePreflight } = require('../lib/cors');
const { getAllGuildMembers, postChannelMessage, env } = require('../lib/discord');
const { loadMemberWatch, saveMemberWatch } = require('../lib/github');

function watchedRoleIds() { return (env('WATCH_ROLE_IDS', '')).split(',').map((s) => s.trim()).filter(Boolean); }

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  try {
    const members = await getAllGuildMembers();
    const { watch, sha } = await loadMemberWatch();

    const watchRoles = watchedRoleIds();
    const currentWatched = members.filter((m) => (m.roles || []).some((r) => watchRoles.includes(r))).map((m) => m.user.id);
    const departed = (watch.knownMemberIds || []).filter((id) => !currentWatched.includes(id));
    const departureLog = env('DEPARTURE_LOG_CHANNEL_ID');
    const einstellenChannel = env('EINSTELLEN_CHANNEL_ID');

    for (const userId of departed) {
      if (departureLog) await postChannelMessage(departureLog, { content: `🚪 <@${userId}> (ID: ${userId}) hat den Server verlassen (hatte Watch-Rolle).` }).catch(() => {});
      if (einstellenChannel) await postChannelMessage(einstellenChannel, { content: `[-] Hiermit wird <@${userId}> mit sofortiger Wirkung gekündigt. Grund: Server verlassen.` }).catch(() => {});
    }

    const windowMin = Number(env('ANTIRAID_WINDOW_MINUTES', '5'));
    const threshold = Number(env('ANTIRAID_JOIN_THRESHOLD', '5'));
    const cooldownMs = 10 * 60 * 1000;
    const now = Date.now();
    const cutoff = now - windowMin * 60 * 1000;
    const recentJoins = members.filter((m) => new Date(m.joined_at).getTime() >= cutoff);
    const raidLog = env('ANTIRAID_LOG_CHANNEL_ID');

    let raidAlerted = false;
    if (recentJoins.length >= threshold && (now - (watch.lastRaidAlertAt || 0)) > cooldownMs) {
      if (raidLog) {
        const names = recentJoins.map((m) => m.user.username).join(', ');
        await postChannelMessage(raidLog, { content: `🚨 **Möglicher Raid erkannt!** ${recentJoins.length} Beitritte in den letzten ${windowMin} Minuten.\nMitglieder: ${names}` }).catch(() => {});
      }
      raidAlerted = true;
    }

    await saveMemberWatch({ knownMemberIds: currentWatched, lastRaidAlertAt: raidAlerted ? now : (watch.lastRaidAlertAt || 0) }, sha, 'Periodische Prüfung');
    return res.status(200).json({ ok: true, departed: departed.length, recentJoins: recentJoins.length, raidAlerted });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
