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
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildModeration,
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
    else if (interaction.isModalSubmit())      await handleModalSubmit(interaction);
  } catch (e) {
    console.error('Interaction error:', e);
    try {
      const reply = { content: '❌ Ein Fehler ist aufgetreten.', ephemeral: true };
      if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
      else await interaction.reply(reply);
    } catch {}
  }
});

// ── Autorole: assign roles when a member joins ───────────────
client.on('guildMemberAdd', async member => {
  try {
    const guildCfg = cfg.getGuild(member.guild.id);
    const autorole  = guildCfg.autorole;
    if (!autorole?.enabled || !autorole?.rules?.length) return;

    for (const rule of autorole.rules) {
      if (!rule.roles?.length) continue;
      const isBot = member.user.bot;
      if (rule.target === 'bots'   && !isBot) continue;
      if (rule.target === 'humans' &&  isBot) continue;

      const assign = async () => {
        for (const roleId of rule.roles) {
          try {
            const role = member.guild.roles.cache.get(roleId);
            if (role) await member.roles.add(role);
          } catch {}
        }
      };

      if (rule.delay > 0) setTimeout(assign, rule.delay * 1000);
      else await assign();
    }

    // Optional DM message
    if (autorole.dmMessage?.trim()) {
      const msg = autorole.dmMessage
        .replace(/{user}/g,   member.user.tag)
        .replace(/{server}/g, member.guild.name)
        .replace(/{mention}/g, `<@${member.user.id}>`);
      member.user.send(msg).catch(() => {});
    }
  } catch (e) { console.error('Autorole error:', e.message); }
});

// ════════════════════════════════════════════════════════════
//  SERVER LOG SYSTEM
// ════════════════════════════════════════════════════════════

async function sendLog(guildId, category, embed) {
  try {
    const guildCfg = cfg.getGuild(guildId);
    const logCfg   = guildCfg.serverLog;
    if (!logCfg?.enabled) return;
    const channelId = logCfg.channels?.[category];
    if (!channelId) return;
    const ch = await client.channels.fetch(channelId).catch(() => null);
    if (ch) await ch.send({ embeds: [embed] });
  } catch {}
}

// ── Messages ─────────────────────────────────────────────────
client.on('messageDelete', async msg => {
  if (!msg.guild || msg.author?.bot) return;
  const embed = new EmbedBuilder()
    .setTitle('🗑️ Nachricht gelöscht')
    .setColor(0xed4245)
    .addFields(
      { name: 'Kanal',  value: `<#${msg.channel.id}>`, inline: true },
      { name: 'Autor',  value: msg.author ? `<@${msg.author.id}> (${msg.author.tag})` : '*Unbekannt*', inline: true },
      { name: 'Inhalt', value: msg.content ? msg.content.slice(0, 1024) || '*Leer*' : '*Nicht im Cache*' },
    )
    .setTimestamp();
  await sendLog(msg.guild.id, 'messages', embed);
});

client.on('messageUpdate', async (oldMsg, newMsg) => {
  if (!newMsg.guild || newMsg.author?.bot) return;
  if (oldMsg.content === newMsg.content) return;
  const embed = new EmbedBuilder()
    .setTitle('✏️ Nachricht bearbeitet')
    .setColor(0xfee75c)
    .addFields(
      { name: 'Kanal',   value: `<#${newMsg.channel.id}>`, inline: true },
      { name: 'Autor',   value: `<@${newMsg.author.id}> (${newMsg.author.tag})`, inline: true },
      { name: 'Vorher',  value: (oldMsg.content || '*Nicht im Cache*').slice(0, 512) },
      { name: 'Nachher', value: (newMsg.content || '*Leer*').slice(0, 512) },
    )
    .setTimestamp();
  await sendLog(newMsg.guild.id, 'messages', embed);
});

client.on('messageDeleteBulk', async (msgs, channel) => {
  if (!channel.guild) return;
  const embed = new EmbedBuilder()
    .setTitle('🗑️ Massen-Löschung')
    .setColor(0xed4245)
    .addFields(
      { name: 'Kanal',   value: `<#${channel.id}>`, inline: true },
      { name: 'Anzahl',  value: `${msgs.size} Nachrichten`, inline: true },
    )
    .setTimestamp();
  await sendLog(channel.guild.id, 'messages', embed);
});

// ── Members ───────────────────────────────────────────────────
client.on('guildMemberAdd', async member => {
  // Autorole is handled separately — here just log
  const created = Math.floor(member.user.createdTimestamp / 1000);
  const embed = new EmbedBuilder()
    .setTitle('📥 Mitglied beigetreten')
    .setColor(0x57f287)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Nutzer',       value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'Mitglieder',   value: `${member.guild.memberCount}`, inline: true },
      { name: 'Account seit', value: `<t:${created}:R>`, inline: true },
    )
    .setTimestamp();
  await sendLog(member.guild.id, 'members', embed);
});

client.on('guildMemberRemove', async member => {
  const roles = member.roles.cache
    .filter(r => r.name !== '@everyone')
    .map(r => `<@&${r.id}>`).join(', ') || '*Keine*';
  const embed = new EmbedBuilder()
    .setTitle('📤 Mitglied verlassen')
    .setColor(0xed4245)
    .setThumbnail(member.user.displayAvatarURL())
    .addFields(
      { name: 'Nutzer', value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'Rollen', value: roles.slice(0, 512) },
    )
    .setTimestamp();
  await sendLog(member.guild.id, 'members', embed);
});

