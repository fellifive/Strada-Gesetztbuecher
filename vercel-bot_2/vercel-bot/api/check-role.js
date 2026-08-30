const { handlePreflight } = require('../lib/cors');
const { getDiscordUserFromToken, userHasEditorRole } = require('../lib/discord');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const { accessToken } = req.body || {};
    if (!accessToken) return res.status(400).json({ error: 'accessToken fehlt' });
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });
    const result = await userHasEditorRole(me.id);
    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
