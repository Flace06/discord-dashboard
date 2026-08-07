// config.js – Dateibasierter Konfigurationsmanager
const fs   = require('fs');
const path = require('path');

const CONFIG_FILE  = path.join(__dirname, 'config.json');
const TICKETS_FILE = path.join(__dirname, 'tickets.json');

function readJSON(file, def) {
  try {
    if (!fs.existsSync(file)) { fs.writeFileSync(file, JSON.stringify(def, null, 2)); return def; }
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return def; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

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
  getConfig:  () => readJSON(CONFIG_FILE,  { guilds: {} }),
  saveConfig: (d) => writeJSON(CONFIG_FILE, d),
  getTickets: () => readJSON(TICKETS_FILE, {}),
  saveTickets:(d) => writeJSON(TICKETS_FILE, d),

  getGuild(guildId) {
    const c = this.getConfig();
    if (!c.guilds[guildId]) { c.guilds[guildId] = defaultGuildConfig(); this.saveConfig(c); }
    return c.guilds[guildId];
  },

  saveGuild(guildId, guildCfg) {
    const c = this.getConfig();
    c.guilds[guildId] = guildCfg;
    this.saveConfig(c);
  },

  getTicket(channelId) {
    return this.getTickets()[channelId] || null;
  },

  saveTicket(channelId, ticket) {
    const t = this.getTickets();
    t[channelId] = ticket;
    this.saveTickets(t);
  },

  deleteTicket(channelId) {
    const t = this.getTickets();
    delete t[channelId];
    this.saveTickets(t);
  },

  getGuildTickets(guildId) {
    const t = this.getTickets();
    return Object.entries(t)
      .filter(([, v]) => v.guildId === guildId)
      .map(([channelId, v]) => ({ channelId, ...v }));
  },

  defaultGuildConfig,
};

module.exports = cfg;