client.on('guildMemberUpdate', async (oldMember, newMember) => {
  // Nickname change
  if (oldMember.nickname !== newMember.nickname) {
    const embed = new EmbedBuilder()
      .setTitle('✏️ Nickname geändert')
      .setColor(0xfee75c)
      .addFields(
        { name: 'Nutzer',   value: `<@${newMember.id}> (${newMember.user.tag})`, inline: true },
        { name: 'Vorher',   value: oldMember.nickname || '*Kein Nickname*', inline: true },
        { name: 'Nachher',  value: newMember.nickname || '*Kein Nickname*', inline: true },
      )
      .setTimestamp();
    await sendLog(newMember.guild.id, 'members', embed);
  }

  // Role changes
  const addedRoles   = newMember.roles.cache.filter(r => !oldMember.roles.cache.has(r.id) && r.name !== '@everyone');
  const removedRoles = oldMember.roles.cache.filter(r => !newMember.roles.cache.has(r.id) && r.name !== '@everyone');
  if (addedRoles.size || removedRoles.size) {
    const embed = new EmbedBuilder()
      .setTitle('🔄 Rollen geändert')
      .setColor(0x5865f2)
      .addFields({ name: 'Nutzer', value: `<@${newMember.id}> (${newMember.user.tag})`, inline: false });
    if (addedRoles.size)   embed.addFields({ name: '✅ Hinzugefügt',  value: addedRoles.map(r=>`<@&${r.id}>`).join(', '), inline: true });
    if (removedRoles.size) embed.addFields({ name: '❌ Entfernt',     value: removedRoles.map(r=>`<@&${r.id}>`).join(', '), inline: true });
    embed.setTimestamp();
    await sendLog(newMember.guild.id, 'members', embed);
  }
});

// ── Voice ─────────────────────────────────────────────────────
client.on('voiceStateUpdate', async (oldState, newState) => {
  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;
  const guildId = newState.guild?.id || oldState.guild?.id;

  let title, color, fields;

  if (!oldState.channel && newState.channel) {
    title  = '🔊 Voice beigetreten';
    color  = 0x57f287;
    fields = [
      { name: 'Nutzer',  value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'Kanal',   value: `${newState.channel.name}`, inline: true },
    ];
  } else if (oldState.channel && !newState.channel) {
    title  = '🔇 Voice verlassen';
    color  = 0xed4245;
    fields = [
      { name: 'Nutzer',  value: `<@${member.id}> (${member.user.tag})`, inline: true },
      { name: 'Kanal',   value: `${oldState.channel.name}`, inline: true },
    ];
  } else if (oldState.channel?.id !== newState.channel?.id) {
    title  = '↔️ Voice gewechselt';
    color  = 0xfee75c;
    fields = [
      { name: 'Nutzer',  value: `<@${member.id}> (${member.user.tag})`, inline: false },
      { name: 'Vorher',  value: oldState.channel?.name || '?', inline: true },
      { name: 'Nachher', value: newState.channel?.name || '?', inline: true },
    ];
  } else if (!oldState.serverMute && newState.serverMute) {
    title = '🔇 Server-Mute';  color = 0xfee75c;
    fields = [{ name: 'Nutzer', value: `<@${member.id}> (${member.user.tag})` }];
  } else if (oldState.serverMute && !newState.serverMute) {
    title = '🔊 Server-Mute aufgehoben'; color = 0x57f287;
    fields = [{ name: 'Nutzer', value: `<@${member.id}> (${member.user.tag})` }];
  } else {
    return; // Ignore self-mute/deafen etc.
  }

  const embed = new EmbedBuilder().setTitle(title).setColor(color).addFields(fields).setTimestamp();
  await sendLog(guildId, 'voice', embed);
});

// ── Roles ─────────────────────────────────────────────────────
client.on('roleCreate', async role => {
  const embed = new EmbedBuilder()
    .setTitle('✅ Rolle erstellt')
    .setColor(0x57f287)
    .addFields(
      { name: 'Name',  value: role.name, inline: true },
      { name: 'ID',    value: role.id,   inline: true },
      { name: 'Farbe', value: role.hexColor, inline: true },
    )
    .setTimestamp();
  await sendLog(role.guild.id, 'roles', embed);
});

client.on('roleDelete', async role => {
  const embed = new EmbedBuilder()
    .setTitle('❌ Rolle gelöscht')
    .setColor(0xed4245)
    .addFields(
      { name: 'Name', value: role.name, inline: true },
      { name: 'ID',   value: role.id,   inline: true },
    )
    .setTimestamp();
  await sendLog(role.guild.id, 'roles', embed);
});

client.on('roleUpdate', async (oldRole, newRole) => {
  const changes = [];
  if (oldRole.name     !== newRole.name)     changes.push(`**Name:** ${oldRole.name} → ${newRole.name}`);
  if (oldRole.hexColor !== newRole.hexColor) changes.push(`**Farbe:** ${oldRole.hexColor} → ${newRole.hexColor}`);
  if (oldRole.hoist    !== newRole.hoist)    changes.push(`**Getrennt anzeigen:** ${oldRole.hoist} → ${newRole.hoist}`);
  if (!changes.length) return;
  const embed = new EmbedBuilder()
    .setTitle('✏️ Rolle bearbeitet')
    .setColor(0xfee75c)
    .addFields(
      { name: 'Rolle',    value: `<@&${newRole.id}> (${newRole.name})`, inline: false },
      { name: 'Änderungen', value: changes.join('\n') },
    )
    .setTimestamp();
  await sendLog(newRole.guild.id, 'roles', embed);
});

// ── Channels ──────────────────────────────────────────────────
const CH_TYPE_NAMES = { 0:'Text', 2:'Voice', 4:'Kategorie', 5:'Ankündigungen', 13:'Stage', 15:'Forum' };

