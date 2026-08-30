const { handlePreflight } = require('../lib/cors');
const { getDiscordUserFromToken, userHasEditorRole, postChangeNotification, env } = require('../lib/discord');
const { githubGetFile, githubUpdateFile } = require('../lib/github');

module.exports = async (req, res) => {
  if (handlePreflight(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });

  try {
    const { accessToken, slug, lawCode, lawTitle, newBody } = req.body || {};
    if (!accessToken || !slug || typeof newBody !== 'string') {
      return res.status(400).json({ error: 'Fehlende Felder' });
    }
    const me = await getDiscordUserFromToken(accessToken);
    if (!me) return res.status(401).json({ error: 'ungueltiges Token' });
    const roleCheck = await userHasEditorRole(me.id);
    if (!roleCheck.allowed) return res.status(403).json({ error: 'keine Berechtigung' });

    const dataPath = env('GITHUB_DATA_PATH', 'data/laws.json');
    const { json, sha } = await githubGetFile(dataPath);
    const law = json.laws.find((l) => l.slug === slug);
    if (!law) return res.status(404).json({ error: 'Gesetz nicht gefunden' });

    law.body = newBody;
    await githubUpdateFile(dataPath, json, sha, `Gesetz geändert: ${lawCode || slug} (von ${me.username})`);
    await postChangeNotification({ lawCode, lawTitle, editorName: me.username, summary: 'Der Gesetzestext wurde über die Webseite bearbeitet.' });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'internal_error', message: err.message });
  }
};
