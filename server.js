// ============================================================
//  Discord Dashboard + Ticket System – server.js
//  Requires Node.js 18+, express, express-session, dotenv, discord.js
// ============================================================

const express  = require('express');
const session  = require('express-session');
const {
  Client, GatewayIntentBits, ActivityType,
  ButtonBuilder, ButtonStyle, ActionRowBuilder,
  EmbedBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  AttachmentBuilder, REST, Routes,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const cfg = require('./config');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;
const API  = 'https://discord.com/api/v10';

const CLIENT_ID      = process.env.CLIENT_ID;
const CLIENT_SECRET  = process.env.CLIENT_SECRET;
const BOT_TOKEN      = process.env.BOT_TOKEN;
const REDIRECT_URI   = process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-please';

// ── Auto-close timer store ───────────────────────────────────
const autoCloseTimers = new Map();

// ── Slash commands definition ────────────────────────────────
const SLASH_COMMANDS = [
  {
    name: 'ticket',
    description: 'Ticket-Befehle',
    options: [
      { name: 'close',  type: 1, description: 'Dieses Ticket schließen' },
      { name: 'claim',  type: 1, description: 'Dieses Ticket beanspruchen' },
      { name: 'add',    type: 1, description: 'Nutzer zum Ticket hinzufügen',
        options: [{ name: 'user', type: 6, description: 'Nutzer', required: true }] },
      { name: 'remove', type: 1, description: 'Nutzer aus Ticket entfernen',
        options: [{ name: 'user', type: 6, description: 'Nutzer', required: true }] },
      { name: 'rename', type: 1, description: 'Ticket umbenennen',
        options: [{ name: 'name', type: 3, description: 'Neuer Name', required: true }] },
    ],
  },
];

// ── Discord Client (module-level so ticket routes can access) ─
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once('ready', async () => {
  console.log(`🤖 Bot online als ${client.user.tag}`);
  client.user.setActivity('Server Dashboard', { type: ActivityType.Watching });

  // Register slash commands globally
  if (CLIENT_ID) {
    try {
      const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: SLASH_COMMANDS });
      console.log('✅ Slash-Commands registriert');
    } catch (e) {
      console.warn('⚠️ Slash-Command-Registrierung fehlgeschlagen:', e.message);
    }
  }

  restartAutoCloseTimers();
});

// ── Interaction router ───────────────────────────────────────
client.on('interactionCreate', async interaction => {
  try {
    if      (interaction.isChatInputCommand()) await handleSlashCommand(interaction);
    else if (interaction.isButton())           await handleButton(interaction);
    else if (interaction.isStringSelectMenu()) await handleStringSelect(interaction);
    else if (interaction.isUserSelectMenu())   await handleUserSelect(interaction);
  } catch (e) {
    console.error('Interaction error:', e);
    try {
      const reply = { content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    } catch {}
  }
});

// Track message activity for auto-close
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const ticket = cfg.getTicket(msg.channel.id);
  if (!ticket) return;
  ticket.lastActivity = Date.now();
  cfg.saveTicket(msg.channel.id, ticket);
  const guildCfg = cfg.getGuild(msg.guild.id);
  if (guildCfg.autoClose?.enabled) scheduleAutoClose(msg.channel.id, ticket, guildCfg);
});

// ── Slash command handler ────────────────────────────────────
async function handleSlashCommand(interaction) {
  const sub = interaction.options.getSubcommand();
  const ticket = cfg.getTicket(interaction.channel.id);

  if (sub === 'close') {
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket-Kanal.', ephemeral: true });
    await interaction.reply({ content: '🔒 Ticket wird geschlossen…' });
    await closeTicket(interaction.channel, ticket, `Geschlossen von ${interaction.user.tag}`);

  } else if (sub === 'claim') {
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket-Kanal.', ephemeral: true });
    ticket.claimedBy = interaction.user.id;
    ticket.claimedByName = interaction.user.tag;
    cfg.saveTicket(interaction.channel.id, ticket);
    await interaction.reply({ content: `✅ Ticket wurde von ${interaction.user} beansprucht.` });

  } else if (sub === 'add') {
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket-Kanal.', ephemeral: true });
    const user = interaction.options.getUser('user');
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    });
    await interaction.reply({ content: `✅ ${user} wurde zum Ticket hinzugefügt.` });

  } else if (sub === 'remove') {
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket-Kanal.', ephemeral: true });
    const user = interaction.options.getUser('user');
    await interaction.channel.permissionOverwrites.delete(user.id);
    await interaction.reply({ content: `✅ ${user} wurde aus dem Ticket entfernt.` });

  } else if (sub === 'rename') {
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket-Kanal.', ephemeral: true });
    const name = interaction.options.getString('name');
    await interaction.channel.setName(name);
    await interaction.reply({ content: `✅ Ticket wurde in **${name}** umbenannt.` });
  }
}

