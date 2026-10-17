const { handlePreflight } = require('../lib/cors');
const { getDiscordUserFromToken, userHasEditorRole, env } = require('../lib/discord');
const { githubGetFile, githubUpdateFile } = require('../lib/github');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
  try {
    const { accessToken, catOrder, lawOrder } = req.body || {};
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });
    const roleCheck = await userHasEditorRole(me.id);
    if (!roleCheck.allowed) return res.status(403).json({ error: 'keine Berechtigung' });

    const dataPath = env('GITHUB_DATA_PATH', 'data/laws.json');
    const { json, sha } = await githubGetFile(dataPath);

    if (Array.isArray(catOrder)) {
      const same = catOrder.length === json.cat_order.length && catOrder.every((c) => json.cat_order.includes(c));
      if (!same) return res.status(400).json({ error: 'Kategorien stimmen nicht überein' });
      json.cat_order = catOrder;
    }
    if (Array.isArray(lawOrder)) {
      const bySlug = new Map(json.laws.map((l) => [l.slug, l]));
      const ordered = lawOrder.map((s) => bySlug.get(s)).filter(Boolean);
      const rest = json.laws.filter((l) => !lawOrder.includes(l.slug));
      json.laws = [...ordered, ...rest];
    }

    await githubUpdateFile(dataPath, json, sha, `Reihenfolge geändert (von ${me.username})`);
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