client.on('channelCreate', async channel => {
  if (!channel.guild) return;
  const embed = new EmbedBuilder()
    .setTitle('✅ Kanal erstellt')
    .setColor(0x57f287)
    .addFields(
      { name: 'Name', value: channel.name, inline: true },
      { name: 'Typ',  value: CH_TYPE_NAMES[channel.type] || String(channel.type), inline: true },
      { name: 'ID',   value: channel.id,  inline: true },
    )
    .setTimestamp();
  await sendLog(channel.guild.id, 'channels', embed);
});

client.on('channelDelete', async channel => {
  if (!channel.guild) return;
  const embed = new EmbedBuilder()
    .setTitle('❌ Kanal gelöscht')
    .setColor(0xed4245)
    .addFields(
      { name: 'Name', value: channel.name, inline: true },
      { name: 'Typ',  value: CH_TYPE_NAMES[channel.type] || String(channel.type), inline: true },
      { name: 'ID',   value: channel.id,  inline: true },
    )
    .setTimestamp();
  await sendLog(channel.guild.id, 'channels', embed);
});

client.on('channelUpdate', async (oldCh, newCh) => {
  if (!newCh.guild) return;
  const changes = [];
  if (oldCh.name  !== newCh.name)  changes.push(`**Name:** ${oldCh.name} → ${newCh.name}`);
  if (oldCh.topic !== newCh.topic) changes.push(`**Thema:** ${oldCh.topic || '*Leer*'} → ${newCh.topic || '*Leer*'}`);
  if (!changes.length) return;
  const embed = new EmbedBuilder()
    .setTitle('✏️ Kanal bearbeitet')
    .setColor(0xfee75c)
    .addFields(
      { name: 'Kanal',     value: `<#${newCh.id}> (${newCh.name})` },
      { name: 'Änderungen', value: changes.join('\n') },
    )
    .setTimestamp();
  await sendLog(newCh.guild.id, 'channels', embed);
});

// ── Moderation ────────────────────────────────────────────────
client.on('guildBanAdd', async ban => {
  const embed = new EmbedBuilder()
    .setTitle('🔨 Nutzer gebannt')
    .setColor(0xed4245)
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields(
      { name: 'Nutzer', value: `<@${ban.user.id}> (${ban.user.tag})`, inline: true },
      { name: 'Grund',  value: ban.reason || '*Kein Grund angegeben*', inline: true },
    )
    .setTimestamp();
  await sendLog(ban.guild.id, 'moderation', embed);
});

client.on('guildBanRemove', async ban => {
  const embed = new EmbedBuilder()
    .setTitle('✅ Ban aufgehoben')
    .setColor(0x57f287)
    .setThumbnail(ban.user.displayAvatarURL())
    .addFields({ name: 'Nutzer', value: `<@${ban.user.id}> (${ban.user.tag})`, inline: true })
    .setTimestamp();
  await sendLog(ban.guild.id, 'moderation', embed);
});

// ── Server ────────────────────────────────────────────────────
client.on('guildUpdate', async (oldGuild, newGuild) => {
  const changes = [];
  if (oldGuild.name        !== newGuild.name)        changes.push(`**Name:** ${oldGuild.name} → ${newGuild.name}`);
  if (oldGuild.icon        !== newGuild.icon)        changes.push(`**Icon** geändert`);
  if (oldGuild.description !== newGuild.description) changes.push(`**Beschreibung** geändert`);
  if (oldGuild.verificationLevel !== newGuild.verificationLevel)
    changes.push(`**Verifikationsstufe:** ${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`);
  if (!changes.length) return;
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Server aktualisiert')
    .setColor(0x5865f2)
    .addFields({ name: 'Änderungen', value: changes.join('\n') })
    .setTimestamp();
  await sendLog(newGuild.id, 'server', embed);
});

// ════════════════════════════════════════════════════════════
//  END SERVER LOG
// ════════════════════════════════════════════════════════════

// Track message activity for auto-close + dispatch mod commands
client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;

  // Mod prefix commands
  if (msg.content.startsWith('!')) {
    await handleModCommand(msg);
  }

  // Ticket auto-close tracking
  const ticket = cfg.getTicket(msg.channel.id);
  if (!ticket) return;
  ticket.lastActivity = Date.now();
  cfg.saveTicket(msg.channel.id, ticket);
  const guildCfg = cfg.getGuild(msg.guild.id);
  if (guildCfg.autoClose?.enabled) scheduleAutoClose(msg.channel.id, ticket, guildCfg);
});

// ════════════════════════════════════════════════════════════
//  MOD PREFIX COMMANDS  (!ban / !kick / !timeout / !warn …)
// ════════════════════════════════════════════════════════════

/** Returns true if the string looks like a direct image URL */
function isImageUrl(str) {
  if (!str) return false;
  try { new URL(str); } catch { return false; }
  return /\.(png|jpe?g|gif|webp|bmp|tiff?|svg)(\?.*)?$/i.test(str) ||
         /^https?:\/\/(i\.)?imgur\.com\//i.test(str) ||
         /^https?:\/\/cdn\.discordapp\.com\//i.test(str) ||
         /^https?:\/\/media\.discordapp\.net\//i.test(str);
}