// ── Button handler ───────────────────────────────────────────
async function handleButton(interaction) {
  const id = interaction.customId;

  if (id.startsWith('ticket_create_')) {
    const categoryId = id.replace('ticket_create_', '');
    await handleCreateTicket(interaction, categoryId);

  } else if (id === 'ticket_close') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    const guildCfg = cfg.getGuild(interaction.guild.id);
    await interaction.reply({ content: `🔒 ${guildCfg.closeMessage || 'Ticket wird geschlossen…'}` });
    await closeTicket(interaction.channel, ticket, `Geschlossen von ${interaction.user.tag}`);

  } else if (id === 'ticket_claim') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    ticket.claimedBy = interaction.user.id;
    ticket.claimedByName = interaction.user.tag;
    cfg.saveTicket(interaction.channel.id, ticket);
    await interaction.reply({ content: `✅ ${interaction.user} hat dieses Ticket beansprucht.` });

  } else if (id === 'ticket_priority') {
    const guildCfg = cfg.getGuild(interaction.guild.id);
    const options = (guildCfg.priorities || ['🟢 Niedrig', '🟡 Mittel', '🔴 Hoch', '⚡ Kritisch'])
      .map((p, i) => ({ label: p, value: `priority_${i}` }));
    const select = new StringSelectMenuBuilder()
      .setCustomId('select_priority')
      .setPlaceholder('Priorität auswählen')
      .addOptions(options);
    await interaction.reply({
      content: '📊 Priorität auswählen:',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });

  } else if (id === 'ticket_forward') {
    const guildCfg = cfg.getGuild(interaction.guild.id);
    const options = guildCfg.categories.map(cat => ({
      label: `${cat.emoji || '🎫'} ${cat.name}`,
      value: `forward_${cat.id}`,
      description: (cat.description || '').slice(0, 50),
    }));
    if (!options.length) return interaction.reply({ content: '❌ Keine Kategorien verfügbar.', ephemeral: true });
    const select = new StringSelectMenuBuilder()
      .setCustomId('select_forward')
      .setPlaceholder('Ziel-Kategorie auswählen')
      .addOptions(options);
    await interaction.reply({
      content: '↗️ An welche Kategorie weiterleiten?',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });

  } else if (id === 'ticket_add_user') {
    const select = new UserSelectMenuBuilder()
      .setCustomId('select_add_user')
      .setPlaceholder('Nutzer auswählen');
    await interaction.reply({
      content: '👤 Nutzer zum Ticket hinzufügen:',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });
  }
}

// ── String select handler ────────────────────────────────────
async function handleStringSelect(interaction) {
  const id = interaction.customId;

  if (id === 'select_priority') {
    const guildCfg = cfg.getGuild(interaction.guild.id);
    const idx = parseInt(interaction.values[0].replace('priority_', ''));
    const priorityLabel = (guildCfg.priorities || [])[idx] || 'Normal';
    const ticket = cfg.getTicket(interaction.channel.id);
    if (ticket) { ticket.priority = priorityLabel; cfg.saveTicket(interaction.channel.id, ticket); }
    await interaction.update({ content: `✅ Priorität auf **${priorityLabel}** gesetzt.`, components: [] });

  } else if (id === 'select_forward') {
    const categoryId = interaction.values[0].replace('forward_', '');
    const guildCfg   = cfg.getGuild(interaction.guild.id);
    const cat = guildCfg.categories.find(c => c.id === categoryId);
    if (!cat) return interaction.update({ content: '❌ Kategorie nicht gefunden.', components: [] });

    const ticket = cfg.getTicket(interaction.channel.id);
    if (ticket) {
      ticket.categoryId = categoryId;
      ticket.categoryName = cat.name;
      cfg.saveTicket(interaction.channel.id, ticket);
    }
    if (cat.supportRoles?.length) {
      for (const roleId of cat.supportRoles) {
        await interaction.channel.permissionOverwrites.edit(roleId, {
          ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
        });
      }
    }
    await interaction.update({ content: `✅ Ticket an **${cat.name}** weitergeleitet.`, components: [] });
    await interaction.channel.send({ content: `📨 Dieses Ticket wurde an **${cat.name}** weitergeleitet.` });
  }
}

