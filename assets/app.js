// ============================================================
// Gesetzbuch-Seite: Anzeige, Discord-Login, Bearbeiten, Tickets
// ============================================================
const CFG = window.SITE_CONFIG;
let SITE_DATA = null;
let CURRENT_USER = null; // { id, username, accessToken, allowed }
let REORDER_MODE = false;
let DRAFT_CATS = [];
let DRAFT_LAWS = [];

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function cssSafe(slug) { return slug.replace(/[^a-z0-9]/g, ''); }
const isEditor = () => !!(CURRENT_USER && CURRENT_USER.allowed);

async function api(path, body) {
  try {
    const base = path.startsWith('tickets-') ? (CFG.BOT_URL || CFG.BACKEND_URL) : CFG.BACKEND_URL;
    const res = await fetch(`${base}/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: CURRENT_USER?.accessToken, ...body }),
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* leer */ }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: { error: 'Verbindung fehlgeschlagen' } };
  }
}

// ------------------------------------------------------------
// 1. Gesetze laden & Startseite
// ------------------------------------------------------------
async function loadLaws() {
  const res = await fetch('data/laws.json', { cache: 'no-store' });
  SITE_DATA = await res.json();
  renderHome();
}

function formatBody(body) {
  // Leerzeilen bleiben als Abstand erhalten, §-Überschriften werden hervorgehoben
  const lines = String(body).split('\n').map((l) => l.trim());
  let html = '';
  let para = [];
  const flush = () => { if (para.length) { html += `<p>${para.join(' ')}</p>`; para = []; } };
  const headRe = /^(§\s?\d+[a-z]?\s|Buch\s|Kapitel\s|Abschnitt\s|Anlage\s|Teil\s\d|Präambel$|Allgemeine[rs]? Teil$|Besonderer Teil$)/;
  let blankRun = 0;
  for (const line of lines) {
    if (!line) {
      flush();
      blankRun++;
      if (blankRun === 1) html += '<div class="spacer"></div>';
      continue;
    }
    blankRun = 0;
    if (headRe.test(line)) { flush(); html += `<h3 class="sec-head">${esc(line)}</h3>`; }
    else para.push(esc(line));
  }
  flush();
  return html;
}

function lawsInCategory(cat, source) {
  return source.filter((l) => l.category === cat);
}

function renderHome() {
  const container = document.getElementById('categories-container');
  const cats = REORDER_MODE ? DRAFT_CATS : SITE_DATA.cat_order;
  const laws = REORDER_MODE ? DRAFT_LAWS : SITE_DATA.laws;
  document.getElementById('stat-cats').textContent = SITE_DATA.cat_order.length;
  document.getElementById('stat-laws').textContent = SITE_DATA.laws.length;

  let out = '';
  if (isEditor()) {
    out += `<div class="reorder-bar">${REORDER_MODE
      ? `<button class="save-btn" onclick="saveReorder()">Reihenfolge speichern</button><button class="cancel-btn" onclick="toggleReorder(false)">Abbrechen</button>`
      : `<button class="cancel-btn" onclick="toggleReorder(true)">↕ Reihenfolge ändern</button>`}</div>`;
  }
  cats.forEach((cat, ci) => {
    const inCat = lawsInCategory(cat, laws);
    if (!inCat.length) return;
    out += `<section class="cat-section">
      <div class="cat-header">
        <span class="cat-icon">${SITE_DATA.cat_icons[cat] || '📖'}</span>
        <h2>${esc(cat)}</h2>
        ${REORDER_MODE ? `<span class="move-btns"><button onclick="moveCat(${ci},-1)">▲</button><button onclick="moveCat(${ci},1)">▼</button></span>` : ''}
        <span class="cat-count">${inCat.length} Gesetze</span>
      </div>
      <div class="law-grid">
        ${inCat.map((l) => `
          <div class="chip-wrap">
            <button class="law-chip" onclick="${REORDER_MODE ? '' : `showLaw('${l.slug}')`}">
              <span class="chip-code">${esc(l.code)}</span>
              <span class="chip-title">${esc(l.title)}</span>
            </button>
            ${REORDER_MODE ? `<span class="move-btns small"><button onclick="moveLaw('${l.slug}',-1)">◀</button><button onclick="moveLaw('${l.slug}',1)">▶</button></span>` : ''}
          </div>`).join('')}
      </div>
    </section>`;
  });
  container.innerHTML = out;
}

// ------------------------------------------------------------
// 1b. Reihenfolge ändern
// ------------------------------------------------------------
function toggleReorder(on) {
  REORDER_MODE = on;
  if (on) { DRAFT_CATS = [...SITE_DATA.cat_order]; DRAFT_LAWS = [...SITE_DATA.laws]; }
  renderHome();
}
function moveCat(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= DRAFT_CATS.length) return;
  [DRAFT_CATS[i], DRAFT_CATS[j]] = [DRAFT_CATS[j], DRAFT_CATS[i]];
  renderHome();
}
function moveLaw(slug, dir) {
  const law = DRAFT_LAWS.find((l) => l.slug === slug);
  const peers = DRAFT_LAWS.filter((l) => l.category === law.category);
  const pi = peers.indexOf(law);
  const other = peers[pi + dir];
  if (!other) return;
  const a = DRAFT_LAWS.indexOf(law), b = DRAFT_LAWS.indexOf(other);
  [DRAFT_LAWS[a], DRAFT_LAWS[b]] = [DRAFT_LAWS[b], DRAFT_LAWS[a]];
  renderHome();
}
async function saveReorder() {
  const r = await api('reorder', { catOrder: DRAFT_CATS, lawOrder: DRAFT_LAWS.map((l) => l.slug) });
  if (!r.ok) { alert('Fehler: ' + (r.data.error || 'Speichern fehlgeschlagen')); return; }
  SITE_DATA.cat_order = [...DRAFT_CATS];
  SITE_DATA.laws = [...DRAFT_LAWS];
  REORDER_MODE = false;
  renderHome();
}

// ------------------------------------------------------------
// 2. Navigation
// ------------------------------------------------------------
function hideAll() {
  ['home-view', 'law-view', 'ticket-view'].forEach((id) => { document.getElementById(id).hidden = true; });
}
function showHome() {
  hideAll();
  document.getElementById('home-view').hidden = false;
  window.scrollTo(0, 0);
  history.replaceState(null, '', location.pathname);
}
function findLaw(slug) { return SITE_DATA.laws.find((l) => l.slug === slug); }

function showLaw(slug) {
  const law = findLaw(slug);
  if (!law) return;
  hideAll();
  const view = document.getElementById('law-view');
  view.hidden = false;
  const editor = isEditor();
  view.innerHTML = `
    <article class="law-detail" data-slug="${slug}">
      <button class="back-btn" onclick="showHome()">← Zurück zur Übersicht</button>
      <div class="law-detail-head">
        <div>
          <span class="law-badge">${esc(law.category)}</span>
          <h1>${esc(law.title)}</h1>
        </div>
        ${editor ? `<div class="head-actions">
          <button class="cancel-btn" onclick="copyLaw('${slug}')">⧉ Als Text kopieren</button>
          <button class="edit-btn" onclick="startEdit('${slug}')">✎ Bearbeiten</button></div>` : ''}
      </div>
      <div id="law-content-${cssSafe(slug)}">
        <div class="law-body ${editor ? '' : 'nocopy'}">${formatBody(law.body)}</div>
        <div class="law-footer">MFG<br>Attorney General Felli Five</div>
      </div>
    </article>`;
  window.scrollTo(0, 0);
  history.replaceState(null, '', '#' + slug);
}

async function copyLaw(slug) {
  if (!isEditor()) return;
  const law = findLaw(slug);
  try { await navigator.clipboard.writeText(`${law.title}\n\n${law.body}`); alert('Text kopiert.'); }
  catch (e) { alert('Kopieren nicht möglich.'); }
}

// ------------------------------------------------------------
// 3. Bearbeiten (Speichern / Veröffentlichen)
// ------------------------------------------------------------
function startEdit(slug) {
  if (!isEditor()) return;
  const law = findLaw(slug);
  const id = cssSafe(slug);
  document.getElementById(`law-content-${id}`).innerHTML = `
    <div class="edit-toolbar">
      <button class="save-btn" onclick="saveEdit('${slug}', false)">Speichern</button>
      <button class="publish-btn" onclick="saveEdit('${slug}', true)">📢 Veröffentlichen</button>
      <button class="cancel-btn" onclick="showLaw('${slug}')">Abbrechen</button>
    </div>
    <p class="edit-hint">Tipp: Eine leere Zeile erzeugt einen Abstand. „Veröffentlichen“ speichert und kündigt die Änderung (vorher/nachher) in Discord an.</p>
    <textarea class="edit-textarea" id="edit-textarea-${id}">${esc(law.body)}</textarea>
    <div id="save-status-${id}" class="save-status"></div>`;
}

async function saveEdit(slug, publish) {
  const id = cssSafe(slug);
  const newBody = document.getElementById(`edit-textarea-${id}`).value;
  const statusEl = document.getElementById(`save-status-${id}`);
  const law = findLaw(slug);
  statusEl.textContent = publish ? 'Speichere und veröffentliche…' : 'Speichere…';
  statusEl.className = 'save-status';
  const r = await api('save-law', { slug, lawCode: law.code, lawTitle: law.title, newBody, publish: !!publish });
  if (!r.ok || !r.data.ok) {
    statusEl.textContent = 'Fehler: ' + (r.data.error || 'Speichern fehlgeschlagen.');
    statusEl.className = 'save-status err';
    return;
  }
  law.body = newBody;
  statusEl.textContent = publish ? 'Gespeichert und veröffentlicht!' : 'Gespeichert!';
  statusEl.className = 'save-status ok';
  setTimeout(() => showLaw(slug), 1200);
}

// ------------------------------------------------------------
// 4. Tickets
// ------------------------------------------------------------
let TICKET_TAB = 'open';

function showTickets() {
  hideAll();
  document.getElementById('ticket-view').hidden = false;
  window.scrollTo(0, 0);
  history.replaceState(null, '', '#tickets');
  renderTickets();
}

async function renderTickets() {
  const view = document.getElementById('ticket-view');
  if (!CURRENT_USER) {
    view.innerHTML = `<div class="law-detail"><button class="back-btn" onclick="showHome()">← Zurück</button>
      <p class="muted">Bitte logge dich mit Discord ein, um Tickets zu nutzen.</p></div>`;
    return;
  }
  const tabs = [['open', 'Offene Tickets'], ['panels', 'Panels'], ['transcripts', 'Verlauf'], ['team', 'Team']];
  view.innerHTML = `<div class="law-detail">
    <button class="back-btn" onclick="showHome()">← Zurück</button>
    <div class="law-detail-head"><div><h1>🎫 Tickets</h1></div>
      <button class="edit-btn" onclick="createTicket()">+ Neues Ticket</button></div>
    <div class="tabs">${tabs.map(([k, n]) => `<button class="tab ${TICKET_TAB === k ? 'active' : ''}" onclick="setTicketTab('${k}')">${n}</button>`).join('')}</div>
    <div id="ticket-body" class="muted">Lade…</div></div>`;
  await renderTicketTab();
}
function setTicketTab(t) { TICKET_TAB = t; renderTickets(); }

async function renderTicketTab() {
  const body = document.getElementById('ticket-body');
  const action = { open: 'list-tickets', panels: 'list-panels', transcripts: 'list-transcripts', team: 'list-staff' }[TICKET_TAB];
  const r = await api('tickets-manage', { action, payload: { status: 'open' } });
  if (r.status === 403) { body.innerHTML = '<p>Die Ticket-Verwaltung ist nur für das Team sichtbar. Du kannst oben trotzdem ein neues Ticket eröffnen.</p>'; return; }
  if (!r.ok) { body.innerHTML = `<p class="err">Fehler: ${esc(r.data.error || 'unbekannt')}</p>`; return; }
  const d = r.data;

  if (TICKET_TAB === 'open') {
    body.innerHTML = !d.tickets.length ? '<p>Keine offenen Tickets.</p>' : d.tickets.map((t) => `
      <div class="row-card"><div><div class="chip-code">#${esc(t.username)}${t.panelName ? ' · ' + esc(t.panelName) : ''}</div>
        <div class="chip-title">${t.claimedBy ? 'Geclaimt von ' + esc(t.claimedBy) : 'Nicht geclaimt'}</div></div>
        <div class="row-actions">
          <a class="cancel-btn" target="_blank" href="https://discord.com/channels/${esc(CFG.DISCORD_GUILD_ID)}/${esc(t.channelId)}">Öffnen</a>
          <button class="cancel-btn" onclick="ticketAction('claim-ticket','${esc(t.id)}')">Claim</button>
          <button class="save-btn" onclick="ticketAction('close-ticket','${esc(t.id)}')">Schließen</button></div></div>`).join('');
  }
  if (TICKET_TAB === 'panels') {
    body.innerHTML = `<div class="row-card form">
        <input id="pn-name" placeholder="Panel-Name"><input id="pn-desc" placeholder="Beschreibung">
        <input id="pn-channel" placeholder="Kanal-ID (wo das Panel erscheint)"><input id="pn-cat" placeholder="Kategorie-ID (optional)">
        <button class="save-btn" onclick="createPanel()">Panel erstellen</button></div>` +
      (d.panels.length ? d.panels.map((p) => `<div class="row-card"><div><div class="chip-code">${esc(p.name)}</div><div class="chip-title">${esc(p.description)}</div></div>
        <button class="cancel-btn" onclick="deletePanel('${esc(p.id)}')">Löschen</button></div>`).join('') : '<p>Noch keine Panels.</p>');
  }
  if (TICKET_TAB === 'transcripts') {
    const r2 = await api('tickets-manage', { action: 'list-transcripts', payload: {} });
    const list = r2.data.tickets || [];
    body.innerHTML = !list.length ? '<p>Noch keine geschlossenen Tickets.</p>' : list.slice().reverse().map((t) => `
      <details class="row-card block"><summary><b>#${esc(t.username)}</b> · geschlossen ${new Date(t.closedAt).toLocaleString('de-DE')} · ${esc(t.closeReason || '')}</summary>
        <div class="transcript">${(t.transcript || []).map((m) => `<div><b>${esc(m.author)}</b> <span class="muted">${new Date(m.timestamp).toLocaleString('de-DE')}</span><br>${esc(m.content)}</div>`).join('') || '<i>Kein Verlauf gespeichert.</i>'}</div></details>`).join('');
  }
  if (TICKET_TAB === 'team') {
    const s = d.staff;
    const row = (id, role) => `<div class="row-card"><span>${esc(id)} <span class="muted">(${role})</span></span><button class="cancel-btn" onclick="staffAction('remove-staff','${esc(id)}','${role}')">Entfernen</button></div>`;
    body.innerHTML = `<div class="row-card form"><input id="st-id" placeholder="Discord-User-ID">
      <select id="st-role"><option value="support">Support</option><option value="admin">Admin</option></select>
      <button class="save-btn" onclick="staffAdd()">Hinzufügen</button></div>
      <p class="muted">Rollen-basierte Teammitglieder (Discord-Rollen) werden hier nicht aufgelistet.</p>` +
      s.admins.map((i) => row(i, 'admin')).join('') + s.support.map((i) => row(i, 'support')).join('');
  }
}

async function createTicket() {
  const r = await api('tickets-create', {});
  if (!r.ok || !r.data.ok) { alert('Fehler: ' + (r.data.error || 'unbekannt')); return; }
  window.open(r.data.url, '_blank');
  renderTickets();
}
async function ticketAction(action, ticketId) {
  if (action === 'close-ticket' && !confirm('Ticket wirklich schließen?')) return;
  const r = await api('tickets-manage', { action, payload: { ticketId } });
  if (!r.ok) alert('Fehler: ' + (r.data.error || 'unbekannt'));
  renderTickets();
}
async function createPanel() {
  const v = (i) => document.getElementById(i).value.trim();
  if (!v('pn-name') || !v('pn-channel')) { alert('Name und Kanal-ID sind Pflicht.'); return; }
  const r = await api('tickets-manage', { action: 'create-panel', payload: { name: v('pn-name'), description: v('pn-desc'), channelId: v('pn-channel'), categoryId: v('pn-cat') || null } });
  if (!r.ok) alert('Fehler: ' + (r.data.error || r.data.message || 'unbekannt'));
  renderTickets();
}
async function deletePanel(panelId) {
  if (!confirm('Panel löschen?')) return;
  await api('tickets-manage', { action: 'delete-panel', payload: { panelId } });
  renderTickets();
}
async function staffAdd() {
  const userId = document.getElementById('st-id').value.trim();
  const role = document.getElementById('st-role').value;
  if (!userId) return;
  const r = await api('tickets-manage', { action: 'add-staff', payload: { userId, role } });
  if (!r.ok) alert('Fehler: ' + (r.data.error || 'unbekannt'));
  renderTickets();
}
async function staffAction(action, userId, role) {
  await api('tickets-manage', { action, payload: { userId, role } });
  renderTickets();
}

// ------------------------------------------------------------
// 5. Discord-Login
// ------------------------------------------------------------
function renderAuthArea() {
  const area = document.getElementById('auth-area');
  if (!CURRENT_USER) {
    area.innerHTML = `<button class="login-btn" onclick="loginWithDiscord()">🔐 Mit Discord einloggen</button>`;
    return;
  }
  area.innerHTML = `<div class="user-chip"><span class="name">${esc(CURRENT_USER.username)}</span>
    ${CURRENT_USER.allowed ? '<span class="role-badge">Editor</span>' : ''}
    <button class="logout-btn" onclick="logout()">Abmelden</button></div>`;
}
function loginWithDiscord() {
  const params = new URLSearchParams({ client_id: CFG.DISCORD_CLIENT_ID, redirect_uri: CFG.DISCORD_REDIRECT_URI, response_type: 'token', scope: 'identify guilds.members.read' });
  window.location.href = `https://discord.com/oauth2/authorize?${params.toString()}`;
}
function logout() {
  CURRENT_USER = null;
  REORDER_MODE = false;
  sessionStorage.removeItem('discord_session');
  renderAuthArea();
  if (SITE_DATA) renderHome();
  showHome();
}
async function handleAuthRedirect() {
  if (location.hash.includes('access_token')) {
    const params = new URLSearchParams(location.hash.substring(1));
    const accessToken = params.get('access_token');
    if (accessToken) { await loginWithToken(accessToken); history.replaceState(null, '', location.pathname); }
    return;
  }
  const saved = sessionStorage.getItem('discord_session');
  if (saved) { try { await loginWithToken(JSON.parse(saved).accessToken, true); } catch (e) { /* ignorieren */ } }
}
async function loginWithToken(accessToken, silent = false) {
  try {
    const meRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!meRes.ok) throw new Error('token invalid');
    const me = await meRes.json();
    const roleRes = await fetch(`${CFG.BACKEND_URL}/api/check-role`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accessToken }) });
    const roleData = await roleRes.json();
    CURRENT_USER = { id: me.id, username: me.username, accessToken, allowed: !!roleData.allowed };
    sessionStorage.setItem('discord_session', JSON.stringify({ accessToken }));
    renderAuthArea();
  } catch (err) {
    if (!silent) alert('Login fehlgeschlagen. Bitte erneut versuchen.');
    sessionStorage.removeItem('discord_session');
  }
}

// ------------------------------------------------------------
// 6. Start
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  renderAuthArea();
  const lawsPromise = loadLaws();
  const authPromise = handleAuthRedirect().then(() => renderAuthArea());
  await lawsPromise;

  const hash = location.hash.replace('#', '');
  if (hash === 'tickets') showTickets();
  else if (hash && findLaw(hash)) showLaw(hash);
  else showHome();

  authPromise.then(() => {
    renderHome();
    const openLaw = document.querySelector('.law-detail[data-slug]');
    if (openLaw && !document.getElementById('law-view').hidden) showLaw(openLaw.dataset.slug);
    if (!document.getElementById('ticket-view').hidden) renderTickets();
  });
});
