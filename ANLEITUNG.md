# 🎮 Discord Dashboard – Setup-Anleitung

---

## Option A: Render.com (kostenlos, online erreichbar)

### Schritt 1 – Discord Bot einrichten

1. Geh auf https://discord.com/developers/applications
2. **„New Application"** → Namen eingeben → **„Create"**
3. Links **„Bot"** → **„Add Bot"** bestätigen
4. **„Token"** → **„Reset Token"** → Token kopieren & sicher aufbewahren
5. Links **„OAuth2" → „General"**:
   - **Client ID** kopieren
   - **Client Secret** kopieren
6. Unter **„Redirects"**: Noch nichts eintragen (kommt nach dem Deploy)

### Schritt 2 – Bot zum Server einladen

1. **„OAuth2" → „URL Generator"**
2. Scopes: `bot`
3. Bot Permissions: **View Channels, Kick Members, Ban Members, Manage Roles, View Audit Log**
4. Generierten Link öffnen → Bot einladen

### Schritt 3 – Auf GitHub pushen

```bash
git init
git add .
git commit -m "Discord Dashboard"
# Neues Repo auf github.com erstellen, dann:
git remote add origin https://github.com/DEIN-NAME/discord-dashboard.git
git push -u origin main
```

### Schritt 4 – Render-Deployment

1. Geh auf https://render.com → kostenlos registrieren
2. **„New +"** → **„Web Service"**
3. GitHub-Repo verbinden → Repository auswählen
4. Einstellungen (Render erkennt meistens alles automatisch durch `render.yaml`):
   - **Name:** z.B. `discord-dashboard`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
5. Unter **„Environment"** die Variablen eintragen:

| Variable | Wert |
|---|---|
| `CLIENT_ID` | Deine Discord Client ID |
| `CLIENT_SECRET` | Dein Discord Client Secret |
| `BOT_TOKEN` | Dein Bot Token |
| `REDIRECT_URI` | `https://DEIN-APP-NAME.onrender.com/auth/callback` |
| `SESSION_SECRET` | (Render generiert automatisch via render.yaml) |

6. **„Create Web Service"** → Warten bis Deploy fertig ist (~2 Min.)

### Schritt 5 – Redirect URI nachtragen

1. Deine Render-URL notieren (z.B. `https://discord-dashboard-abc.onrender.com`)
2. Discord Developer Portal → OAuth2 → Redirects
3. Eintragen: `https://discord-dashboard-abc.onrender.com/auth/callback` → **Save**

✅ Dashboard unter deiner Render-URL erreichbar!

---

## Option B: Lokal (nur du)

```bash
cp .env.example .env
# .env öffnen und Werte eintragen

npm install
npm start
# → http://localhost:3000
```

Redirect URI im Developer Portal: `http://localhost:3000/auth/callback`

---

## Features

| Seite | Was du kannst |
|---|---|
| 📊 Übersicht | Stats, Ban-Vorschau, letzte Mod-Aktionen |
| 🔨 Bans | Alle Bans, suchen, entbannen per Klick |
| 👥 Mitglieder | Alle Member, Rollen sehen, Kick & Ban |
| 🎭 Rollen | Farben, Positionen, Berechtigungen |
| 📋 Audit Log | Die letzten 50 Mod-Aktionen mit Zeitstempel |
| ⚙️ Einstellungen | Verifizierungs-Level, Boost-Status, Server-Infos |

---

## Hinweise zu Render Free

- Der Service **schläft nach 15 Min. Inaktivität** und braucht ~30 Sek. beim ersten Aufruf zum Aufwachen — das ist normal beim kostenlosen Plan.
- Sessions gehen beim Neustart verloren → kurz neu einloggen.
- Upgrade auf **Render Starter ($7/Mo)** vermeidet das Einschlafen.

---

## Häufige Fehler

**„Bans konnten nicht geladen werden"**
→ Bot fehlt die `Ban Members`-Berechtigung oder ist nicht auf dem Server.

**„Keine Server gefunden"**
→ Du hast keine Admin-Rechte (MANAGE_GUILD) auf dem Server.

**OAuth2-Fehler beim Login**
→ Die `REDIRECT_URI` in Render-Umgebungsvariablen und im Discord Developer Portal müssen exakt übereinstimmen.
