// ============================================================
// Gesetzbuch-Seite: Anzeige + Discord-Login + Bearbeiten
// ============================================================

const CFG = window.SITE_CONFIG;
let SITE_DATA = null;   // Inhalt von data/laws.json
let CURRENT_USER = null; // { id, username, allowed }

// ------------------------------------------------------------
// 1. Gesetze laden und Startseite aufbauen
// ------------------------------------------------------------
async function loadLaws() {
  const res = await fetch('data/laws.json', { cache: 'no-store' });
  SITE_DATA = await res.json();
  renderHome();
}

function formatBody(body) {
  // Wandelt reinen Gesetzestext in HTML um (§-Überschriften erkennen)
  const lines = body.split('\n').map((l) => l.trim());
  let html = '';
  let para = [];
  const flush = () => {
    if (para.length) {
      html += `<p>${para.join(' ')}</p>`;
      para = [];
    }
  };
  const headRe = /^(§\s?\d+[a-z]?\s|Buch\s|Kapitel\s|Abschnitt\s|Anlage\s|Teil\s\d|Präambel$|Allgemeine[rs]? Teil$|Besonderer Teil$)/;
  for (const line of lines) {
    if (!line) continue;
    if (headRe.test(line)) {
      flush();
      html += `<h3 class="sec-head">${escapeHtml(line)}</h3>`;
    } else {
      para.push(escapeHtml(line));
    }
  }
  flush();
  return html;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function renderHome() {
  const container = document.getElementById('categories-container');
  document.getElementById('stat-cats').textContent = SITE_DATA.cat_order.length;
  document.getElementById('stat-laws').textContent = SITE_DATA.laws.length;

  let out = '';
  for (const cat of SITE_DATA.cat_order) {
    const lawsInCat = SITE_DATA.laws.filter((l) => l.category === cat);
    if (!lawsInCat.length) continue;
    out += `<section class="cat-section">
      <div class="cat-header">
        <span class="cat-icon">${SITE_DATA.cat_icons[cat] || '📖'}</span>
        <h2>${escapeHtml(cat)}</h2>
        <span class="cat-count">${lawsInCat.length} Gesetze</span>
      </div>
      <div class="law-grid">
        ${lawsInCat.map((l) => `
          <button class="law-chip" onclick="showLaw('${l.slug}')">
            <span class="chip-code">${escapeHtml(l.code)}</span>
            <span class="chip-title">${escapeHtml(l.title)}</span>
          </button>`).join('')}
      </div>
    </section>`;
  }
  container.innerHTML = out;
}

// ------------------------------------------------------------
// 2. Navigation zwischen Übersicht und Gesetzestext
// ------------------------------------------------------------
function showHome() {
  document.getElementById('home-view').hidden = false;
  document.getElementById('law-view').hidden = true;
  window.scrollTo(0, 0);
  history.replaceState(null, '', location.pathname);
}

function findLaw(slug) {
  return SITE_DATA.laws.find((l) => l.slug === slug);
}

function showLaw(slug) {
  const law = findLaw(slug);
  if (!law) return;
  document.getElementById('home-view').hidden = true;
  const view = document.getElementById('law-view');
  view.hidden = false;

  const canEdit = CURRENT_USER && CURRENT_USER.allowed;

  view.innerHTML = `
    <article class="law-detail" data-slug="${slug}">
      <button class="back-btn" onclick="showHome()">← Zurück zur Übersicht</button>
      <div class="law-detail-head">
        <div>
          <span class="law-badge">${escapeHtml(law.category)}</span>
          <h1>${escapeHtml(law.title)}</h1>
        </div>
        ${canEdit ? `<button class="edit-btn" onclick="startEdit('${slug}')">✎ Bearbeiten</button>` : ''}
      </div>
      <div id="law-content-${cssSafe(slug)}">
        <div class="law-body">${formatBody(law.body)}</div>
        <div class="law-footer">MFG<br>Attorney General Felli Five</div>
      </div>
    </article>
  `;
  window.scrollTo(0, 0);
  history.replaceState(null, '', '#' + slug);
}

function cssSafe(slug) { return slug.replace(/[^a-z0-9]/g, ''); }

// ------------------------------------------------------------
// 3. Bearbeiten-Modus
// ------------------------------------------------------------
function startEdit(slug) {
  const law = findLaw(slug);
  const box = document.getElementById(`law-content-${cssSafe(slug)}`);
  box.innerHTML = `
    <div class="edit-toolbar">
      <button class="save-btn" onclick="saveEdit('${slug}')">Speichern</button>
      <button class="cancel-btn" onclick="showLaw('${slug}')">Abbrechen</button>
    </div>
    <textarea class="edit-textarea" id="edit-textarea-${cssSafe(slug)}">${law.body}</textarea>
    <div id="save-status-${cssSafe(slug)}" class="save-status"></div>
  `;
}

async function saveEdit(slug) {
  const textarea = document.getElementById(`edit-textarea-${cssSafe(slug)}`);
  const statusEl = document.getElementById(`save-status-${cssSafe(slug)}`);
  const newBody = textarea.value;
  const law = findLaw(slug);

  statusEl.textContent = 'Speichere…';
  statusEl.className = 'save-status';

  try {
    const res = await fetch(`${CFG.BACKEND_URL}/save-law`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: CURRENT_USER.accessToken,
        slug,
        lawCode: law.code,
        lawTitle: law.title,
        newBody,
      }),
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      statusEl.textContent = 'Fehler: ' + (data.error || 'Speichern fehlgeschlagen.');
      statusEl.className = 'save-status err';
      return;
    }

    // Lokal sofort aktualisieren, damit man die Änderung direkt sieht
    law.body = newBody;
    statusEl.textContent = 'Gespeichert! Die Änderung wurde ins Repository geschrieben.';
    statusEl.className = 'save-status ok';
    setTimeout(() => showLaw(slug), 1200);
  } catch (err) {
    statusEl.textContent = 'Verbindung zum Server fehlgeschlagen.';
    statusEl.className = 'save-status err';
  }
}

