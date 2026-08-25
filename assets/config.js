// ============================================================
// Öffentliche Konfiguration – diese Werte sind NICHT geheim
// und dürfen im Frontend/GitHub-Repo sichtbar sein.
// ============================================================
window.SITE_CONFIG = {
  // Discord Developer Portal -> OAuth2 -> General -> "CLIENT ID"
  DISCORD_CLIENT_ID: "DEINE_CLIENT_ID_HIER",

  // Muss EXAKT mit einer "Redirect" URL im Developer Portal übereinstimmen.
  // Für GitHub Pages z.B.: https://deinname.github.io/dein-repo/
  DISCORD_REDIRECT_URI: window.location.origin + window.location.pathname,

  // Adresse deines Backend-Servers (Railway/Render), OHNE Slash am Ende.
  // Lokal zum Testen z.B.: http://localhost:4000
  BACKEND_URL: "https://DEIN-BACKEND.up.railway.app",
};
