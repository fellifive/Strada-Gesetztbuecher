// ============================================================
// GitHub: JSON-Datei lesen / schreiben
// ============================================================
function env(name, fallback) {
  return process.env[name] ?? fallback;
}

async function githubGetFile(path) {
  const repo = env('GITHUB_REPO');
  const branch = env('GITHUB_BRANCH', 'main');
  const token = env('GITHUB_TOKEN');
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } }
  );
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`GitHub-Datei konnte nicht gelesen werden (${res.status})`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: data.sha };
}

async function githubUpdateFile(path, newJsonObj, sha, commitMessage) {
  const repo = env('GITHUB_REPO');
  const branch = env('GITHUB_BRANCH', 'main');
  const token = env('GITHUB_TOKEN');
  const content = Buffer.from(JSON.stringify(newJsonObj, null, 2), 'utf-8').toString('base64');
  const body = { message: commitMessage, content, branch };
  if (sha) body.sha = sha;
  const res = await fetch(
    `https://api.github.com/repos/${repo}/contents/${path}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub-Update fehlgeschlagen (${res.status}): ${errText}`);
  }
  return res.json();
}

async function loadWarns() {
  const { json, sha } = await githubGetFile(env('GITHUB_WARNS_PATH', 'data/warns.json'));
  return { warns: json || [], sha };
}

async function saveWarns(warns, sha, commitMessage) {
  return githubUpdateFile(env('GITHUB_WARNS_PATH', 'data/warns.json'), warns, sha, commitMessage);
}

module.exports = { githubGetFile, githubUpdateFile, loadWarns, saveWarns };