// ── User select handler ──────────────────────────────────────
async function handleUserSelect(interaction) {
  if (interaction.customId === 'select_add_user') {
    const user = interaction.users.first();
    if (!user) return interaction.update({ content: '❌ Kein Nutzer ausgewählt.', components: [] });
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    });
    await interaction.update({ content: `✅ ${user} wurde zum Ticket hinzugefügt.`, components: [] });
    await interaction.channel.send({ content: `👤 ${user} wurde von ${interaction.user} zum Ticket hinzugefügt.` });
  }
}

// ── Create ticket ────────────────────────────────────────────
async function handleCreateTicket(interaction, categoryId) {
  await interaction.deferReply({ ephemeral: true });
  const guildCfg = cfg.getGuild(interaction.guild.id);
  const cat = guildCfg.categories.find(c => c.id === categoryId) || guildCfg.categories[0];
  if (!cat) return interaction.editReply({ content: '❌ Kategorie nicht gefunden.' });

  // Check existing open ticket
  const existing = cfg.getGuildTickets(interaction.guild.id)
    .find(t => t.userId === interaction.user.id && t.categoryId === categoryId);
  if (existing) {
    const existCh = interaction.guild.channels.cache.get(existing.channelId);
    if (existCh) return interaction.editReply({ content: `❌ Du hast bereits ein offenes Ticket: ${existCh}` });
    // stale entry – remove it
    cfg.deleteTicket(existing.channelId);
  }

  // Increment counter
  guildCfg.ticketCounter = (guildCfg.ticketCounter || 0) + 1;
  cfg.saveGuild(interaction.guild.id, guildCfg);

  const counter  = String(guildCfg.ticketCounter).padStart(4, '0');
  const chName   = (guildCfg.naming || '{prefix}-{counter}')
    .replace('{prefix}',  cat.channelPrefix || 'ticket')
    .replace('{counter}', counter)
    .replace('{user}',    interaction.user.username)
    .toLowerCase()
    .replace(/[^a-z0-9\-]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 100);

  // Permission overwrites
  const overwrites = [
    { id: interaction.guild.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id,  allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] },
    { id: client.user.id,       allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
  ];
  for (const roleId of (cat.supportRoles || [])) {
    overwrites.push({ id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] });
  }

  const channel = await interaction.guild.channels.create({
    name: chName,
    type: ChannelType.GuildText,
    parent: cat.parentCategory || null,
    permissionOverwrites: overwrites,
    topic: `Ticket von ${interaction.user.tag} | ${cat.name}`,
  });

  const ticket = {
    guildId:       interaction.guild.id,
    channelId:     channel.id,
    userId:        interaction.user.id,
    userName:      interaction.user.tag,
    categoryId:    cat.id,
    categoryName:  cat.name,
    priority:      null,
    claimedBy:     null,
    claimedByName: null,
    createdAt:     new Date().toISOString(),
    lastActivity:  Date.now(),
  };
  cfg.saveTicket(channel.id, ticket);

  // Welcome embed
  const welcome = (cat.welcomeMessage || 'Willkommen {user}! 👋\n\nEin Teammitglied wird sich bald um dich kümmern.')
    .replace('{user}',     `<@${interaction.user.id}>`)
    .replace('{category}', cat.name)
    .replace('{counter}',  counter);

  const embed = new EmbedBuilder()
    .setTitle(`${cat.emoji || '🎫'} ${cat.name}`)
    .setDescription(welcome)
    .setColor(cat.panelColor || 0x5865f2)
    .setTimestamp()
    .setFooter({ text: `Ticket #${counter} • ${cat.name}` });

  await channel.send({ embeds: [embed], components: buildTicketButtons(guildCfg) });
  await interaction.editReply({ content: `✅ Dein Ticket wurde erstellt: ${channel}` });

  // Log
  if (guildCfg.logChannel) {
    try {
      const logCh = await client.channels.fetch(guildCfg.logChannel).catch(() => null);
      if (logCh) {
        await logCh.send({ embeds: [new EmbedBuilder()
          .setTitle('🎫 Ticket erstellt')
          .setDescription(`**Nutzer:** ${interaction.user}\n**Kanal:** ${channel}\n**Kategorie:** ${cat.name}`)
          .setColor(0x57f287).setTimestamp()
        ]});
      }
    } catch {}
  }

  if (guildCfg.autoClose?.enabled) scheduleAutoClose(channel.id, ticket, guildCfg);
}