/** Parse a duration string like "1d", "2h30m", "60s" → milliseconds */
function parseDuration(str) {
  if (!str) return null;
  const re = /(\d+)\s*(d(?:ays?)?|h(?:ours?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)/gi;
  let ms = 0, match;
  while ((match = re.exec(str)) !== null) {
    const n = parseInt(match[1], 10);
    const u = match[2][0].toLowerCase();
    if (u === 'd') ms += n * 86_400_000;
    else if (u === 'h') ms += n * 3_600_000;
    else if (u === 'm') ms += n * 60_000;
    else if (u === 's') ms += n * 1_000;
  }
  return ms > 0 ? ms : null;
}

/** Format milliseconds to a human-readable string */
function formatDuration(ms) {
  if (!ms) return '?';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1_000);
  return [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean).join(' ') || '0s';
}

/** Store a mod action and return the new case number */
function recordModAction(guildId, targetId, action) {
  const guildCfg = cfg.getGuild(guildId);
  if (!guildCfg.modCaseCounter) guildCfg.modCaseCounter = 0;
  if (!guildCfg.modActions) guildCfg.modActions = {};
  if (!guildCfg.modActions[targetId]) guildCfg.modActions[targetId] = [];
  guildCfg.modCaseCounter += 1;
  guildCfg.modActions[targetId].push({ ...action, case: guildCfg.modCaseCounter, timestamp: Date.now() });
  cfg.saveGuild(guildId, guildCfg);
  return guildCfg.modCaseCounter;
}

/** Build and send a modlog embed, then reply in the command channel */
async function postModLog(msg, { action, color, emoji, targetUser, targetId, moderator, reason, proof, extra }) {
  const guildCfg = cfg.getGuild(msg.guild.id);
  const caseNum  = recordModAction(msg.guild.id, targetId, { action, reason, proof, moderator: moderator.id });

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${action} | Case #${caseNum}`)
    .addFields(
      { name: '👤 User',       value: targetUser ? `${targetUser.tag} (<@${targetId}>)` : `<@${targetId}> (ID: ${targetId})`, inline: true },
      { name: '🛡️ Moderator', value: `${moderator.tag}`, inline: true },
      { name: '📋 Reason',     value: reason || 'Kein Grund angegeben' },
    );

  if (extra) embed.addFields(extra);
  if (proof && isImageUrl(proof)) embed.setImage(proof);
  else if (proof) embed.addFields({ name: '🔗 Proof', value: proof });

  embed.setFooter({ text: `User ID: ${targetId}` }).setTimestamp();

  await sendLog(msg.guild.id, 'moderation', embed);

  const replyEmbed = new EmbedBuilder()
    .setColor(color)
    .setDescription(`${emoji} **${action}** ausgeführt | Case #${caseNum}`)
    .setTimestamp();
  await msg.reply({ embeds: [replyEmbed] });
}

