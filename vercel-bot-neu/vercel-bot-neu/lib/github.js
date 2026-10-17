function env(name, fallback) { return process.env[name] ?? fallback; }

async function githubGetFile(path) {
  const repo = env('GITHUB_REPO'); const branch = env('GITHUB_BRANCH', 'main'); const token = env('GITHUB_TOKEN');
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${branch}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
  if (res.status === 404) return { json: null, sha: null };
  if (!res.ok) throw new Error(`GitHub-Datei konnte nicht gelesen werden (${res.status})`);
  const data = await res.json();
  const content = Buffer.from(data.content, 'base64').toString('utf-8');
  return { json: JSON.parse(content), sha: data.sha };
}
async function githubUpdateFile(path, newJsonObj, sha, commitMessage) {
  const repo = env('GITHUB_REPO'); const branch = env('GITHUB_BRANCH', 'main'); const token = env('GITHUB_TOKEN');
  const content = Buffer.from(JSON.stringify(newJsonObj, null, 2), 'utf-8').toString('base64');
  const body = { message: commitMessage, content, branch };
  if (sha) body.sha = sha;
  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${path}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`GitHub-Update fehlgeschlagen (${res.status}): ${await res.text()}`);
  return res.json();
}
async function loadTable(path, defaultValue) { const { json, sha } = await githubGetFile(path); return { data: json ?? defaultValue, sha }; }
async function saveTable(path, data, sha, commitMessage) { return githubUpdateFile(path, data, sha, commitMessage); }

async function loadWarns() { const { data, sha } = await loadTable(env('GITHUB_WARNS_PATH', 'data/warns.json'), []); return { warns: data, sha }; }
async function saveWarns(warns, sha, commitMessage) { return saveTable(env('GITHUB_WARNS_PATH', 'data/warns.json'), warns, sha, commitMessage); }

const TICKETS_PATH = 'data/tickets.json';
const PANELS_PATH = 'data/panels.json';
const STAFF_PATH = 'data/ticket-staff.json';
const TAGS_PATH = 'data/tags.json';
const BLACKLIST_PATH = 'data/ticket-blacklist.json';
const MEMBER_WATCH_PATH = 'data/member-watch.json';

async function loadTickets() { const { data, sha } = await loadTable(TICKETS_PATH, []); return { tickets: data, sha }; }
async function saveTickets(tickets, sha, msg) { return saveTable(TICKETS_PATH, tickets, sha, msg); }
async function loadPanels() { const { data, sha } = await loadTable(PANELS_PATH, []); return { panels: data, sha }; }
async function savePanels(panels, sha, msg) { return saveTable(PANELS_PATH, panels, sha, msg); }
async function loadStaff() { const { data, sha } = await loadTable(STAFF_PATH, { admins: [], support: [] }); return { staff: data, sha }; }
async function saveStaff(staff, sha, msg) { return saveTable(STAFF_PATH, staff, sha, msg); }
async function loadTags() { const { data, sha } = await loadTable(TAGS_PATH, []); return { tags: data, sha }; }
async function saveTags(tags, sha, msg) { return saveTable(TAGS_PATH, tags, sha, msg); }
async function loadBlacklist() { const { data, sha } = await loadTable(BLACKLIST_PATH, []); return { blacklist: data, sha }; }
async function saveBlacklist(list, sha, msg) { return saveTable(BLACKLIST_PATH, list, sha, msg); }
async function loadMemberWatch() { const { data, sha } = await loadTable(MEMBER_WATCH_PATH, { knownMemberIds: [], lastRaidAlertAt: 0 }); return { watch: data, sha }; }
async function saveMemberWatch(watch, sha, msg) { return saveTable(MEMBER_WATCH_PATH, watch, sha, msg); }

module.exports = {
  githubGetFile, githubUpdateFile, loadWarns, saveWarns, loadTickets, saveTickets, loadPanels, savePanels,
  loadStaff, saveStaff, loadTags, saveTags, loadBlacklist, saveBlacklist, loadMemberWatch, saveMemberWatch,
};