// ── Close ticket ─────────────────────────────────────────────
async function closeTicket(channel, ticket, reason) {
  const guildCfg = cfg.getGuild(ticket.guildId);

  // Send transcript to log channel
  if (guildCfg.logChannel) {
    try {
      const logCh = await client.channels.fetch(guildCfg.logChannel).catch(() => null);
      if (logCh) await sendTranscriptToLog(channel, ticket, reason, logCh);
    } catch {}
  }

  cfg.deleteTicket(channel.id);
  if (autoCloseTimers.has(channel.id)) {
    clearTimeout(autoCloseTimers.get(channel.id));
    autoCloseTimers.delete(channel.id);
  }

  setTimeout(() => channel.delete().catch(() => {}), 5000);
}

// ── Transcript ───────────────────────────────────────────────
async function sendTranscriptToLog(channel, ticket, reason, logChannel) {
  try {
    const fetched  = await channel.messages.fetch({ limit: 100 });
    const messages = [...fetched.values()].reverse();
    const html     = generateTranscriptHTML(channel, ticket, messages, reason);
    const attachment = new AttachmentBuilder(
      Buffer.from(html, 'utf8'),
      { name: `transcript-${channel.name}.html` }
    );
    await logChannel.send({
      embeds: [new EmbedBuilder()
        .setTitle('📋 Ticket Transcript')
        .setDescription([
          `**Ticket:** ${channel.name}`,
          `**Nutzer:** ${ticket.userName}`,
          `**Kategorie:** ${ticket.categoryName}`,
          `**Grund:** ${reason}`,
        ].join('\n'))
        .setColor(0x5865f2).setTimestamp()
      ],
      files: [attachment],
    });
  } catch (e) { console.error('Transcript error:', e.message); }
}

function generateTranscriptHTML(channel, ticket, messages, reason) {
  const e = s => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const rows = messages.map(m => `
    <div class="msg">
      <div class="msg-head">
        <img class="av" src="https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=32" onerror="this.src='https://cdn.discordapp.com/embed/avatars/0.png'">
        <span class="name">${e(m.author.globalName || m.author.username)}</span>
        <span class="time">${new Date(m.createdTimestamp).toLocaleString('de-DE')}</span>
      </div>
      ${m.content ? `<div class="content">${e(m.content)}</div>` : ''}
      ${m.attachments.size ? [...m.attachments.values()].map(a => `<div class="att">📎 <a href="${a.url}">${e(a.name)}</a></div>`).join('') : ''}
    </div>`).join('');

  return `<!DOCTYPE html><html lang="de"><head><meta charset="UTF-8">
  <title>Transcript – ${e(channel.name)}</title>
  <style>
    body{font-family:sans-serif;background:#313338;color:#f2f3f5;margin:0;padding:24px}
    h1{font-size:20px;margin-bottom:4px} p{color:#b5bac1;font-size:13px;margin-bottom:24px}
    .msg{padding:10px 0;border-bottom:1px solid #3f4147}
    .msg-head{display:flex;align-items:center;gap:8px;margin-bottom:4px}
    .av{width:32px;height:32px;border-radius:50%}
    .name{font-weight:700;font-size:14px}
    .time{font-size:11px;color:#80848e;margin-left:auto}
    .content{font-size:14px;padding-left:40px;white-space:pre-wrap;word-break:break-word}
    .att{font-size:12px;color:#5865f2;padding-left:40px}
  </style></head><body>
  <h1>🎫 Ticket Transcript</h1>
  <p>Kanal: ${e(channel.name)} | Nutzer: ${e(ticket.userName)} | Kategorie: ${e(ticket.categoryName)} | Grund: ${e(reason)}</p>
  ${rows}
  </body></html>`;
}