async function handleModCommand(msg) {
  const guildCfg  = cfg.getGuild(msg.guild.id);
  const prefix     = guildCfg.modPrefix || '!';

  // Parse command name
  if (!msg.content.startsWith(prefix)) return;
  const parts   = msg.content.slice(prefix.length).trim().split(/\s+/);
  const command = parts[0].toLowerCase();
  const args    = parts.slice(1); // everything after command name

  const MOD_COMMANDS = ['ban','unban','kick','timeout','mute','untimeout','unmute','warn','modlogs'];
  if (!MOD_COMMANDS.includes(command)) return;

  // Permission check — must have ModerateMembers or BanMembers
  const member = msg.member;
  const hasMod = member.permissions.has(PermissionFlagsBits.ModerateMembers) ||
                 member.permissions.has(PermissionFlagsBits.BanMembers) ||
                 member.permissions.has(PermissionFlagsBits.KickMembers);
  if (!hasMod) {
    return msg.reply({ content: '❌ Du hast keine Berechtigung für Mod-Commands.' });
  }

  // ── !modlogs [user_id] ────────────────────────────────────
  if (command === 'modlogs') {
    const targetId = args[0];
    if (!targetId) return msg.reply({ content: '❌ Usage: `!modlogs [user_id]`' });

    const actions = guildCfg.modActions?.[targetId] || [];
    if (!actions.length) return msg.reply({ content: `ℹ️ Keine Mod-Aktionen für <@${targetId}> (ID: ${targetId}).` });

    let targetTag = `ID: ${targetId}`;
    try { const u = await client.users.fetch(targetId); targetTag = u.tag; } catch {}

    const lines = actions.slice(-20).map(a => {
      const d = new Date(a.timestamp).toLocaleDateString('de-DE');
      return `**Case #${a.case}** — ${a.action} — ${d}\n> ${a.reason || 'Kein Grund'}`;
    }).join('\n\n');

    const embed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setTitle(`📋 Modlogs für ${targetTag}`)
      .setDescription(lines.slice(0, 4000))
      .setFooter({ text: `${actions.length} Aktionen gesamt | User ID: ${targetId}` })
      .setTimestamp();

    return msg.reply({ embeds: [embed] });
  }

  // ── All other commands: first arg = user_id ───────────────
  const targetId = args[0];
  if (!targetId) return msg.reply({ content: `❌ Usage: \`${prefix}${command} [user_id] [reason] [proof]\`` });

  let targetUser = null;
  try { targetUser = await client.users.fetch(targetId); } catch {}

  // ── !ban ─────────────────────────────────────────────────
  if (command === 'ban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers))
      return msg.reply({ content: '❌ Du benötigst die `BAN_MEMBERS` Berechtigung.' });

    // proof is last arg if it looks like URL or image, else no proof
    let proof, reason;
    if (args.length >= 3 && isImageUrl(args[args.length - 1])) {
      proof  = args[args.length - 1];
      reason = args.slice(1, -1).join(' ');
    } else {
      proof  = null;
      reason = args.slice(1).join(' ');
    }

    try {
      await msg.guild.members.ban(targetId, { reason: reason || 'Kein Grund angegeben', deleteMessageSeconds: 0 });
    } catch (e) {
      return msg.reply({ content: `❌ Ban fehlgeschlagen: ${e.message}` });
    }
    await postModLog(msg, {
      action: 'Ban', color: 0xED4245, emoji: '🔨',
      targetUser, targetId, moderator: msg.author,
      reason, proof,
    });
  }

  // ── !unban ───────────────────────────────────────────────
  else if (command === 'unban') {
    if (!member.permissions.has(PermissionFlagsBits.BanMembers))
      return msg.reply({ content: '❌ Du benötigst die `BAN_MEMBERS` Berechtigung.' });

    const reason = args.slice(1).join(' ');
    try {
      await msg.guild.bans.remove(targetId, reason || 'Kein Grund angegeben');
    } catch (e) {
      return msg.reply({ content: `❌ Unban fehlgeschlagen: ${e.message}` });
    }
    await postModLog(msg, {
      action: 'Unban', color: 0x57F287, emoji: '✅',
      targetUser, targetId, moderator: msg.author,
      reason, proof: null,
    });
  }

  // ── !kick ────────────────────────────────────────────────
  else if (command === 'kick') {
    if (!member.permissions.has(PermissionFlagsBits.KickMembers))
      return msg.reply({ content: '❌ Du benötigst die `KICK_MEMBERS` Berechtigung.' });

    let proof, reason;
    if (args.length >= 3 && isImageUrl(args[args.length - 1])) {
      proof  = args[args.length - 1];
      reason = args.slice(1, -1).join(' ');
    } else {
      proof  = null;
      reason = args.slice(1).join(' ');
    }

    try {
      const gm = await msg.guild.members.fetch(targetId);
      await gm.kick(reason || 'Kein Grund angegeben');
    } catch (e) {
      return msg.reply({ content: `❌ Kick fehlgeschlagen: ${e.message}` });
    }
    await postModLog(msg, {
      action: 'Kick', color: 0xFEE75C, emoji: '👢',
      targetUser, targetId, moderator: msg.author,
      reason, proof,
    });
  }

  // ── !timeout / !mute ─────────────────────────────────────
  else if (command === 'timeout' || command === 'mute') {
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return msg.reply({ content: '❌ Du benötigst die `MODERATE_MEMBERS` Berechtigung.' });

    // format: !timeout [user_id] [duration] [reason] [proof]
    const durationStr = args[1];
    const ms = parseDuration(durationStr);
    if (!ms) return msg.reply({ content: `❌ Ungültige Dauer. Beispiel: \`${prefix}timeout 123456789 1h Spam\`` });

    let proof, reason;
    if (args.length >= 4 && isImageUrl(args[args.length - 1])) {
      proof  = args[args.length - 1];
      reason = args.slice(2, -1).join(' ');
    } else {
      proof  = null;
      reason = args.slice(2).join(' ');
    }

    try {
      const gm = await msg.guild.members.fetch(targetId);
      await gm.timeout(ms, reason || 'Kein Grund angegeben');
    } catch (e) {
      return msg.reply({ content: `❌ Timeout fehlgeschlagen: ${e.message}` });
    }
    await postModLog(msg, {
      action: 'Timeout', color: 0xEB459E, emoji: '⏱️',
      targetUser, targetId, moderator: msg.author,
      reason, proof,
      extra: { name: '⏳ Dauer', value: formatDuration(ms), inline: true },
    });
  }

  // ── !untimeout / !unmute ─────────────────────────────────
  else if (command === 'untimeout' || command === 'unmute') {
    if (!member.permissions.has(PermissionFlagsBits.ModerateMembers))
      return msg.reply({ content: '❌ Du benötigst die `MODERATE_MEMBERS` Berechtigung.' });

    const reason = args.slice(1).join(' ');
    try {
      const gm = await msg.guild.members.fetch(targetId);
      await gm.timeout(null, reason || 'Kein Grund angegeben');
    } catch (e) {
      return msg.reply({ content: `❌ Untimeout fehlgeschlagen: ${e.message}` });
    }
    await postModLog(msg, {
      action: 'Untimeout', color: 0x57F287, emoji: '🔓',
      targetUser, targetId, moderator: msg.author,
      reason, proof: null,
    });
  }

  // ── !warn ────────────────────────────────────────────────
  else if (command === 'warn') {
    let proof, reason;
    if (args.length >= 3 && isImageUrl(args[args.length - 1])) {
      proof  = args[args.length - 1];
      reason = args.slice(1, -1).join(' ');
    } else {
      proof  = null;
      reason = args.slice(1).join(' ');
    }
    if (!reason) return msg.reply({ content: `❌ Usage: \`${prefix}warn [user_id] [reason]\`` });

    // DM the warned user
    if (targetUser) {
      try {
        await targetUser.send({
          embeds: [
            new EmbedBuilder()
              .setColor(0xFEE75C)
              .setTitle(`⚠️ Verwarnung auf ${msg.guild.name}`)
              .setDescription(`**Grund:** ${reason}`)
              .setTimestamp(),
          ],
        });
      } catch {} // DMs may be closed
    }

    await postModLog(msg, {
      action: 'Warn', color: 0xFEE75C, emoji: '⚠️',
      targetUser, targetId, moderator: msg.author,
      reason, proof,
    });
  }
}

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
    const cat = guildCfg.categories?.find(c => c.id === ticket.categoryId);
    if (cat?.askCloseReason) {
      const closeModal = new ModalBuilder().setCustomId('modal_close_ticket').setTitle('Ticket schließen');
      const reasonInput = new TextInputBuilder()
        .setCustomId('close_reason').setLabel('Grund für das Schließen')
        .setStyle(TextInputStyle.Paragraph).setRequired(false)
        .setPlaceholder('Optional: Grund eingeben…');
      closeModal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
      await interaction.showModal(closeModal);
    } else {
      await interaction.reply({ content: `🔒 ${guildCfg.closeMessage || 'Ticket wird geschlossen…'}` });
      await closeTicket(interaction.channel, ticket, `Geschlossen von ${interaction.user.tag}`);
    }

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
      .setCustomId('select_priority').setPlaceholder('Priorität auswählen').addOptions(options);
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
      .setCustomId('select_forward').setPlaceholder('Ziel-Kategorie auswählen').addOptions(options);
    await interaction.reply({
      content: '↗️ An welche Kategorie weiterleiten?',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });

  } else if (id === 'ticket_add_user') {
    const select = new UserSelectMenuBuilder().setCustomId('select_add_user').setPlaceholder('Nutzer auswählen');
    await interaction.reply({
      content: '👤 Nutzer zum Ticket hinzufügen:',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });

  } else if (id === 'ticket_remove_user') {
    const select = new UserSelectMenuBuilder().setCustomId('select_remove_user').setPlaceholder('Nutzer auswählen');
    await interaction.reply({
      content: '🚫 Welchen Nutzer möchtest du entfernen?',
      components: [new ActionRowBuilder().addComponents(select)],
      ephemeral: true,
    });

  } else if (id === 'ticket_lock') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    const overwrite = interaction.channel.permissionOverwrites.cache.get(ticket.userId);
    const isLocked = overwrite && overwrite.deny.has(PermissionFlagsBits.SendMessages);
    if (isLocked) {
      await interaction.channel.permissionOverwrites.edit(ticket.userId, { SendMessages: true });
      await interaction.reply({ content: `🔓 Ticket wurde entsperrt. ${interaction.guild.members.cache.get(ticket.userId) || ''} kann wieder schreiben.` });
    } else {
      await interaction.channel.permissionOverwrites.edit(ticket.userId, { SendMessages: false });
      await interaction.reply({ content: `🔒 Ticket wurde gesperrt. Der Ticket-Ersteller kann nicht mehr schreiben.` });
    }

  } else if (id === 'ticket_transcript') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    const guildCfg = cfg.getGuild(interaction.guild.id);
    await interaction.deferReply({ ephemeral: true });
    if (!guildCfg.logChannel) return interaction.editReply({ content: '❌ Kein Log-Kanal konfiguriert.' });
    try {
      const logCh = await client.channels.fetch(guildCfg.logChannel).catch(() => null);
      if (!logCh) return interaction.editReply({ content: '❌ Log-Kanal nicht gefunden.' });
      await sendTranscriptToLog(interaction.channel, ticket, `Manuell von ${interaction.user.tag}`, logCh);
      await interaction.editReply({ content: '✅ Transcript wurde in den Log-Kanal gesendet.' });
    } catch { await interaction.editReply({ content: '❌ Fehler beim Erstellen des Transcripts.' }); }

  } else if (id === 'ticket_rename') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    const renameModal = new ModalBuilder().setCustomId('modal_rename_ticket').setTitle('Ticket umbenennen');
    const nameInput = new TextInputBuilder()
      .setCustomId('rename_input').setLabel('Neuer Kanalname')
      .setStyle(TextInputStyle.Short).setValue(interaction.channel.name).setMaxLength(100);
    renameModal.addComponents(new ActionRowBuilder().addComponents(nameInput));
    await interaction.showModal(renameModal);
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
  const id = interaction.customId;
  if (id === 'select_add_user') {
    const user = interaction.users.first();
    if (!user) return interaction.update({ content: '❌ Kein Nutzer ausgewählt.', components: [] });
    await interaction.channel.permissionOverwrites.edit(user.id, {
      ViewChannel: true, SendMessages: true, ReadMessageHistory: true,
    });
    await interaction.update({ content: `✅ ${user} wurde zum Ticket hinzugefügt.`, components: [] });
    await interaction.channel.send({ content: `👤 ${user} wurde von ${interaction.user} zum Ticket hinzugefügt.` });

  } else if (id === 'select_remove_user') {
    const user = interaction.users.first();
    if (!user) return interaction.update({ content: '❌ Kein Nutzer ausgewählt.', components: [] });
    const ticket = cfg.getTicket(interaction.channel.id);
    if (ticket && user.id === ticket.userId) {
      return interaction.update({ content: '❌ Du kannst den Ticket-Ersteller nicht entfernen.', components: [] });
    }
    await interaction.channel.permissionOverwrites.delete(user.id);
    await interaction.update({ content: `✅ ${user} wurde aus dem Ticket entfernt.`, components: [] });
    await interaction.channel.send({ content: `🚫 ${user} wurde von ${interaction.user} aus dem Ticket entfernt.` });
  }
}

