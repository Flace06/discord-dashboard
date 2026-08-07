// ============================================================
//  Discord Dashboard – server.js
//  Requires Node.js 18+, express, express-session, dotenv, discord.js
// ============================================================

const express  = require('express');
const session  = require('express-session');
const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;
const API  = 'https://discord.com/api/v10';

const CLIENT_ID      = process.env.CLIENT_ID;
const CLIENT_SECRET  = process.env.CLIENT_SECRET;
const BOT_TOKEN      = process.env.BOT_TOKEN;
const REDIRECT_URI   = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';

// ── Bot Gateway (zeigt Bot als online) ──────────────────────
if (BOT_TOKEN) {
  const bot = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,   // Privileged – im Dev Portal aktivieren!
    ],
  });
  bot.once('ready', () => {
    console.log(`🤖 Bot online als ${bot.user.tag}`);
    bot.user.setActivity('Server Dashboard', { type: ActivityType.Watching });
  });
  bot.login(BOT_TOKEN).catch(e => {
    console.warn('⚠️  Bot-Login fehlgeschlagen:', e.message);
    console.warn('   → Prüfe den BOT_TOKEN in den Umgebungsvariablen.');
  });
}

// ── Middleware ──────────────────────────────────────────────
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Helpers ─────────────────────────────────────────────────
async function discordBot(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bot ${BOT_TOKEN}`,
      'Content-Type': 'application/json',
      ...opts.headers,
    },
  });
  if (res.status === 204) return { success: true };
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || 'Discord API error'), { status: res.status, data });
  return data;
}

async function discordUser(token, path) {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.message || 'Discord API error'), { status: res.status });
  return data;
}

const requireAuth = (req, res, next) => {
  if (!req.session.token) return res.status(401).json({ error: 'Nicht eingeloggt' });
  next();
};

// ── Auth ─────────────────────────────────────────────────────
app.get('/auth/login', (req, res) => {
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'identify guilds',
  });
  res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) return res.redirect('/?error=auth_denied');
  try {
    const tokenRes = await fetch(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI,
      }),
    });
    const data = await tokenRes.json();
    if (data.error) throw new Error(data.error_description || data.error);
    req.session.token = data.access_token;
    res.redirect('/app');
  } catch (e) {
    console.error('Auth error:', e.message);
    res.redirect('/?error=auth_failed');
  }
});

app.get('/auth/logout', (req, res) => { req.session.destroy(() => res.redirect('/')); });
app.get('/auth/status', (req, res) => { res.json({ loggedIn: !!req.session.token }); });

// ── User / Guilds ─────────────────────────────────────────────
app.get('/api/me', requireAuth, async (req, res) => {
  try { res.json(await discordUser(req.session.token, '/users/@me')); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/guilds', requireAuth, async (req, res) => {
  try {
    const guilds = await discordUser(req.session.token, '/users/@me/guilds');
    res.json(guilds.filter(g => (BigInt(g.permissions) & BigInt(0x20)) === BigInt(0x20)));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.get('/api/guilds/:id', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}?with_counts=true`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Bans ──────────────────────────────────────────────────────
app.get('/api/guilds/:id/bans', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/bans?limit=1000`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.put('/api/guilds/:id/bans/:userId', requireAuth, async (req, res) => {
  try {
    res.json(await discordBot(`/guilds/${req.params.id}/bans/${req.params.userId}`, {
      method: 'PUT',
      body: JSON.stringify({ reason: req.body?.reason || 'Via Dashboard gebannt' }),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/bans/:userId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/bans/${req.params.userId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Members ───────────────────────────────────────────────────
app.get('/api/guilds/:id/members', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/members?limit=1000`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/members/:userId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/members/${req.params.userId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Roles ─────────────────────────────────────────────────────
app.get('/api/guilds/:id/roles', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/roles`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/guilds/:id/roles', requireAuth, async (req, res) => {
  try {
    res.json(await discordBot(`/guilds/${req.params.id}/roles`, {
      method: 'POST',
      body: JSON.stringify({
        name:        req.body.name        || 'Neue Rolle',
        color:       req.body.color       || 0,
        hoist:       req.body.hoist       || false,
        mentionable: req.body.mentionable || false,
        permissions: req.body.permissions || '0',
      }),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.patch('/api/guilds/:id/roles/:roleId', requireAuth, async (req, res) => {
  try {
    const body = {};
    if (req.body.name        !== undefined) body.name        = req.body.name;
    if (req.body.color       !== undefined) body.color       = req.body.color;
    if (req.body.permissions !== undefined) body.permissions = req.body.permissions;
    if (req.body.hoist       !== undefined) body.hoist       = req.body.hoist;
    if (req.body.mentionable !== undefined) body.mentionable = req.body.mentionable;
    res.json(await discordBot(`/guilds/${req.params.id}/roles/${req.params.roleId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/roles/:roleId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/roles/${req.params.roleId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Channels ──────────────────────────────────────────────────
app.get('/api/guilds/:id/channels', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/channels`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/guilds/:id/channels', requireAuth, async (req, res) => {
  try {
    res.json(await discordBot(`/guilds/${req.params.id}/channels`, {
      method: 'POST',
      body: JSON.stringify({
        name:      (req.body.name || 'neuer-kanal').toLowerCase().replace(/\s+/g, '-'),
        type:      req.body.type      ?? 0,
        parent_id: req.body.parent_id || null,
        topic:     req.body.topic     || null,
      }),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.patch('/api/guilds/:id/channels/:channelId', requireAuth, async (req, res) => {
  try {
    const body = {};
    if (req.body.name  !== undefined) body.name  = req.body.name;
    if (req.body.topic !== undefined) body.topic = req.body.topic;
    res.json(await discordBot(`/channels/${req.params.channelId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/channels/:channelId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/channels/${req.params.channelId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Audit Log ─────────────────────────────────────────────────
app.get('/api/guilds/:id/audit-logs', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/audit-logs?limit=50`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── Messages ───────────────────────────────────────────────────
app.post('/api/guilds/:id/channels/:channelId/messages', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Nachrichteninhalt fehlt' });
  try {
    res.json(await discordBot(`/channels/${req.params.channelId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content: content.trim() }),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ── SPA ───────────────────────────────────────────────────────
app.get('/app', (req, res) => res.sendFile(__dirname + '/public/index.html'));

// ── Start ─────────────────────────────────────────────────────
const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';
app.listen(PORT, HOST, () => {
  const url = HOST === '0.0.0.0' ? `Port ${PORT} (Render)` : `http://localhost:${PORT}`;
  console.log(`\n🎮  Discord Dashboard läuft auf ${url}\n`);
});