// ── Auto-close timers ────────────────────────────────────────
function scheduleAutoClose(channelId, ticket, guildCfg) {
  if (autoCloseTimers.has(channelId)) clearTimeout(autoCloseTimers.get(channelId));
  const hours = guildCfg.autoClose?.hours || 48;
  const delay = (ticket.lastActivity + hours * 3_600_000) - Date.now();
  if (delay <= 0) {
    const ch = client.channels.cache.get(channelId);
    if (ch) closeTicket(ch, ticket, 'Auto-Close (Inaktivität)').catch(() => {});
    return;
  }
  const timer = setTimeout(async () => {
    const ch = client.channels.cache.get(channelId);
    if (ch) await closeTicket(ch, ticket, 'Auto-Close (Inaktivität)').catch(() => {});
  }, Math.min(delay, 2_147_483_647));
  autoCloseTimers.set(channelId, timer);
}

function restartAutoCloseTimers() {
  try {
    const tickets = cfg.getTickets();
    for (const [channelId, ticket] of Object.entries(tickets)) {
      const guildCfg = cfg.getGuild(ticket.guildId);
      if (guildCfg.autoClose?.enabled) scheduleAutoClose(channelId, ticket, guildCfg);
    }
    console.log('🔄 Auto-Close Timer wiederhergestellt');
  } catch (e) { console.warn('Auto-close restart error:', e.message); }
}

// ── Build ticket action buttons ───────────────────────────────
function buildTicketButtons(guildCfg) {
  const btns = guildCfg.buttons || {};
  const row = new ActionRowBuilder();
  if (btns.close    !== false) row.addComponents(new ButtonBuilder().setCustomId('ticket_close').setLabel('🔒 Schließen').setStyle(ButtonStyle.Danger));
  if (btns.claim    !== false) row.addComponents(new ButtonBuilder().setCustomId('ticket_claim').setLabel('✋ Claimen').setStyle(ButtonStyle.Primary));
  if (btns.priority !== false) row.addComponents(new ButtonBuilder().setCustomId('ticket_priority').setLabel('📊 Priorität').setStyle(ButtonStyle.Secondary));
  if (btns.forward  !== false) row.addComponents(new ButtonBuilder().setCustomId('ticket_forward').setLabel('↗️ Weiterleiten').setStyle(ButtonStyle.Secondary));
  if (btns.addUser  !== false) row.addComponents(new ButtonBuilder().setCustomId('ticket_add_user').setLabel('👤 Nutzer').setStyle(ButtonStyle.Secondary));
  return row.components.length ? [row] : [];
}

// ── Post panel to channel ─────────────────────────────────────
async function postPanel(channel, category) {
  const embed = new EmbedBuilder()
    .setTitle(category.panelTitle || `${category.emoji || '🎫'} ${category.name}`)
    .setDescription(category.panelDescription || 'Klicke den Button, um ein Ticket zu erstellen.')
    .setColor(category.panelColor || 0x5865f2);
  const btn = new ButtonBuilder()
    .setCustomId(`ticket_create_${category.id}`)
    .setLabel(category.buttonLabel || 'Ticket erstellen')
    .setStyle(category.buttonStyle || ButtonStyle.Primary);
  if (category.buttonEmoji) {
    try { btn.setEmoji(category.buttonEmoji); } catch {}
  }
  await channel.send({ embeds: [embed], components: [new ActionRowBuilder().addComponents(btn)] });
}

