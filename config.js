// config.js – Turso (libSQL/SQLite) backed config mit In-Memory-Cache
//
// Beim Start:  await cfg.init()  → erstellt Tabellen + lädt alle Daten in den Cache
// Danach:      getGuild / saveGuild / getTicket / … sind synchron (Cache)
//              Schreiboperationen persistieren im Hintergrund zu Turso
//
// Fallback:    Falls TURSO_URL nicht gesetzt ist → JSON-Dateien (lokales Dev)

const fs   = require('fs');
const path = require('path');

// ── Fallback: Datei-basiert ──────────────────────────────────
const CONFIG_FILE  = path.join(__dirname, 'config.json');
const TICKETS_FILE = path.join(__dirname, 'tickets.json');

function readJSON(file, def) {
  try {
    if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return def; }
}
function writeJSON(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch {}
}

// ── In-Memory-Cache ──────────────────────────────────────────
const guildsCache  = new Map(); // guildId   → guildConfig object
const ticketsCache = new Map(); // channelId → ticket object

// ── Turso-Verbindung (lazy) ──────────────────────────────────
let db = null;
function getDb() {
  if (db) return db;
  const { createClient } = require('@libsql/client');
  db = createClient({
    url:       process.env.TURSO_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  return db;
}

async function dbExec(sql, args = []) {
  try {
    return await getDb().execute({ sql, args });
  } catch (e) {
    console.error('[DB] Fehler:', e.message, '|', sql.slice(0, 60));
    throw e;
  }
}

// ── Tabellen erstellen + Daten laden ────────────────────────
async function initDb() {
  await dbExec(`
    CREATE TABLE IF NOT EXISTS guild_configs (
      guild_id   TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);
  await dbExec(`
    CREATE TABLE IF NOT EXISTS tickets (
      channel_id TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Guilds in Cache laden
  const gr = await dbExec('SELECT guild_id, data FROM guild_configs');
  for (const row of gr.rows) {
    try { guildsCache.set(row.guild_id, JSON.parse(row.data)); } catch {}
  }

  // Tickets in Cache laden
  const tr = await dbExec('SELECT channel_id, data FROM tickets');
  for (const row of tr.rows) {
    try { ticketsCache.set(row.channel_id, JSON.parse(row.data)); } catch {}
  }

  console.log(`[DB] ✅ Turso verbunden – ${guildsCache.size} Guild(s), ${ticketsCache.size} Ticket(s) geladen`);
}

const USE_DB = !!process.env.TURSO_URL;

// ════════════════════════════════════════════════════════════
//  PUBLIC API
// ════════════════════════════════════════════════════════════

function defaultGuildConfig() {
  return {
    categories: [{
      id: 'cat_default',
      name: 'Support',
      emoji: '🎫',
      description: 'Allgemeiner Support',
      supportRoles: [],
      channelPrefix: 'ticket',
      parentCategory: null,
      welcomeMessage: 'Willkommen {user}! 👋\n\nEin Teammitglied wird sich bald um dein Anliegen kümmern.\nBitte beschreibe dein Problem so detailliert wie möglich.',
      panelTitle: '🎫 Support Tickets',
      panelDescription: 'Klicke auf den Button unten, um ein Support-Ticket zu erstellen.\nUnser Team hilft dir so schnell wie möglich!',
      panelColor: 5814783,
      buttonLabel: 'Ticket erstellen',
      buttonStyle: 1,
      buttonEmoji: '🎫',
    }],
    buttons: { claim: true, close: true, forward: true, addUser: true, priority: true },
    logChannel: null,
    autoClose: { enabled: false, hours: 48 },
    priorities: ['🟢 Niedrig', '🟡 Mittel', '🔴 Hoch', '⚡ Kritisch'],
    naming: '{prefix}-{counter}',
    closeMessage: 'Dieses Ticket wurde geschlossen. Der Kanal wird in 5 Sekunden gelöscht.',
    ticketCounter: 0,
  };
}

const cfg = {

  // ── Init ────────────────────────────────────────────────────
  async init() {
    if (USE_DB) {
      await initDb();
    } else {
      const c = readJSON(CONFIG_FILE,  { guilds: {} });
      const t = readJSON(TICKETS_FILE, {});
      for (const [id, data] of Object.entries(c.guilds || {})) guildsCache.set(id, data);
      for (const [id, data] of Object.entries(t))             ticketsCache.set(id, data);
      console.log('[Config] Datei-Modus (kein TURSO_URL gesetzt)');
    }
  },

  // ── Guild Config ─────────────────────────────────────────────
  getGuild(guildId) {
    if (!guildsCache.has(guildId)) {
      const def = defaultGuildConfig();
      guildsCache.set(guildId, def);
      this.saveGuild(guildId, def);
    }
    return guildsCache.get(guildId);
  },

  saveGuild(guildId, guildCfg) {
    guildsCache.set(guildId, guildCfg);
    if (USE_DB) {
      dbExec(
        `INSERT INTO guild_configs (guild_id, data) VALUES (?, ?)
         ON CONFLICT(guild_id) DO UPDATE SET data = excluded.data, updated_at = unixepoch()`,
        [guildId, JSON.stringify(guildCfg)]
      ).catch(e => console.error('[DB] saveGuild:', e.message));
    } else {
      const all = {};
      for (const [id, d] of guildsCache) all[id] = d;
      writeJSON(CONFIG_FILE, { guilds: all });
    }
  },

  // ── Tickets ───────────────────────────────────────────────────
  getTicket(channelId) {
    return ticketsCache.get(channelId) || null;
  },

  saveTicket(channelId, ticket) {
    ticketsCache.set(channelId, ticket);
    if (USE_DB) {
      dbExec(
        `INSERT INTO tickets (channel_id, data) VALUES (?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET data = excluded.data, updated_at = unixepoch()`,
        [channelId, JSON.stringify(ticket)]
      ).catch(e => console.error('[DB] saveTicket:', e.message));
    } else {
      const all = {};
      for (const [id, d] of ticketsCache) all[id] = d;
      writeJSON(TICKETS_FILE, all);
    }
  },

  deleteTicket(channelId) {
    ticketsCache.delete(channelId);
    if (USE_DB) {
      dbExec('DELETE FROM tickets WHERE channel_id = ?', [channelId])
        .catch(e => console.error('[DB] deleteTicket:', e.message));
    } else {
      const all = {};
      for (const [id, d] of ticketsCache) all[id] = d;
      writeJSON(TICKETS_FILE, all);
    }
  },

  getGuildTickets(guildId) {
    const result = [];
    for (const [channelId, v] of ticketsCache) {
      if (v.guildId === guildId) result.push({ channelId, ...v });
    }
    return result;
  },

  // Rückwärtskompatible Aliases
  getConfig()    { return { guilds: Object.fromEntries(guildsCache) }; },
  getTickets()   { return Object.fromEntries(ticketsCache); },
  saveConfig(d)  { for (const [id, g] of Object.entries(d.guilds || {})) this.saveGuild(id, g); },
  saveTickets(d) { for (const [id, t] of Object.entries(d)) this.saveTicket(id, t); },

  defaultGuildConfig,
};

module.exports = cfg;