// ── Modal submit handler ─────────────────────────────────────
async function handleModalSubmit(interaction) {
  const id = interaction.customId;

  if (id === 'modal_rename_ticket') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    const newName = interaction.fields.getTextInputValue('rename_input').toLowerCase()
      .replace(/[^a-z0-9\-]/g, '-').replace(/-+/g, '-').slice(0, 100);
    await interaction.channel.setName(newName);
    await interaction.reply({ content: `✅ Ticket wurde in **${newName}** umbenannt.` });

  } else if (id === 'modal_close_ticket') {
    const ticket = cfg.getTicket(interaction.channel.id);
    if (!ticket) return interaction.reply({ content: '❌ Dies ist kein Ticket.', ephemeral: true });
    const reason = interaction.fields.getTextInputValue('close_reason')?.trim() || 'Kein Grund angegeben';
    await interaction.reply({ content: `🔒 Ticket wird geschlossen… Grund: ${reason}` });
    await closeTicket(interaction.channel, ticket, `Geschlossen von ${interaction.user.tag}: ${reason}`);
  }
}

// ── Create ticket ────────────────────────────────────────────
async function handleCreateTicket(interaction, categoryId) {
  await interaction.deferReply({ ephemeral: true });
  const guildCfg = cfg.getGuild(interaction.guild.id);
  const cat = guildCfg.categories.find(c => c.id === categoryId) || guildCfg.categories[0];
  if (!cat) return interaction.editReply({ content: '❌ Kategorie nicht gefunden.' });

  // Blacklist roles check
  if (cat.blacklistRoles?.length) {
    const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (member && cat.blacklistRoles.some(rId => member.roles.cache.has(rId))) {
      return interaction.editReply({ content: '❌ Du darfst keine Tickets in dieser Kategorie erstellen.' });
    }
  }

  // Check open tickets per user in this category
  const maxPerUser = cat.maxTicketsPerUser || 1;
  const userTickets = cfg.getGuildTickets(interaction.guild.id)
    .filter(t => t.userId === interaction.user.id && t.categoryId === categoryId);
  // Remove stale entries where channel no longer exists
  for (const t of userTickets) {
    if (!interaction.guild.channels.cache.has(t.channelId)) cfg.deleteTicket(t.channelId);
  }
  const activeUserTickets = userTickets.filter(t => interaction.guild.channels.cache.has(t.channelId));
  if (activeUserTickets.length >= maxPerUser) {
    const existCh = interaction.guild.channels.cache.get(activeUserTickets[0].channelId);
    return interaction.editReply({
      content: `❌ Du hast bereits ${activeUserTickets.length}/${maxPerUser} offenes Ticket(s) in dieser Kategorie.${existCh ? ` → ${existCh}` : ''}`,
    });
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

  await channel.send({ embeds: [embed], components: buildTicketButtons(cat, guildCfg) });

  // Mention support roles if configured
  if (cat.mentionSupportRoles && cat.supportRoles?.length) {
    const mentions = cat.supportRoles.map(id => `<@&${id}>`).join(' ');
    await channel.send({ content: `${mentions} — Neues Ticket von <@${interaction.user.id}>` });
  }

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
  const cat = guildCfg.categories?.find(c => c.id === ticket.categoryId);

  // Send transcript to log channel (unless disabled for this category)
  const sendTranscriptEnabled = cat?.sendTranscript !== false;
  if (guildCfg.logChannel && sendTranscriptEnabled) {
    try {
      const logCh = await client.channels.fetch(guildCfg.logChannel).catch(() => null);
      if (logCh) await sendTranscriptToLog(channel, ticket, reason, logCh);
    } catch {}
  }

  // DM on close
  if (cat?.dmOnClose?.trim()) {
    try {
      const closedUser = await client.users.fetch(ticket.userId).catch(() => null);
      if (closedUser) {
        const dmMsg = cat.dmOnClose
          .replace(/{user}/g,     closedUser.tag)
          .replace(/{server}/g,   channel.guild?.name || '')
          .replace(/{ticket}/g,   channel.name)
          .replace(/{category}/g, ticket.categoryName || '')
          .replace(/{reason}/g,   reason);
        closedUser.send(dmMsg).catch(() => {});
      }
    } catch {}
  }

  cfg.deleteTicket(channel.id);
  if (autoCloseTimers.has(channel.id)) {
    clearTimeout(autoCloseTimers.get(channel.id));
    autoCloseTimers.delete(channel.id);
  }

  // Per-category close delay (default 5s)
  const closeDelaySec = cat?.closeDelay ?? 5;
  setTimeout(() => channel.delete().catch(() => {}), closeDelaySec * 1000);
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
// Each button can be configured per-category with { enabled, label, emoji, style }
// or a simple false (disabled), or absent (use global or default).
const TICKET_BUTTON_DEFS = [
  { key: 'close',      id: 'ticket_close',       defLabel: '🔒 Schließen',        defStyle: ButtonStyle.Danger,     defEnabled: true  },
  { key: 'claim',      id: 'ticket_claim',        defLabel: '✋ Claimen',           defStyle: ButtonStyle.Primary,    defEnabled: true  },
  { key: 'priority',   id: 'ticket_priority',     defLabel: '📊 Priorität',         defStyle: ButtonStyle.Secondary,  defEnabled: true  },
  { key: 'forward',    id: 'ticket_forward',      defLabel: '↗️ Weiterleiten',      defStyle: ButtonStyle.Secondary,  defEnabled: true  },
  { key: 'addUser',    id: 'ticket_add_user',     defLabel: '👤 Nutzer',            defStyle: ButtonStyle.Secondary,  defEnabled: true  },
  { key: 'removeUser', id: 'ticket_remove_user',  defLabel: '🚫 Entfernen',         defStyle: ButtonStyle.Secondary,  defEnabled: false },
  { key: 'lock',       id: 'ticket_lock',         defLabel: '🔇 Sperren',           defStyle: ButtonStyle.Secondary,  defEnabled: false },
  { key: 'transcript', id: 'ticket_transcript',   defLabel: '📋 Transcript',        defStyle: ButtonStyle.Secondary,  defEnabled: false },
  { key: 'rename',     id: 'ticket_rename',       defLabel: '✏️ Umbenennen',        defStyle: ButtonStyle.Secondary,  defEnabled: false },
];

const STYLE_MAP = [ButtonStyle.Primary, ButtonStyle.Secondary, ButtonStyle.Success, ButtonStyle.Danger];

function buildTicketButtons(cat, guildCfg) {
  const catBtns    = cat?.buttons || {};
  const globalBtns = guildCfg.buttons || {};

  const buttons = [];
  for (const def of TICKET_BUTTON_DEFS) {
    const catCfg    = catBtns[def.key];
    const globalCfg = globalBtns[def.key];

    // Determine if enabled
    let enabled;
    if (catCfg !== undefined && catCfg !== null) {
      enabled = (typeof catCfg === 'object') ? catCfg.enabled !== false : catCfg !== false;
    } else if (globalCfg !== undefined && globalCfg !== null) {
      enabled = (typeof globalCfg === 'object') ? globalCfg.enabled !== false : globalCfg !== false;
    } else {
      enabled = def.defEnabled;
    }
    if (!enabled) continue;

    // Merge config: cat overrides global overrides defaults
    const merged = Object.assign({}, (typeof globalCfg === 'object' && globalCfg) || {}, (typeof catCfg === 'object' && catCfg) || {});
    const label  = merged.label || def.defLabel;
    const style  = STYLE_MAP[(merged.style || 0) - 1] || def.defStyle;

    const btn = new ButtonBuilder().setCustomId(def.id).setLabel(label).setStyle(style);
    if (merged.emoji) { try { btn.setEmoji(merged.emoji); } catch {} }
    buttons.push(btn);
  }

  // Discord allows max 5 buttons per ActionRow
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) {
    rows.push(new ActionRowBuilder().addComponents(buttons.slice(i, i + 5)));
  }
  return rows;
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

// ── Init DB + Login bot ───────────────────────────────────────
(async () => {
  try {
    await cfg.init();
  } catch (e) {
    console.error('❌ DB-Initialisierung fehlgeschlagen:', e.message);
    console.error('   → Prüfe DATABASE_URL in den Umgebungsvariablen.');
    process.exit(1);
  }
  if (BOT_TOKEN) {
    client.login(BOT_TOKEN).catch(e => {
      console.warn('⚠️  Bot-Login fehlgeschlagen:', e.message);
      console.warn('   → Prüfe den BOT_TOKEN in den Umgebungsvariablen.');
    });
  }
})();

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
  const { content, embedMode, embedTitle, embedDescription, embedColor, embedFooter, embedThumbnail, embedImage, embedAuthor } = req.body;

  if (embedMode) {
    // Build embed payload
    if (!embedDescription?.trim() && !embedTitle?.trim()) {
      return res.status(400).json({ error: 'Embed braucht mindestens einen Titel oder eine Beschreibung.' });
    }
    const embed = {};
    if (embedTitle?.trim())       embed.title       = embedTitle.trim();
    if (embedDescription?.trim()) embed.description = embedDescription.trim();
    if (embedColor != null)       embed.color       = parseInt(embedColor) || 0x5865f2;
    if (embedFooter?.trim())      embed.footer      = { text: embedFooter.trim() };
    if (embedThumbnail?.trim())   embed.thumbnail   = { url: embedThumbnail.trim() };
    if (embedImage?.trim())       embed.image       = { url: embedImage.trim() };
    if (embedAuthor?.trim())      embed.author      = { name: embedAuthor.trim() };
    embed.timestamp = new Date().toISOString();
    const body = { embeds: [embed] };
    if (content?.trim()) body.content = content.trim();
    try {
      res.json(await discordBot(`/channels/${req.params.channelId}/messages`, {
        method: 'POST', body: JSON.stringify(body),
      }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  } else {
    if (!content || !content.trim()) return res.status(400).json({ error: 'Nachrichteninhalt fehlt' });
    try {
      res.json(await discordBot(`/channels/${req.params.channelId}/messages`, {
        method: 'POST', body: JSON.stringify({ content: content.trim() }),
      }));
    } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
  }
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

// ════════════════════════════════════════════════════════════
//  AUTOROLE API ROUTES
// ════════════════════════════════════════════════════════════

// GET autorole config
app.get('/api/guilds/:id/autorole-config', requireAuth, (req, res) => {
  try {
    const guildCfg = cfg.getGuild(req.params.id);
    res.json(guildCfg.autorole || { enabled: false, dmMessage: '', rules: [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT autorole config
app.put('/api/guilds/:id/autorole-config', requireAuth, (req, res) => {
  try {
    const guildCfg = cfg.getGuild(req.params.id);
    guildCfg.autorole = req.body;
    cfg.saveGuild(req.params.id, guildCfg);
    res.json(guildCfg.autorole);
  } catch (e) { res.status(500).json({ error: e.message }); }
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
//  SERVER LOG API ROUTES
// ════════════════════════════════════════════════════════════

app.get('/api/guilds/:id/serverlog-config', requireAuth, (req, res) => {
  try {
    const guildCfg = cfg.getGuild(req.params.id);
    res.json(guildCfg.serverLog || {
      enabled: false,
      channels: { messages: null, members: null, voice: null, roles: null, channels: null, moderation: null, server: null },
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/guilds/:id/serverlog-config', requireAuth, (req, res) => {
  try {
    const guildCfg = cfg.getGuild(req.params.id);
    guildCfg.serverLog = req.body;
    cfg.saveGuild(req.params.id, guildCfg);
    res.json(guildCfg.serverLog);
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
