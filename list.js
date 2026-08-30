const { handlePreflight } = require('../../lib/cors');
const { getDiscordUserFromToken, userHasStaffRole, listTicketChannels } = require('../../lib/discord');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const { accessToken } = req.body || {};
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });
    const isStaff = await userHasStaffRole(me.id);
    if (!isStaff) return res.status(403).json({ error: 'keine Berechtigung' });
    const tickets = await listTicketChannels();
    return res.status(200).json({ tickets });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