// ── Login bot ─────────────────────────────────────────────────
if (BOT_TOKEN) {
  client.login(BOT_TOKEN).catch(e => {
    console.warn('⚠️  Bot-Login fehlgeschlagen:', e.message);
    console.warn('   → Prüfe den BOT_TOKEN in den Umgebungsvariablen.');
  });
}

// ════════════════════════════════════════════════════════════
//  EXPRESS MIDDLEWARE
// ════════════════════════════════════════════════════════════
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Helpers ──────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════
//  AUTH ROUTES (Discord OAuth2)
// ════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════
//  USER / GUILDS
// ════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════
//  BANS
// ════════════════════════════════════════════════════════════
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

// ════════════════════════════════════════════════════════════
//  MEMBERS
// ════════════════════════════════════════════════════════════
app.get('/api/guilds/:id/members', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/members?limit=1000`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/members/:userId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/members/${req.params.userId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  ROLES
// ════════════════════════════════════════════════════════════
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
      method: 'PATCH', body: JSON.stringify(body),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/roles/:roleId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/roles/${req.params.roleId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  CHANNELS
// ════════════════════════════════════════════════════════════
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
      method: 'PATCH', body: JSON.stringify(body),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.delete('/api/guilds/:id/channels/:channelId', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/channels/${req.params.channelId}`, { method: 'DELETE' })); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  AUDIT LOG
// ════════════════════════════════════════════════════════════
app.get('/api/guilds/:id/audit-logs', requireAuth, async (req, res) => {
  try { res.json(await discordBot(`/guilds/${req.params.id}/audit-logs?limit=50`)); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  MESSAGES
// ════════════════════════════════════════════════════════════
app.post('/api/guilds/:id/channels/:channelId/messages', requireAuth, async (req, res) => {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: 'Nachrichteninhalt fehlt' });
  try {
    res.json(await discordBot(`/channels/${req.params.channelId}/messages`, {
      method: 'POST', body: JSON.stringify({ content: content.trim() }),
    }));
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  TICKET API ROUTES
// ════════════════════════════════════════════════════════════

// GET ticket config for a guild
app.get('/api/guilds/:id/ticket-config', requireAuth, (req, res) => {
  try { res.json(cfg.getGuild(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT ticket config (full overwrite of guild config)
app.put('/api/guilds/:id/ticket-config', requireAuth, (req, res) => {
  try {
    const existing = cfg.getGuild(req.params.id);
    const updated  = Object.assign(existing, req.body);
    cfg.saveGuild(req.params.id, updated);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET active tickets for a guild
app.get('/api/guilds/:id/tickets', requireAuth, (req, res) => {
  try { res.json(cfg.getGuildTickets(req.params.id)); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// POST panel to channel
app.post('/api/guilds/:id/panel', requireAuth, async (req, res) => {
  const { channelId, categoryId } = req.body;
  if (!channelId || !categoryId) return res.status(400).json({ error: 'channelId und categoryId erforderlich' });
  try {
    const guildCfg = cfg.getGuild(req.params.id);
    const cat = guildCfg.categories.find(c => c.id === categoryId);
    if (!cat) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
    const channel = await client.channels.fetch(channelId);
    await postPanel(channel, cat);
    res.json({ success: true });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// DELETE / force-close a ticket
app.delete('/api/guilds/:id/tickets/:channelId', requireAuth, async (req, res) => {
  try {
    const ticket = cfg.getTicket(req.params.channelId);
    if (!ticket) return res.status(404).json({ error: 'Ticket nicht gefunden' });
    const channel = await client.channels.fetch(req.params.channelId).catch(() => null);
    if (channel) {
      await closeTicket(channel, ticket, 'Über Dashboard geschlossen');
    } else {
      cfg.deleteTicket(req.params.channelId);
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════
//  SPA + START
// ════════════════════════════════════════════════════════════
app.get('/app', (req, res) => res.sendFile(__dirname + '/public/index.html'));

const HOST = process.env.NODE_ENV === 'production' ? '0.0.0.0' : 'localhost';
app.listen(PORT, HOST, () => {
  const url = HOST === '0.0.0.0' ? `Port ${PORT} (Render)` : `http://localhost:${PORT}`;
  console.log(`\n🎮  Discord Dashboard + Ticket System läuft auf ${url}\n`);
});
