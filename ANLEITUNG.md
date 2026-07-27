# ─────────────────────────────────────────────────────────────────────────────
#  Discord Dashboard – Konfiguration (lokal)
#  Für Render.com: Werte direkt im Render-Dashboard unter "Environment" eintragen
#  Lokal: cp .env.example .env  →  Werte eintragen  →  npm start
# ─────────────────────────────────────────────────────────────────────────────

# Discord Developer Portal → Applications → OAuth2
CLIENT_ID=DEINE_CLIENT_ID_HIER
CLIENT_SECRET=DEIN_CLIENT_SECRET_HIER

# Discord Developer Portal → Applications → Bot → Token
BOT_TOKEN=DEIN_BOT_TOKEN_HIER

# Irgendein langer zufälliger String
SESSION_SECRET=ein_sehr_langer_zufaelliger_string_hier

# LOKAL: 3000  |  RENDER: wird automatisch von Render gesetzt
PORT=3000

# LOKAL:  http://localhost:3000/auth/callback
# RENDER: https://DEIN-APP-NAME.onrender.com/auth/callback
REDIRECT_URI=http://localhost:3000/auth/callback