// ------------------------------------------------------------
// 4. Discord Login (Implicit Grant – kein Server-Secret nötig)
// ------------------------------------------------------------
function renderAuthArea() {
  const area = document.getElementById('auth-area');
  if (!CURRENT_USER) {
    area.innerHTML = `<button class="login-btn" onclick="loginWithDiscord()">🔐 Mit Discord einloggen</button>`;
    return;
  }
  area.innerHTML = `
    <div class="user-chip">
      <span class="name">${escapeHtml(CURRENT_USER.username)}</span>
      ${CURRENT_USER.allowed ? '<span class="role-badge">Editor</span>' : ''}
      <button class="logout-btn" onclick="logout()">Abmelden</button>
    </div>
  `;
}

function loginWithDiscord() {
  const params = new URLSearchParams({
    client_id: CFG.DISCORD_CLIENT_ID,
    redirect_uri: CFG.DISCORD_REDIRECT_URI,
    response_type: 'token',
    scope: 'identify',
  });
  window.location.href = `https://discord.com/oauth2/authorize?${params.toString()}`;
}

function logout() {
  CURRENT_USER = null;
  sessionStorage.removeItem('discord_session');
  renderAuthArea();
  showHome();
}

async function handleAuthRedirect() {
  // Discord hängt das Token als #access_token=... an die URL an
  if (location.hash.includes('access_token')) {
    const params = new URLSearchParams(location.hash.substring(1));
    const accessToken = params.get('access_token');
    if (accessToken) {
      await loginWithToken(accessToken);
      // Hash bereinigen, aber Slug (falls vorhanden) verlieren wir hier bewusst -> zurück zur Startseite
      history.replaceState(null, '', location.pathname);
    }
    return;
  }

  // Session aus vorherigem Login wiederherstellen
  const saved = sessionStorage.getItem('discord_session');
  if (saved) {
    try {
      const { accessToken } = JSON.parse(saved);
      await loginWithToken(accessToken, true);
    } catch (e) { /* ignore */ }
  }
}

async function loginWithToken(accessToken, silent = false) {
  try {
    const meRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!meRes.ok) throw new Error('token invalid');
    const me = await meRes.json();

    const roleRes = await fetch(`${CFG.BACKEND_URL}/check-role`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    const roleData = await roleRes.json();

    CURRENT_USER = {
      id: me.id,
      username: me.username,
      accessToken,
      allowed: !!roleData.allowed,
    };
    sessionStorage.setItem('discord_session', JSON.stringify({ accessToken }));
    renderAuthArea();
  } catch (err) {
    if (!silent) alert('Login fehlgeschlagen. Bitte erneut versuchen.');
    sessionStorage.removeItem('discord_session');
  }
}

// ------------------------------------------------------------
// 5. Start
// ------------------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  renderAuthArea();
  await handleAuthRedirect();
  renderAuthArea();
  await loadLaws();

  const hash = location.hash.replace('#', '');
  if (hash && findLaw(hash)) {
    showLaw(hash);
  } else {
    showHome();
  }
});
