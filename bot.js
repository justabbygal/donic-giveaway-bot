const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require('discord.js');
const dotenv = require('dotenv');
const { Pool } = require('pg');
const axios = require('axios');

if (process.env.NODE_ENV !== 'production') {
  dotenv.config();
}
console.log('All env vars:', Object.keys(process.env).slice(0, 10));
// ============================================================================
// DATABASE SETUP
// ============================================================================

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

// Initialize database schema
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_map (
        discord_user_id TEXT PRIMARY KEY,
        thrill_username TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS eligibility_cache (
        thrill_username TEXT PRIMARY KEY,
        last_xp INTEGER,
        last_under_donic INTEGER,
        last_checked_at BIGINT NOT NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS templates (
        guild_id TEXT,
        template_id TEXT,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        duration TEXT,
        num_winners INTEGER,
        auto_check INTEGER,
        min_xp INTEGER,
        amount REAL,
        currency TEXT,
        tiers TEXT,
        with_member TEXT,
        additional_requirements TEXT,
        PRIMARY KEY (guild_id, template_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS server_settings (
        guild_id TEXT PRIMARY KEY,
        default_type TEXT,
        default_duration INTEGER,
        default_currency TEXT,
        default_winners INTEGER,
        default_autocheck INTEGER
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS active_giveaway (
        guild_id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        giveaway_type TEXT NOT NULL,
        min_xp INTEGER NOT NULL,
        additional_requirements TEXT,
        amount REAL,
        currency TEXT,
        tiers TEXT,
        auto_check INTEGER NOT NULL DEFAULT 1,
        hosted_by TEXT NOT NULL,
        with_member TEXT,
        num_winners INTEGER NOT NULL DEFAULT 1,
        eligible_entrants TEXT NOT NULL DEFAULT '[]',
        ineligible_entrants TEXT NOT NULL DEFAULT '[]',
        initial_winners TEXT NOT NULL DEFAULT '[]',
        started_at BIGINT NOT NULL,
        duration_minutes INTEGER,
        ends_at BIGINT,
        is_active INTEGER NOT NULL DEFAULT 1
      )
    `);

    console.log('✅ Database tables initialized');
  } catch (err) {
    console.error('Database initialization error:', err);
  } finally {
    client.release();
  }
}

function dbRun(sql, params = []) {
  return pool.query(sql, params);
}

function dbGet(sql, params = []) {
  return pool.query(sql, params).then(result => result.rows[0]);
}

function dbAll(sql, params = []) {
  return pool.query(sql, params).then(result => result.rows || []);
}

function getBrandEmbed(title) {
  return new EmbedBuilder()
    .setTitle(title)
    .setColor('#6B46C1');
}

function formatXP(xp) {
  if (xp >= 1000000) {
    return (xp / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
  }
  if (xp >= 1000) {
    return (xp / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  }
  return xp.toString();
}

function formatAmount(amount) {
  return `$${amount}`;
}

// Format as Discord relative timestamp - Discord handles countdown automatically
function formatDiscordTimestamp(endTime) {
  // Convert ms to seconds for Discord timestamp format
  // :R = relative time (e.g., "in 5 hours", "2 days ago")
  return `<t:${Math.floor(endTime / 1000)}:R>`;
}

// ============================================================================
// DISCORD BOT
// ============================================================================

// Map to track original Step 1 interactions for cleanup.
const step1Interactions = new Map();

// Map to store Step 1 message IDs so Load Template can find them
const step1MessageIds = new Map();

// Map to track Load Template button interactions so we can dismiss the select menu
const loadTemplateInteractions = new Map();

// Map to store template creation step 1 data
const templateCreationData = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============================================================================
// INTERACTION HANDLER
// ============================================================================

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isCommand()) {
      await handleCommand(interaction);
    } else if (interaction.isButton()) {
      await handleButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await handleSelectMenu(interaction);
    } else if (interaction.isModalSubmit()) {
      await handleModal(interaction);
    }
  } catch (error) {
    console.error('Interaction error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        content: '❌ An error occurred.',
        flags: 64,
      }).catch(() => {});
    }
  }
});

// ============================================================================
// COMMAND HANDLER
// ============================================================================

async function handleCommand(interaction) {
  // Check if user has "gw-mod" role or is admin
const member = interaction.member;
const hasGwModRole = member?.roles.cache.some(role => role.name === 'gw-mod');
const isAdmin = member?.permissions.has('Administrator');

if (!hasGwModRole && !isAdmin) {
  return await interaction.reply({
    content: '❌ You need the "gw-mod" role or admin permissions to use this command.',
    flags: 64,
  });
}
  const { commandName } = interaction;

  if (commandName === 'gw') {
    const subcommandGroup = interaction.options.getSubcommandGroup(false);
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommandGroup === 'template') {
      if (subcommand === 'create') {
        await handleTemplateCreate(interaction);
      } else if (subcommand === 'list') {
        await handleTemplateList(interaction);
      } else if (subcommand === 'delete') {
        await handleTemplateDelete(interaction);
      } else if (subcommand === 'edit') {
        await handleTemplateEdit(interaction);
      }
    } else if (subcommandGroup === 'default') {
      if (subcommand === 'view') {
        await handleDefaultsView(interaction);
      } else if (subcommand === 'set') {
        await handleDefaultsSet(interaction);
      }
    } else if (subcommand === 'start') {
      await handleGiveawayStartModal(interaction);
    } else if (subcommand === 'quick') {
      await handleGiveawayQuickStart(interaction);
    } else if (subcommand === 'end') {
      await handleGiveawayEnd(interaction);
    } else if (subcommand === 'cancel') {
      await handleGiveawayCancel(interaction);
    } else if (subcommand === 'reroll') {
      await handleGiveawayReroll(interaction);
    } else if (subcommand === 'runback') {
      await handleGiveawayRunback(interaction);
    }
  }

  if (commandName === 'gwmap') {
    const subcommand = interaction.options.getSubcommand(false);

    if (subcommand === 'link') {
      await handleMapLink(interaction);
    } else if (subcommand === 'edit') {
      await handleMapEdit(interaction);
    } else if (subcommand === 'delete') {
      await handleMapDelete(interaction);
    } else if (subcommand === 'list') {
      await handleMapList(interaction);
    } else if (subcommand === 'view') {
      await handleMapView(interaction);
    }
  }

  if (commandName === 'gwcheck') {
    const thrillName = interaction.options.getString('thrillname');
    const user = interaction.options.getUser('user');

    if (thrillName) {
      await handleManualCheckByThrill(interaction, thrillName);
    } else if (user) {
      await handleManualCheckByUser(interaction, user);
    }
  }
}

// ============================================================================
// GWMAP HANDLERS
// ============================================================================

async function handleMapLink(interaction) {
  const user = interaction.options.getUser('user');
  const thrillUsername = interaction.options.getString('thrill_username');

  await dbRun(
`INSERT INTO user_map (discord_user_id, thrill_username, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (discord_user_id) DO UPDATE SET thrill_username = EXCLUDED.thrill_username, updated_at = EXCLUDED.updated_at`,
    [user.id, thrillUsername, Date.now()]
  );

  await interaction.reply({
    content: `✅ Linked <@${user.id}> to **${thrillUsername}**`,
    flags: 64,
  });
}

async function handleMapEdit(interaction) {
  const user = interaction.options.getUser('user');
  const newThrillUsername = interaction.options.getString('new_thrill_username');

  const existing = await dbGet(
    'SELECT * FROM user_map WHERE discord_user_id = $1',
    [user.id]
  );

  if (!existing) {
    return await interaction.reply({
      content: `❌ No mapping found for <@${user.id}>. Use \`/gwmap link\` first.`,
      flags: 64,
    });
  }

  await dbRun(
    `UPDATE user_map SET thrill_username = $1, updated_at = $2 WHERE discord_user_id = $3`,
    [newThrillUsername, Date.now(), user.id]
  );

  await interaction.reply({
    content: `✅ Updated <@${user.id}> mapping from **${existing.thrill_username}** to **${newThrillUsername}**`,
    flags: 64,
  });
}

async function handleMapDelete(interaction) {
  const user = interaction.options.getUser('user');

  const existing = await dbGet(
    'SELECT * FROM user_map WHERE discord_user_id = $1',
    [user.id]
  );

  if (!existing) {
    return await interaction.reply({
      content: `❌ No mapping found for <@${user.id}>.`,
      flags: 64,
    });
  }

  await dbRun('DELETE FROM user_map WHERE discord_user_id = $1', [user.id]);

  await interaction.reply({
    content: `✅ Deleted mapping for <@${user.id}> (**${existing.thrill_username}**)`,
    flags: 64,
  });
}

async function handleMapList(interaction) {
  const mappings = await dbAll('SELECT * FROM user_map ORDER BY updated_at DESC');

  if (mappings.length === 0) {
    return await interaction.reply({
      content: '📭 No mappings yet.',
      flags: 64,
    });
  }

  let list = '**User Mappings:**\n';
  for (const m of mappings) {
    list += `• <@${m.discord_user_id}> → **${m.thrill_username}**\n`;
  }

  await interaction.reply({
    content: list,
    flags: 64,
  });
}

async function handleMapView(interaction) {
  const user = interaction.options.getUser('user');

  const mapping = await dbGet(
    'SELECT * FROM user_map WHERE discord_user_id = $1',
    [user.id]
  );

  if (!mapping) {
    return await interaction.reply({
      content: `❌ No mapping found for <@${user.id}>.`,
      flags: 64,
    });
  }

  await interaction.reply({
    content: `<@${user.id}> → **${mapping.thrill_username}**`,
    flags: 64,
  });
}

// ============================================================================
// GIVEAWAY HANDLERS
// ============================================================================

// Function to show giveaway details modal (Step 2) with optional pre-filled values
async function showGiveawayModal(interaction, customId, previousValues = {}) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Giveaway Details - Step 2');

  const memberInput = new TextInputBuilder()
    .setCustomId('gw_member')
    .setLabel('Member to feature')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g., "donic" (or leave blank)')
    .setRequired(false)
    .setValue(previousValues.member || '');

  const amountInput = new TextInputBuilder()
    .setCustomId('gw_amount')
    .setLabel('Amount')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setValue(previousValues.amount || '');

  const minXpInput = new TextInputBuilder()
    .setCustomId('gw_min_xp')
    .setLabel('Minimum XP in thousands')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0')
    .setRequired(false)
    .setValue(previousValues.minXp || '');

  const otherReqInput = new TextInputBuilder()
    .setCustomId('gw_other_req')
    .setLabel('Other Requirements (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g., "Must have voted"')
    .setRequired(false)
    .setValue(previousValues.otherReq || '');

  modal.addComponents(
    new ActionRowBuilder().addComponents(memberInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(minXpInput),
    new ActionRowBuilder().addComponents(otherReqInput)
  );

  await interaction.showModal(modal);
  
  // Extract step1MessageId from customId
  const step1MessageId = customId.split('_')[3]; // gw_start_modal_{messageId}_...
  
  // Dismiss Step 1 message immediately
  const step1Interaction = step1Interactions.get(step1MessageId);
  if (step1Interaction) {
    try {
      await step1Interaction.deleteReply();
      step1Interactions.delete(step1MessageId);
      console.log(`✅ Dismissed Step 1 when entering Step 2`);
    } catch (err) {
      console.error(`⚠️ Could not dismiss Step 1:`, err.message);
    }
  }
  
  // Step 1 is already dismissed above, so no need for timeout handler
}

async function handleGiveawayStartModal(interaction) {
  try {
    await interaction.deferReply({ flags: 64 });
  } catch (err) {
    console.error('Failed to defer reply:', err);
    try {
      return await interaction.reply({
        content: '❌ Failed to start giveaway setup. Please try again.',
        flags: 64,
      });
    } catch (replyErr) {
      console.error('Failed to reply after deferReply error:', replyErr);
      return;
    }
  }

  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (giveaway && giveaway.is_active) {
    return await interaction.editReply({
      content: '⚠️ A giveaway is already active.',
    });
  }

  // Load server defaults
  const settings = await dbGet(
    'SELECT * FROM server_settings WHERE guild_id = $1',
    [interaction.guildId]
  );

  // Check if a template was specified
  const templateName = interaction.options.getString('template');
  let templateData = null;

  if (templateName) {
    templateData = await dbGet(
      'SELECT * FROM templates WHERE guild_id = $1 AND name = $2',
      [interaction.guildId, templateName]
    );

    if (!templateData) {
      return await interaction.reply({
        content: `❌ Template "${templateName}" not found.`,
        flags: 64,
      });
    }
  }

const selections = {
    type: templateData?.type || settings?.default_type || '50/50 Buy Split',
    duration: String(templateData?.duration || settings?.default_duration || '2'),
    currency: templateData?.currency || settings?.default_currency || 'CAD',
    winners: String(templateData?.num_winners || settings?.default_winners || '1'),
    autoCheck: templateData ? (templateData.auto_check === 1 ? true : false) : (settings?.default_autocheck === 1 ? true : settings?.default_autocheck === 0 ? false : true),
  };

  // Store template data for Step 2 preloading
  if (templateData) {
    templateCreationData.set(interaction.id, {
      withMember: templateData.with_member,
      amount: templateData.amount,
      minXp: templateData.min_xp,
      additionalRequirements: templateData.additional_requirements,
    });
  }

const updateEmbed = () => {
    const embed = getBrandEmbed('⚙️ Giveaway Settings - Step 1');
    return embed;
  };

  // Function to rebuild all components with current selections
  const buildComponents = () => {
    const typeSelect = new StringSelectMenuBuilder()
      .setCustomId('gw_type_select')
      .setPlaceholder('Giveaway Type')
      .addOptions(
        { label: '50/50 Buy Split', value: '50/50 Buy Split', default: selections.type === '50/50 Buy Split' },
        { label: 'Tip', value: 'Tip', default: selections.type === 'Tip' },
        { label: 'Custom', value: 'Custom', default: selections.type === 'Custom' }
      );

    const durationSelect = new StringSelectMenuBuilder()
      .setCustomId('gw_duration_select')
      .setPlaceholder('Duration')
      .addOptions(
        Array.from({ length: 15 }, (_, idx) => ({
          label: `${idx + 1} minute${idx + 1 > 1 ? 's' : ''}`,
          value: String(idx + 1),
          default: String(idx + 1) === selections.duration,
        }))
      );

    const currencySelect = new StringSelectMenuBuilder()
      .setCustomId('gw_currency_select')
      .setPlaceholder('Currency')
      .addOptions(
        { label: 'CAD', value: 'CAD', default: selections.currency === 'CAD' },
        { label: 'USD', value: 'USD', default: selections.currency === 'USD' },
        { label: 'NZD', value: 'NZD', default: selections.currency === 'NZD' }
      );

    const winnersSelect = new StringSelectMenuBuilder()
      .setCustomId('gw_winners_select')
      .setPlaceholder('Number of Winners')
      .addOptions(
        Array.from({ length: 10 }, (_, idx) => ({
          label: idx + 1 === 1 ? '1 winner' : `${idx + 1} winners`,
          value: String(idx + 1),
          default: String(idx + 1) === selections.winners,
        }))
      );

    const autoCheckButton = new ButtonBuilder()
      .setCustomId('gw_autocheck_toggle')
      .setLabel(selections.autoCheck ? '✅ Auto-check: ON' : '❌ Auto-check: OFF')
      .setStyle(selections.autoCheck ? ButtonStyle.Success : ButtonStyle.Danger);

    const loadTemplateButton = new ButtonBuilder()
      .setCustomId('gw_load_template')
      .setLabel('📋 Load Template')
      .setStyle(ButtonStyle.Secondary);

    const proceedButton = new ButtonBuilder()
      .setCustomId('gw_proceed_to_modal')
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary);

    return [
      new ActionRowBuilder().addComponents(typeSelect),
      new ActionRowBuilder().addComponents(durationSelect),
      new ActionRowBuilder().addComponents(currencySelect),
      new ActionRowBuilder().addComponents(winnersSelect),
      new ActionRowBuilder().addComponents(autoCheckButton, loadTemplateButton, proceedButton),
    ];
  };

  const step1Message = await interaction.editReply({
    embeds: [updateEmbed()],
    components: buildComponents(),
  });
  
  // Store the message object directly using user ID as key
  const step1Key = `${interaction.guildId}:${interaction.user.id}`;
  step1MessageIds.set(step1Key, step1Message);
  
  step1Interactions.set(interaction.id, interaction);

  const filter = (i) => i.user.id === interaction.user.id;
  const collector = interaction.channel.createMessageComponentCollector({ filter, time: 300000 });

  collector.on('collect', async (i) => {
    if (i.customId === 'gw_type_select') {
      selections.type = i.values[0];
      await i.update({ embeds: [updateEmbed()], components: buildComponents() });
    } else if (i.customId === 'gw_duration_select') {
      selections.duration = i.values[0];
      await i.update({ embeds: [updateEmbed()], components: buildComponents() });
    } else if (i.customId === 'gw_currency_select') {
      selections.currency = i.values[0];
      await i.update({ embeds: [updateEmbed()], components: buildComponents() });
    } else if (i.customId === 'gw_winners_select') {
      selections.winners = i.values[0];
      await i.update({ embeds: [updateEmbed()], components: buildComponents() });
    } else if (i.customId === 'gw_autocheck_toggle') {
      selections.autoCheck = !selections.autoCheck;
      await i.update({ embeds: [updateEmbed()], components: buildComponents() });
    } else if (i.customId === 'gw_load_template') {
      // Show template list in a separate message
      const templates = await dbAll(
        'SELECT * FROM templates WHERE guild_id = $1 ORDER BY name',
        [interaction.guildId]
      );

      if (templates.length === 0) {
        return await i.reply({
          content: '📭 No templates available.',
          flags: 64,
        });
      }

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('gw_load_template_select')
        .setPlaceholder('Pick a template to load')
        .addOptions(
          templates.map(t => ({
            label: t.name,
            value: t.template_id,
            description: `${t.type} • ${t.duration}m • ${t.num_winners} winner${t.num_winners > 1 ? 's' : ''}`,
          }))
        );

      await i.reply({
        content: '**Select a template to load:**',
        components: [new ActionRowBuilder().addComponents(selectMenu)],
        flags: 64,
      });

      // Store this interaction so we can delete the select message when template is chosen
      const loadKey = `${interaction.guildId}:${interaction.user.id}`;
      loadTemplateInteractions.set(loadKey, i);
    } else if (i.customId === 'gw_load_template_select') {
      // Load template values into selections
      const templateId = i.values[0];
      const template = await dbGet(
        'SELECT * FROM templates WHERE template_id = $1',
        [templateId]
      );

      if (template) {
        selections.type = template.type;
        selections.duration = String(template.duration);
        selections.currency = template.currency;
        selections.winners = String(template.num_winners);
        selections.autoCheck = template.auto_check === 1 ? true : false;

        // Store Step 2 template values for preloading in the modal
        templateCreationData.set(interaction.id, {
          withMember: template.with_member,
          amount: template.amount,
          minXp: template.min_xp,
          additionalRequirements: template.additional_requirements,
        });

        // Delete the Load Template select message
        try {
          const loadKey = `${i.guildId}:${i.user.id}`;
          const loadInteraction = loadTemplateInteractions.get(loadKey);
          if (loadInteraction) {
            await loadInteraction.deleteReply();
            loadTemplateInteractions.delete(loadKey);
          }
        } catch (err) {
          console.error('Failed to delete Load Template message:', err);
        }

        // Acknowledge the interaction
        await i.deferUpdate();

        // Update Step 1 message with template values
        try {
          await interaction.editReply({
            embeds: [updateEmbed()],
            components: buildComponents(),
          });
        } catch (err) {
          console.error('Failed to update Step 1 message:', err);
        }
      } else {
        // Template not found - show error
        await i.reply({
          content: '❌ Template not found.',
          flags: 64,
        });
      }
    } else if (i.customId === 'gw_proceed_to_modal') {
      const customId = `gw_start_modal_${interaction.id}_${Buffer.from(selections.type).toString('base64')}_${selections.duration}_${selections.currency}_${selections.winners}_${selections.autoCheck}`;

      // Get any preloaded template data
      const templateValues = templateCreationData.get(interaction.id) || {};

      try {
        await showGiveawayModal(i, customId, {
          member: templateValues.withMember || '',
          amount: templateValues.amount ? String(templateValues.amount) : '',
          minXp: templateValues.minXp ? String(templateValues.minXp) : '',
          otherReq: templateValues.additionalRequirements || null,
        });
        collector.stop(); // Only stop after modal is successfully shown
      } catch (err) {
        console.error('Error showing modal:', err);
        await i.reply({
          content: '❌ Failed to open giveaway details. Please try clicking Next again.',
          flags: 64,
        }).catch(() => {});
        // Collector keeps running - user can try Next again
      }
    }
  });

  // Clean up when collector ends
  collector.on('end', () => {
    const step1Key = `${interaction.guildId}:${interaction.user.id}`;
    step1MessageIds.delete(step1Key);
    step1Interactions.delete(interaction.id);
  });
}

// Quick start - skips Step 1 and shows Step 2 with default selections
async function handleGiveawayQuickStart(interaction) {
  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (giveaway && giveaway.is_active) {
    return await interaction.reply({
      content: '⚠️ A giveaway is already active.',
      flags: 64,
    });
  }

  const templateName = interaction.options.getString('template_name');

  // ===== PATH 1: TEMPLATE PROVIDED - CREATE GIVEAWAY IMMEDIATELY =====
  if (templateName) {
    await interaction.deferReply({ flags: 64 });

    // Load template
    const template = await dbGet(
      'SELECT * FROM templates WHERE guild_id = $1 AND name = $2',
      [interaction.guildId, templateName]
    );

    if (!template) {
      return await interaction.editReply({
        content: `❌ Template **${templateName}** not found.`,
      });
    }

    // Extract all fields from template
    const type = template.type;
    const duration = parseInt(template.duration) || 2;
    const numWinners = parseInt(template.num_winners) || 1;
    const autoCheck = template.auto_check === 1 ? 1 : 0;
    const minXp = parseInt(template.min_xp) || 0;
    const amount = template.amount ? parseFloat(template.amount) : null;
    const currency = template.currency || 'CAD';
    const withMember = template.with_member || null;
    const otherReq = template.additional_requirements || null;

    const channel = interaction.channel;

    // Build title
    let title = `GIVEAWAY:`;
    if (type !== 'Custom') {
      if (amount !== null) {
        title += ` ${formatAmount(amount)} ${currency}`;
      }
      title += ` ${type}`;
      if (withMember) {
        title += ` with ${withMember}!`;
      } else {
        title += '!';
      }
    } else {
      // Custom type - only add member if specified
      if (withMember) {
        title += ` with ${withMember}!`;
      }
    }

    const embed = getBrandEmbed(title);
    
    const endTime = Date.now() + duration * 60000;

    // Build requirements text
    let reqText = '';
    if (minXp > 0) {
      reqText += `• ${minXp}k XP`;
    }
    if (otherReq) {
      const reqLines = otherReq.split('\n');
      if (reqLines.length > 0) {
        if (reqText) {
          reqText += '\n';
        }
        reqText += reqLines.map(line => {
          if (!line.trim()) {
            return '';
          }
          if (line.trim().startsWith('|')) {
            return line.trim().substring(1);
          }
          return `• ${line}`;
        }).join('\n');
      }
    }

    if (!reqText) {
      reqText = 'None';
    }

    const discordTimestamp = formatDiscordTimestamp(endTime);

    // Build description with hosted by and winner/entry info
    const descParts = [
      '═════════════════════════\n⚠️ **MUST BE UNDER CODE *DONIC*** ⚠️\n═════════════════════════',
      `Hosted by: <@${interaction.user.id}>\n`,
      `Winners: ${numWinners}`,
      `Entries: 0`
    ];
    
    if (autoCheck) {
      descParts.push(`Ineligible: 0\n─────────────────────────`);
    } else {
      descParts.push(`─────────────────────────`);
    }

    embed.setDescription(descParts.join('\n'));
 

embed.addFields(
      { name: 'DETAILS:', value: reqText, inline: false }
    );

embed.addFields(
  { name: '\u200b', value: '\u200b', inline: false }
);    

embed.addFields(
      { name: '🕐 Ends in:', value: `${discordTimestamp}`, inline: false }
    );

    const enterButton = new ButtonBuilder()
      .setCustomId('enter_giveaway')
      .setLabel('Enter Giveaway')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(enterButton);

    const message = await channel.send({ embeds: [embed], components: [row] });

    // Insert into database
    await dbRun('DELETE FROM active_giveaway WHERE guild_id = $1', [interaction.guildId]);

    await dbRun(
      `INSERT INTO active_giveaway 
       (guild_id, channel_id, message_id, giveaway_type, min_xp, additional_requirements, amount, currency, auto_check, hosted_by, with_member, num_winners, eligible_entrants, ineligible_entrants, initial_winners, started_at, duration_minutes, ends_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        interaction.guildId,
        channel.id,
        message.id,
        type,
        minXp,
        otherReq,
        amount,
        currency,
        autoCheck,
        interaction.user.id,
        withMember,
        numWinners,
        '[]',
        '[]',
        '[]',
        Date.now(),
        duration,
        endTime,
        1,
      ]
    );

    await interaction.editReply({
      content: `✅ Giveaway started from template **${templateName}**!`,
    });

    startGiveawayUpdateLoop(interaction.guildId);
    startAutoEndTimer(interaction.guildId, endTime);

    return;
  }

  // ===== PATH 2: NO TEMPLATE - SHOW STEP 2 MODAL (DEFAULT BEHAVIOR) =====

  // Load server defaults
  const settings = await dbGet(
    'SELECT * FROM server_settings WHERE guild_id = $1',
    [interaction.guildId]
  );

  // Use default Step 1 selections from database or fallback to hardcoded defaults
  const defaultSelections = {
    type: settings?.default_type || '50/50 Buy Split',
    duration: String(settings?.default_duration || '2'),
    currency: settings?.default_currency || 'CAD',
    winners: String(settings?.default_winners || '1'),
    autoCheck: settings?.default_autocheck === 1 ? true : settings?.default_autocheck === 0 ? false : true,
  };

  // Store the interaction for later cleanup (just like Step 1)
  step1Interactions.set(interaction.id, interaction);

  // Create the modal with interaction ID and default values embedded in customId
  const customId = `gw_start_modal_${interaction.id}_${Buffer.from(defaultSelections.type).toString('base64')}_${defaultSelections.duration}_${defaultSelections.currency}_${defaultSelections.winners}_${defaultSelections.autoCheck}`;

  // Show Step 2 modal immediately with empty fields
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle('Giveaway Details - Step 2');

  const memberInput = new TextInputBuilder()
    .setCustomId('gw_member')
    .setLabel('Member to feature')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('e.g., "donic" (or leave blank)')
    .setRequired(false);

  const amountInput = new TextInputBuilder()
    .setCustomId('gw_amount')
    .setLabel('Amount')
    .setStyle(TextInputStyle.Short)
    .setRequired(false);

  const minXpInput = new TextInputBuilder()
    .setCustomId('gw_min_xp')
    .setLabel('Minimum XP *in thousands*')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('0')
    .setRequired(false);

  const otherReqInput = new TextInputBuilder()
    .setCustomId('gw_other_req')
    .setLabel('Other Requirements (optional)')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('e.g., "Must have voted"')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(memberInput),
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(minXpInput),
    new ActionRowBuilder().addComponents(otherReqInput)
  );

  await interaction.showModal(modal);
}


async function handleGiveawayEnd(interaction) {
  await interaction.deferReply({ flags: 64 });
  
  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (!giveaway || !giveaway.is_active) {
    return await interaction.editReply({
      content: '❌ No active giveaway.',
    });
  }

  const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
  const channel = await client.channels.fetch(giveaway.channel_id);
  const message = await channel.messages.fetch(giveaway.message_id);

  if (eligible.length === 0) {
    await dbRun('UPDATE active_giveaway SET is_active = 0 WHERE guild_id = $1', [
      interaction.guildId,
    ]);
    
    // Stop the update loop before editing
    if (updateLoops.has(interaction.guildId)) {
      clearInterval(updateLoops.get(interaction.guildId));
      updateLoops.delete(interaction.guildId);
    }
    
    // Edit the original message for no eligible entrants
    try {
      const embed = EmbedBuilder.from(message.embeds[0]);
      const currentTime = new Date();
      const formattedTime = currentTime.toLocaleString('en-US', { 
        month: 'numeric', 
        day: 'numeric', 
        year: 'numeric', 
        hour: 'numeric', 
        minute: '2-digit', 
        second: '2-digit',
        hour12: true
      });
      
      const fields = embed.data.fields || [];
      const newFields = [];
      
      for (const f of fields) {
        if (f.name === '🕐 Ends in:') {
          newFields.push({ name: '🕐 Ends in:', value: `This giveaway has ended`, inline: f.inline });
        } else {
          newFields.push(f);
        }
      }
      
      newFields.push({ name: '⚠️ Result:', value: 'No eligible entrants', inline: false });
      embed.setFields(newFields);
      await message.edit({ embeds: [embed], components: [] });
      console.log(`✅ Updated message - no eligible entrants`);
    } catch (err) {
      console.error(`❌ Failed to update giveaway message:`, err.message);
    }
    
    // Send announcement in channel
    try {
      await channel.send(`\n⚠️ **Giveaway Ended - No Eligible Entrants**`);
      console.log(`✅ Sent announcement message`);
    } catch (err) {
      console.error(`❌ Failed to send announcement:`, err.message);
    }
    
    return await interaction.editReply({
      content: '⚠️ No eligible entrants.',
    });
  }

  const winnerIds = await selectWinners(eligible, giveaway.num_winners, interaction.guildId);
  
  // Stop the update loop before editing
  if (updateLoops.has(interaction.guildId)) {
    clearInterval(updateLoops.get(interaction.guildId));
    updateLoops.delete(interaction.guildId);
  }

  await dbRun('UPDATE active_giveaway SET initial_winners = $1 WHERE guild_id = $2', [
    JSON.stringify(winnerIds),
    interaction.guildId,
  ]);

  let winnerListText = '';
  let announcement = '\n**Giveaway Ended!**\n\n🎉 **Congratulations**\n';

  for (const winnerId of winnerIds) {
    const userMap = await dbGet(
      'SELECT thrill_username FROM user_map WHERE discord_user_id = $1',
      [winnerId]
    );

    let winnerText = `<@${winnerId}>`;

    if (giveaway.auto_check && userMap) {
      const eligibility = await checkEligibility(
        userMap.thrill_username,
        giveaway.min_xp
      );

      if (eligibility.requiresManualCheck) {
        winnerText += ` (Please comment *fresh* screenshots of **code Donic + XP**)`;
      } else if (eligibility.blocked) {
        winnerText += ` ⚠️ **Ineligible**: ${eligibility.reason}`;
      } else {
        winnerText += ` ⭐ XP: ${formatXP(eligibility.xp)}`;
      }
    } else if (!giveaway.auto_check) {
      winnerText += ` (Please comment *fresh* screenshots of **code Donic + XP**)`;
    }

    winnerListText += winnerText + '\n';
    announcement += winnerText + '\n';
  }

  // Edit the original message with winners
  try {
    const embed = EmbedBuilder.from(message.embeds[0]);
    const currentTime = new Date();
    const formattedTime = currentTime.toLocaleString('en-US', { 
      month: 'numeric', 
      day: 'numeric', 
      year: 'numeric', 
      hour: 'numeric', 
      minute: '2-digit', 
      second: '2-digit',
      hour12: true
    });
    
    const fields = embed.data.fields || [];
    const newFields = [];
    
    for (const f of fields) {
      if (f.name === '🕐 Ends in:') {
        newFields.push({ name: '🕐 Ends in:', value: `This giveaway has ended`, inline: f.inline });
      } else {
        newFields.push(f);
      }
    }
    
    newFields.push({ name: '🎉 Winner(s):', value: winnerListText.trim(), inline: false });
    embed.setFields(newFields);
    await message.edit({ embeds: [embed], components: [] });
    console.log(`✅ Updated message with winners`);
  } catch (err) {
    console.error(`❌ Failed to update giveaway message:`, err.message);
  }

  // Send announcement in channel
  try {
    await channel.send(announcement);
    console.log(`✅ Sent announcement message`);
  } catch (err) {
    console.error(`❌ Failed to send announcement:`, err.message);
  }

  await dbRun('UPDATE active_giveaway SET is_active = 0 WHERE guild_id = $1', [
    interaction.guildId,
  ]);

  await interaction.editReply({
    content: `✅ Giveaway ended.`,
  });
}

async function handleGiveawayCancel(interaction) {
  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (!giveaway || !giveaway.is_active) {
    return await interaction.reply({
      content: '❌ No active giveaway.',
      flags: 64,
    });
  }

  await dbRun('UPDATE active_giveaway SET is_active = 0 WHERE guild_id = $1', [
    interaction.guildId,
  ]);

  await interaction.reply({
    content: '✅ Giveaway cancelled.',
    flags: 64,
  });
}

async function handleGiveawayReroll(interaction) {
  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (!giveaway) {
    return await interaction.reply({
      content: '❌ No giveaway found.',
      flags: 64,
    });
  }

  const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
  const initialWinners = JSON.parse(giveaway.initial_winners || '[]');

  const availableForReroll = eligible.filter((id) => !initialWinners.includes(id));

  if (availableForReroll.length === 0) {
    return await interaction.reply({
      content: '❌ No eligible entrants available for reroll (initial winners excluded).',
      flags: 64,
    });
  }

  const winnerIds = await selectWinners(availableForReroll, giveaway.num_winners, interaction.guildId);
  const channel = await client.channels.fetch(giveaway.channel_id);

  let announcement = '🎰 **Reroll Winners:**\n\n';
  for (const winnerId of winnerIds) {
    announcement += `<@${winnerId}>\n`;
  }

  await channel.send(announcement);

  await interaction.reply({
    content: `✅ Reroll complete (initial winners excluded).`,
    flags: 64,
  });
}

async function handleGiveawayRunback(interaction) {
  await interaction.deferReply({ flags: 64 });

  // Get the most recent giveaway for this guild
  const lastGiveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1 ORDER BY started_at DESC LIMIT 1',
    [interaction.guildId]
  );

  if (!lastGiveaway) {
    return await interaction.editReply({
      content: '❌ No previous giveaways found in this server.',
    });
  }

  // Store the values for Step 1 display
  const step1Data = {
    type: lastGiveaway.giveaway_type,
    duration: lastGiveaway.duration_minutes,
    currency: lastGiveaway.currency,
    numWinners: lastGiveaway.num_winners,
    autoCheck: lastGiveaway.auto_check === 1 ? true : false,
    minXp: lastGiveaway.min_xp,
    amount: lastGiveaway.amount,
    withMember: lastGiveaway.with_member,
    otherReq: lastGiveaway.additional_requirements,
  };

  // Show Step 1 confirmation
  const summaryFields = [
    `**Type:** ${step1Data.type}`,
    `**Duration:** ${step1Data.duration} minute${step1Data.duration > 1 ? 's' : ''}`,
    `**Winners:** ${step1Data.numWinners}`,
    `**Currency:** ${step1Data.currency}`,
    `**Auto-check:** ${step1Data.autoCheck ? '✅' : '❌'}`,
  ];

  if (step1Data.minXp > 0) summaryFields.push(`**Min XP:** ${step1Data.minXp}k`);
  if (step1Data.amount) summaryFields.push(`**Amount:** ${formatAmount(step1Data.amount)}`);
  if (step1Data.withMember) summaryFields.push(`**Featured Member:** ${step1Data.withMember}`);
  if (step1Data.otherReq) summaryFields.push(`**Additional Requirements:** Yes`);

  const runbackId = Date.now();
  const confirmButton = new ButtonBuilder()
    .setCustomId(`gw_runback_confirm_${runbackId}`)
    .setLabel('✅ Run this giveaway')
    .setStyle(ButtonStyle.Success);

  const cancelButton = new ButtonBuilder()
    .setCustomId(`gw_runback_cancel_${runbackId}`)
    .setLabel('❌ Cancel')
    .setStyle(ButtonStyle.Danger);

  const embed = getBrandEmbed('Runback Confirmation')
    .setDescription('Using the exact same settings as the last giveaway:')
    .addFields(
      summaryFields.map(field => ({ name: field.split(': ')[0].replace(/\*\*/g, ''), value: field.split(': ')[1], inline: true }))
    );

  const customId = `runback_${runbackId}`;
  templateCreationData.set(customId, step1Data);

  await interaction.editReply({
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(confirmButton, cancelButton),
    ],
  });

  // Handle button interactions
  const filter = i => i.user.id === interaction.user.id && i.customId.includes(`gw_runback`) && i.customId.includes(String(runbackId));
  const collector = interaction.channel.createMessageComponentCollector({ filter, time: 60000 });

  collector.on('collect', async (i) => {
    if (i.customId === `gw_runback_confirm_${runbackId}`) {
      await i.deferReply({ flags: 64 });

      // Start the new giveaway with the same values
      const endTime = Date.now() + step1Data.duration * 60000;
      const newGiveaway = {
        guild_id: interaction.guildId,
        channel_id: interaction.channelId,
        giveaway_type: step1Data.type,
        min_xp: step1Data.minXp,
        amount: step1Data.amount,
        currency: step1Data.currency,
        with_member: step1Data.withMember,
        additional_requirements: step1Data.otherReq,
        num_winners: step1Data.numWinners,
        auto_check: step1Data.autoCheck ? 1 : 0,
        hosted_by: interaction.user.id,
        started_at: Date.now(),
        ends_at: endTime,
        duration_minutes: step1Data.duration,
      };

      // Create the giveaway message
      let title = `GIVEAWAY:`;
      if (step1Data.type !== 'Custom') {
        if (step1Data.amount !== null && step1Data.amount !== undefined) {
          title += ` ${formatAmount(step1Data.amount)} ${step1Data.currency}`;
        }
        title += ` ${step1Data.type}`;
        if (step1Data.withMember) {
          title += ` with ${step1Data.withMember}!`;
        } else {
          title += '!';
        }
      } else {
        if (step1Data.withMember) {
          title += ` with ${step1Data.withMember}!`;
        }
      }

      const giveawayEmbed = getBrandEmbed(title);

      // Build requirements text
      let reqText = '';
      if (step1Data.minXp > 0) {
        reqText += `• ${step1Data.minXp}k XP`;
      }
      if (step1Data.otherReq) {
        const reqLines = step1Data.otherReq.split('\n');
        if (reqLines.length > 0) {
          if (reqText) {
            reqText += '\n';
          }
          reqText += reqLines.map(line => {
            if (!line.trim()) {
              return '';
            }
            if (line.trim().startsWith('|')) {
              return line.trim().substring(1);
            }
            return `• ${line}`;
          }).join('\n');
        }
      }

      if (!reqText) {
        reqText = 'None';
      }

      const discordTimestamp = formatDiscordTimestamp(endTime);

      const descParts = [
        '═════════════════════════\n⚠️ **MUST BE UNDER CODE *DONIC*** ⚠️\n═════════════════════════',
        `Hosted by: <@${interaction.user.id}>\n`,
        `Winners: ${step1Data.numWinners}`,
        `Entries: 0`
      ];
      
      if (step1Data.autoCheck) {
        descParts.push(`Ineligible: 0\n─────────────────────────`);
      } else {
        descParts.push(`─────────────────────────`);
      }

      giveawayEmbed.setDescription(descParts.join('\n'));
      giveawayEmbed.addFields({ name: 'DETAILS:', value: reqText, inline: false });
      giveawayEmbed.addFields({ name: '\u200b', value: '\u200b', inline: false });
      giveawayEmbed.addFields({ name: '🕐 Ends in:', value: `${discordTimestamp}`, inline: false });

      const enterButton = new ButtonBuilder()
        .setCustomId('enter_giveaway')
        .setLabel('Enter Giveaway')
        .setStyle(ButtonStyle.Primary);

      const giveawayMessage = await interaction.channel.send({
        embeds: [giveawayEmbed],
        components: [new ActionRowBuilder().addComponents(enterButton)],
      });

      // Store in database
      await dbRun(
        `INSERT INTO active_giveaway (guild_id, channel_id, message_id, giveaway_type, min_xp, amount, currency, with_member, additional_requirements, num_winners, auto_check, hosted_by, started_at, ends_at, duration_minutes, is_active, eligible_entrants, ineligible_entrants)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, '[]', '[]')`,
        [
          interaction.guildId,
          interaction.channelId,
          giveawayMessage.id,
          newGiveaway.giveaway_type,
          newGiveaway.min_xp,
          newGiveaway.amount,
          newGiveaway.currency,
          newGiveaway.with_member,
          newGiveaway.additional_requirements,
          newGiveaway.num_winners,
          newGiveaway.auto_check,
          newGiveaway.hosted_by,
          newGiveaway.started_at,
          newGiveaway.ends_at,
          newGiveaway.duration_minutes,
        ]
      );

      // Start update loop and timer
      startGiveawayUpdateLoop(interaction.guildId);
      startAutoEndTimer(interaction.guildId, endTime);

      await i.editReply({
        content: `✅ Giveaway started! ${giveawayMessage.url}`,
      });
    } else if (i.customId === `gw_runback_cancel_${runbackId}`) {
      await i.deferReply({ flags: 64 });
      await i.editReply({
        content: '❌ Cancelled.',
      });
    }
  });
}

async function handleTemplateCreate(interaction) {
  const name = interaction.options.getString('name');

  const templateId = `template_create_${Date.now()}`;

  // Store initial data
  templateCreationData.set(templateId, {
    name,
    type: null,
    duration: null,
    currency: 'CAD',
    numWinners: null,
    autoCheck: true,
  });

  // Type select menu
  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId(`template_type_select_${templateId}`)
    .setPlaceholder('Giveaway Type')
    .addOptions([
      { label: '50/50 Buy Split', value: '50/50 Buy Split' },
      { label: 'Tip', value: 'Tip' },
      { label: 'Custom', value: 'Custom' },
    ]);

  // Duration select menu (1-15 minutes)
  const durationSelect = new StringSelectMenuBuilder()
    .setCustomId(`template_duration_select_${templateId}`)
    .setPlaceholder('Duration')
    .addOptions(
      Array.from({ length: 15 }, (_, idx) => ({
        label: `${idx + 1} minute${idx + 1 > 1 ? 's' : ''}`,
        value: String(idx + 1),
      }))
    );

  // Currency select menu
  const currencySelect = new StringSelectMenuBuilder()
    .setCustomId(`template_currency_select_${templateId}`)
    .setPlaceholder('Currency')
    .addOptions([
      { label: 'CAD', value: 'CAD' },
      { label: 'USD', value: 'USD' },
      { label: 'NZD', value: 'NZD' },
    ]);

  // Winners select menu
  const winnersSelect = new StringSelectMenuBuilder()
    .setCustomId(`template_winners_select_${templateId}`)
    .setPlaceholder('Number of Winners')
    .addOptions(
      Array.from({ length: 10 }, (_, idx) => ({
        label: idx + 1 === 1 ? '1 winner' : `${idx + 1} winners`,
        value: String(idx + 1),
      }))
    );

  // Auto-check toggle button
  const autoCheckButton = new ButtonBuilder()
    .setCustomId(`template_autocheck_toggle_${templateId}`)
    .setLabel('✅ Auto-check: ON')
    .setStyle(ButtonStyle.Success);

  // Continue button
  const continueButton = new ButtonBuilder()
    .setCustomId(`template_select_continue_${templateId}`)
    .setLabel('Next')
    .setStyle(ButtonStyle.Primary);

  await interaction.reply({
    content: `**Creating Template: ${name}**\n\nSelect the template settings:`,
    components: [
      new ActionRowBuilder().addComponents(typeSelect),
      new ActionRowBuilder().addComponents(durationSelect),
      new ActionRowBuilder().addComponents(currencySelect),
      new ActionRowBuilder().addComponents(winnersSelect),
      new ActionRowBuilder().addComponents(autoCheckButton, continueButton),
    ],
    flags: 64,
  });
}

async function handleTemplateEdit(interaction) {
  const templateName = interaction.options.getString('templatename');

  // Fetch template from database
  const template = await dbGet(
    'SELECT * FROM templates WHERE guild_id = $1 AND name = $2',
    [interaction.guildId, templateName]
  );

  if (!template) {
    return await interaction.reply({
      content: `❌ Template "${templateName}" not found.`,
      flags: 64,
    });
  }

  const templateId = `template_edit_${Date.now()}`;

  // Store template data with edit flag
  templateCreationData.set(templateId, {
    name: template.name,
    type: template.type,
    duration: template.duration,
    currency: template.currency,
    numWinners: template.num_winners,
    autoCheck: template.auto_check === 1 ? true : false,
    originalTemplateId: template.template_id, // Store original ID for update
    isEditing: true,
    // Step 2 fields
    minXp: template.min_xp,
    amount: template.amount,
    withMember: template.with_member,
    additionalRequirements: template.additional_requirements,
  });

  // Type select menu
  const typeSelect = new StringSelectMenuBuilder()
    .setCustomId(`template_type_select_${templateId}`)
    .setPlaceholder('Giveaway Type')
    .addOptions([
      { label: '50/50 Buy Split', value: '50/50 Buy Split', default: template.type === '50/50 Buy Split' },
      { label: 'Tip', value: 'Tip', default: template.type === 'Tip' },
      { label: 'Custom', value: 'Custom', default: template.type === 'Custom' },
    ]);

  // Duration select menu (1-15 minutes)
  const durationSelect = new StringSelectMenuBuilder()
    .setCustomId(`template_duration_select_${templateId}`)
    .setPlaceholder('Duration')
    .addOptions(
      Array.from({ length: 15 }, (_, idx) => ({
        label: `${idx + 1} minute${idx + 1 > 1 ? 's' : ''}`,
        value: String(idx + 1),
        default: Number(template.duration) === idx + 1,
      }))
    );

  // Currency select menu
  const currencySelect = new StringSelectMenuBuilder()
    .setCustomId(`template_currency_select_${templateId}`)
    .setPlaceholder('Currency')
    .addOptions([
      { label: 'CAD', value: 'CAD', default: template.currency === 'CAD' },
      { label: 'USD', value: 'USD', default: template.currency === 'USD' },
      { label: 'NZD', value: 'NZD', default: template.currency === 'NZD' },
    ]);

  // Winners select menu
  const winnersSelect = new StringSelectMenuBuilder()
    .setCustomId(`template_winners_select_${templateId}`)
    .setPlaceholder('Number of Winners')
    .addOptions(
      Array.from({ length: 10 }, (_, idx) => ({
        label: idx + 1 === 1 ? '1 winner' : `${idx + 1} winners`,
        value: String(idx + 1),
        default: template.num_winners === idx + 1,
      }))
    );

  // Auto-check toggle button
  const autoCheckButton = new ButtonBuilder()
    .setCustomId(`template_autocheck_toggle_${templateId}`)
    .setLabel(template.auto_check === 1 ? '✅ Auto-check: ON' : '❌ Auto-check: OFF')
    .setStyle(template.auto_check === 1 ? ButtonStyle.Success : ButtonStyle.Danger);

  // Continue button
  const continueButton = new ButtonBuilder()
    .setCustomId(`template_select_continue_${templateId}`)
    .setLabel('Next')
    .setStyle(ButtonStyle.Primary);

  await interaction.reply({
    content: `**Editing Template: ${templateName}**\n\nModify the settings:`,
    components: [
      new ActionRowBuilder().addComponents(typeSelect),
      new ActionRowBuilder().addComponents(durationSelect),
      new ActionRowBuilder().addComponents(currencySelect),
      new ActionRowBuilder().addComponents(winnersSelect),
      new ActionRowBuilder().addComponents(autoCheckButton, continueButton),
    ],
    flags: 64,
  });
}

async function handleTemplateList(interaction) {
  const templates = await dbAll(
    'SELECT * FROM templates WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (templates.length === 0) {
    return await interaction.reply({
      content: '📭 No templates yet.',
      flags: 64,
    });
  }

  let list = '**Templates:**\n\n';
  for (const t of templates) {
    list += `**${t.name}**\n`;
    list += `• Type: ${t.type}\n`;
    if (t.duration) list += `• Duration: ${t.duration} min\n`;
    if (t.num_winners) list += `• Winners: ${t.num_winners}\n`;
    if (t.auto_check !== null) list += `• Auto-check: ${t.auto_check === 1 ? 'ON' : 'OFF'}\n`;
    if (t.min_xp) list += `• Min XP: ${t.min_xp}k\n`;
    if (t.amount) list += `• Amount: ${formatAmount(t.amount)} ${t.currency || 'CAD'}\n`;
    if (t.with_member) list += `• Featured: ${t.with_member}\n`;
    if (t.additional_requirements) list += `• Requirements: Yes\n`;
    list += '\n';
  }

  await interaction.reply({
    content: list,
    flags: 64,
  });
}

async function handleTemplateDelete(interaction) {
  const name = interaction.options.getString('name');

  await dbRun('DELETE FROM templates WHERE guild_id = $1 AND name = $2', [
    interaction.guildId,
    name,
  ]);

  await interaction.reply({
    content: `✅ Template **${name}** deleted.`,
    flags: 64,
  });
}

async function handleDefaultsView(interaction) {
  const settings = await dbGet(
    'SELECT * FROM server_settings WHERE guild_id = $1',
    [interaction.guildId]
  );

  if (!settings) {
    return await interaction.reply({
      content: '⚙️ No defaults set yet.',
      flags: 64,
    });
  }

  let info = '**Server Defaults (Step 1):**\n';
  info += `Type: ${settings.default_type || 'Not set'}\n`;
  info += `Duration: ${settings.default_duration ? `${settings.default_duration} minute${settings.default_duration > 1 ? 's' : ''}` : 'Not set'}\n`;
  info += `Currency: ${settings.default_currency || 'Not set'}\n`;
  info += `Winners: ${settings.default_winners || 'Not set'}\n`;
  info += `Auto-check: ${settings.default_autocheck === 1 ? '✅ ON' : settings.default_autocheck === 0 ? '❌ OFF' : 'Not set'}\n`;

  await interaction.reply({
    content: info,
    flags: 64,
  });
}

async function handleDefaultsSet(interaction) {
  const settings = await dbGet(
    'SELECT * FROM server_settings WHERE guild_id = $1',
    [interaction.guildId]
  );

  const modal = new ModalBuilder()
    .setCustomId(`defaults_modal_${interaction.guildId}`)
    .setTitle('Set Server Defaults');

  const typeInput = new TextInputBuilder()
    .setCustomId('default_type')
    .setLabel('Type')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('50/50 Buy Split, Tip, or Custom')
    .setRequired(false)
    .setValue(settings?.default_type || '');

  const durationInput = new TextInputBuilder()
    .setCustomId('default_duration')
    .setLabel('Duration (minutes)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('1-15')
    .setRequired(false)
    .setValue(settings?.default_duration?.toString() || '');

  const currencyInput = new TextInputBuilder()
    .setCustomId('default_currency')
    .setLabel('Currency')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('CAD, USD, or NZD')
    .setRequired(false)
    .setValue(settings?.default_currency || '');

  const winnersInput = new TextInputBuilder()
    .setCustomId('default_winners')
    .setLabel('Number of Winners')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('1-10')
    .setRequired(false)
    .setValue(settings?.default_winners?.toString() || '');

  const autocheckInput = new TextInputBuilder()
    .setCustomId('default_autocheck')
    .setLabel('Auto-check')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('true or false')
    .setRequired(false)
    .setValue(settings?.default_autocheck === null ? '' : settings?.default_autocheck === 1 ? 'true' : 'false');

  modal.addComponents(
    new ActionRowBuilder().addComponents(typeInput),
    new ActionRowBuilder().addComponents(durationInput),
    new ActionRowBuilder().addComponents(currencyInput),
    new ActionRowBuilder().addComponents(winnersInput),
    new ActionRowBuilder().addComponents(autocheckInput)
  );

  await interaction.showModal(modal);
}

async function handleManualCheckByThrill(interaction, thrillName) {
  const result = await checkEligibility(thrillName, 0);

  if (result.requiresManualCheck) {
    return await interaction.reply({
      content: `⚠️ API is currently unavailable. Manual check required.`,
      flags: 64,
    });
  }

  if (result.blocked) {
    return await interaction.reply({
      content: `❌ ${result.reason}`,
      flags: 64,
    });
  }

  await interaction.reply({
    content: `✅ **${thrillName}** | XP: ${formatXP(result.xp)} | Under donic: ${result.underDonic ? 'Yes' : 'No'}`,
    flags: 64,
  });
}

async function handleManualCheckByUser(interaction, user) {
  const mapped = await dbGet(
    'SELECT thrill_username FROM user_map WHERE discord_user_id = $1',
    [user.id]
  );

  if (!mapped) {
    return await interaction.reply({
      content: `❌ No Thrill username mapped for <@${user.id}>.`,
      flags: 64,
    });
  }

  const result = await checkEligibility(mapped.thrill_username, 0);

  if (result.requiresManualCheck) {
    return await interaction.reply({
      content: `⚠️ API is currently unavailable. Manual check required.`,
      flags: 64,
    });
  }

  if (result.blocked) {
    return await interaction.reply({
      content: `❌ ${result.reason}`,
      flags: 64,
    });
  }

  await interaction.reply({
    content: `✅ <@${user.id}> (**${mapped.thrill_username}**) | XP: ${formatXP(result.xp)} | Under donic: ${result.underDonic ? 'Yes' : 'No'}`,
    flags: 64,
  });
}

// ============================================================================
// BUTTON HANDLER
// ============================================================================

async function handleButton(interaction) {
  // Handle modal retry button
  if (interaction.customId.startsWith('modal_retry_')) {
    const retryData = failedModalSubmissions.get(interaction.customId);
    
    if (!retryData) {
      return await interaction.reply({
        content: '❌ Retry data expired. Please try again.',
        flags: 64,
      });
    }

    // Verify it's the same user
    if (retryData.userId !== interaction.user.id) {
      return await interaction.reply({
        content: '❌ You cannot retry another user\'s form.',
        flags: 64,
      });
    }

    // Show the modal with their previous values
    await showGiveawayModal(interaction, retryData.customId, {
      member: retryData.member,
      amount: retryData.amount,
      minXp: retryData.minXp,
      otherReq: retryData.otherReq
    });

    // Clean up the retry data
    failedModalSubmissions.delete(interaction.customId);
    return;
  }

  if (interaction.customId === 'enter_giveaway') {
    // Defer immediately to prevent timeout
    await interaction.deferReply({ flags: 64 });

    const giveaway = await dbGet(
      'SELECT * FROM active_giveaway WHERE guild_id = $1',
      [interaction.guildId]
    );

    if (!giveaway || !giveaway.is_active) {
      return await interaction.editReply({
        content: '❌ No active giveaway.',
      });
    }

    const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
    const ineligible = JSON.parse(giveaway.ineligible_entrants || '[]');

    if (eligible.includes(interaction.user.id) || ineligible.includes(interaction.user.id)) {
      return await interaction.editReply({
        content: '✅ You already entered.',
      });
    }

    const mapped = await dbGet(
      'SELECT thrill_username FROM user_map WHERE discord_user_id = $1',
      [interaction.user.id]
    );

    // if (!mapped) {
    //   return await interaction.editReply({
    //     content: '🔗 Please type your Thrill username in the giveaway channel to complete entry.',
    //   });
    // }

    if (giveaway.auto_check && mapped) {
      const result = await checkEligibility(
        mapped.thrill_username,
        giveaway.min_xp
      );

      if (result.requiresManualCheck) {
        eligible.push(interaction.user.id);
        await dbRun(
          'UPDATE active_giveaway SET eligible_entrants = $1 WHERE guild_id = $2',
          [JSON.stringify(eligible), interaction.guildId]
        );
        await updateGiveawayMessage(interaction.guildId);

        return await interaction.editReply({
          content: `🍀 Entered - Good luck!\n⚠️ *Eligibility could not be checked automatically*.\nBe prepared with *fresh* screenshots of **code Donic + XP** if you win.`,
        });
      }

      if (result.blocked) {
        ineligible.push(interaction.user.id);
        await dbRun(
          'UPDATE active_giveaway SET ineligible_entrants = $1 WHERE guild_id = $2',
          [JSON.stringify(ineligible), interaction.guildId]
        );
        await updateGiveawayMessage(interaction.guildId);

        return await interaction.editReply({
          content: `❌ ${result.reason}`,
        });
      }
    }

    eligible.push(interaction.user.id);
    await dbRun(
      'UPDATE active_giveaway SET eligible_entrants = $1 WHERE guild_id = $2',
      [JSON.stringify(eligible), interaction.guildId]
    );

    await updateGiveawayMessage(interaction.guildId);

    await interaction.editReply({
      content: '🍀 Entered - Good luck!',
    });
  }

  // ===== TEMPLATE SELECT CONTINUE BUTTON HANDLER =====
  if (interaction.customId.startsWith('template_select_continue_')) {
    const templateId = interaction.customId.replace('template_select_continue_', '');
    const data = templateCreationData.get(templateId);

    if (!data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over with `/gw template create`.',
        flags: 64,
      });
    }

    // Check if all selections were made
    if (!data.type || !data.duration || !data.numWinners) {
      return await interaction.reply({
        content: '❌ Please select all options (Type, Duration, Currency, Winners) before continuing.',
        flags: 64,
      });
    }

    // Show Modal 2
    const isEditing = data.isEditing;
    const modal2 = new ModalBuilder()
      .setCustomId(`gw_template_modal2_${templateId}`)
      .setTitle(isEditing ? 'Edit Template - Step 2' : 'Create Template - Step 2');

    const memberInput = new TextInputBuilder()
      .setCustomId('template_with_member')
      .setLabel('Member to feature')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., "donic" (or leave blank)')
      .setRequired(false);
    if (data.withMember) memberInput.setValue(data.withMember);

    const amountInput = new TextInputBuilder()
      .setCustomId('template_amount')
      .setLabel('Amount')
      .setStyle(TextInputStyle.Short)
      .setRequired(false);
    if (data.amount) amountInput.setValue(String(data.amount));

    const minXpInput = new TextInputBuilder()
      .setCustomId('template_min_xp')
      .setLabel('Minimum XP *in thousands*')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('0')
      .setRequired(false);
    if (data.minXp) minXpInput.setValue(String(data.minXp));

    const requirementsInput = new TextInputBuilder()
      .setCustomId('template_additional_requirements')
      .setLabel('Other Requirements (optional)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Use Shift+Enter for new lines')
      .setRequired(false);
    if (data.additionalRequirements) requirementsInput.setValue(data.additionalRequirements);

    modal2.addComponents(
      new ActionRowBuilder().addComponents(memberInput),
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(minXpInput),
      new ActionRowBuilder().addComponents(requirementsInput)
    );

    await interaction.showModal(modal2);
  }


  // ===== TEMPLATE AUTO START BUTTON HANDLER =====
  // ===== OLD TEMPLATE CONTINUE BUTTON HANDLER (for Modal 1 flow - deprecated) =====
  if (interaction.customId.startsWith('gw_template_continue_')) {
    const interactionId = interaction.customId.replace('gw_template_continue_', '');
    const modal1Data = templateCreationData.get(interactionId);

    if (!modal1Data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over with `/gw template create`.',
        flags: 64,
      });
    }

    // Show Modal 2
    const modal2 = new ModalBuilder()
      .setCustomId(`gw_template_modal2_${interactionId}`)
      .setTitle('Create Template - Step 2');

    const autoCheckInput = new TextInputBuilder()
      .setCustomId('template_auto_check')
      .setLabel('Auto-check eligibility? (true/false)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('true or false (default: true)')
      .setRequired(false);

    const minXpInput = new TextInputBuilder()
      .setCustomId('template_min_xp')
      .setLabel('Minimum XP (in thousands)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., "10"')
      .setRequired(false);

    const amountInput = new TextInputBuilder()
      .setCustomId('template_amount')
      .setLabel('Amount')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., "50"')
      .setRequired(false);

    const withMemberInput = new TextInputBuilder()
      .setCustomId('template_with_member')
      .setLabel('Member to feature (optional)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('e.g., "donic"')
      .setRequired(false);

    const requirementsInput = new TextInputBuilder()
      .setCustomId('template_additional_requirements')
      .setLabel('Additional Requirements/Info')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Use Shift+Enter for new lines')
      .setRequired(false);

    modal2.addComponents(
      new ActionRowBuilder().addComponents(autoCheckInput),
      new ActionRowBuilder().addComponents(minXpInput),
      new ActionRowBuilder().addComponents(amountInput),
      new ActionRowBuilder().addComponents(withMemberInput),
      new ActionRowBuilder().addComponents(requirementsInput)
    );

    await interaction.showModal(modal2);
  }

  // ===== TEMPLATE AUTO-CHECK TOGGLE BUTTON =====
  if (interaction.customId.startsWith('template_autocheck_toggle_')) {
    const templateId = interaction.customId.replace('template_autocheck_toggle_', '');
    const data = templateCreationData.get(templateId);

    if (!data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over.',
        flags: 64,
      });
    }

    // Toggle auto-check
    data.autoCheck = !data.autoCheck;
    templateCreationData.set(templateId, data);

    // Rebuild all selects with current selections
    const typeSelect = new StringSelectMenuBuilder()
      .setCustomId(`template_type_select_${templateId}`)
      .setPlaceholder('Giveaway Type')
      .addOptions([
        { label: '50/50 Buy Split', value: '50/50 Buy Split', default: data.type === '50/50 Buy Split' },
        { label: 'Tip', value: 'Tip', default: data.type === 'Tip' },
        { label: 'Custom', value: 'Custom', default: data.type === 'Custom' },
      ]);

    const durationSelect = new StringSelectMenuBuilder()
      .setCustomId(`template_duration_select_${templateId}`)
      .setPlaceholder('Duration')
      .addOptions(
        Array.from({ length: 15 }, (_, idx) => ({
          label: `${idx + 1} minute${idx + 1 > 1 ? 's' : ''}`,
          value: String(idx + 1),
          default: data.duration === idx + 1,
        }))
      );

    const currencySelect = new StringSelectMenuBuilder()
      .setCustomId(`template_currency_select_${templateId}`)
      .setPlaceholder('Currency')
      .addOptions([
        { label: 'CAD', value: 'CAD', default: data.currency === 'CAD' },
        { label: 'USD', value: 'USD', default: data.currency === 'USD' },
        { label: 'NZD', value: 'NZD', default: data.currency === 'NZD' },
      ]);

    const winnersSelect = new StringSelectMenuBuilder()
      .setCustomId(`template_winners_select_${templateId}`)
      .setPlaceholder('Number of Winners')
      .addOptions(
        Array.from({ length: 10 }, (_, idx) => ({
          label: idx + 1 === 1 ? '1 winner' : `${idx + 1} winners`,
          value: String(idx + 1),
          default: data.numWinners === idx + 1,
        }))
      );

    const autoCheckButton = new ButtonBuilder()
      .setCustomId(`template_autocheck_toggle_${templateId}`)
      .setLabel(data.autoCheck ? '✅ Auto-check: ON' : '❌ Auto-check: OFF')
      .setStyle(data.autoCheck ? ButtonStyle.Success : ButtonStyle.Danger);

    const continueButton = new ButtonBuilder()
      .setCustomId(`template_select_continue_${templateId}`)
      .setLabel('Next')
      .setStyle(ButtonStyle.Primary);

    await interaction.update({
      components: [
        new ActionRowBuilder().addComponents(typeSelect),
        new ActionRowBuilder().addComponents(durationSelect),
        new ActionRowBuilder().addComponents(currencySelect),
        new ActionRowBuilder().addComponents(winnersSelect),
        new ActionRowBuilder().addComponents(autoCheckButton, continueButton),
      ],
    });
  }
}

// ============================================================================
// SELECT MENU HANDLER
// ============================================================================

async function handleSelectMenu(interaction) {
  // ===== TEMPLATE TYPE SELECT MENU =====
  if (interaction.customId.startsWith('template_type_select_')) {
    const templateId = interaction.customId.replace('template_type_select_', '');
    const data = templateCreationData.get(templateId);

    if (!data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over.',
        flags: 64,
      });
    }

    const type = interaction.values[0];
    data.type = type;
    templateCreationData.set(templateId, data);

    await interaction.deferUpdate();
  }

  // ===== TEMPLATE DURATION SELECT MENU =====
  if (interaction.customId.startsWith('template_duration_select_')) {
    const templateId = interaction.customId.replace('template_duration_select_', '');
    const data = templateCreationData.get(templateId);

    if (!data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over.',
        flags: 64,
      });
    }

    const duration = parseInt(interaction.values[0]);
    data.duration = duration;
    templateCreationData.set(templateId, data);

    await interaction.deferUpdate();
  }

  // ===== TEMPLATE CURRENCY SELECT MENU =====
  if (interaction.customId.startsWith('template_currency_select_')) {
    const templateId = interaction.customId.replace('template_currency_select_', '');
    const data = templateCreationData.get(templateId);

    if (!data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over.',
        flags: 64,
      });
    }

    const currency = interaction.values[0];
    data.currency = currency;
    templateCreationData.set(templateId, data);

    await interaction.deferUpdate();
  }

  // ===== TEMPLATE WINNERS SELECT MENU =====
  if (interaction.customId.startsWith('template_winners_select_')) {
    const templateId = interaction.customId.replace('template_winners_select_', '');
    const data = templateCreationData.get(templateId);

    if (!data) {
      return await interaction.reply({
        content: '❌ Template data expired. Please start over.',
        flags: 64,
      });
    }

    const numWinners = parseInt(interaction.values[0]);
    data.numWinners = numWinners;
    templateCreationData.set(templateId, data);

    await interaction.deferUpdate();
  }
}

// ============================================================================
// MODAL HANDLER
// ============================================================================

async function handleModal(interaction) {
  if (interaction.customId.startsWith('defaults_modal_')) {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      console.error('Failed to defer defaults modal reply:', err);
      return;
    }

    const typeInput = interaction.fields.getTextInputValue('default_type')?.trim() || null;
    const durationInput = interaction.fields.getTextInputValue('default_duration')?.trim();
    const currencyInput = interaction.fields.getTextInputValue('default_currency')?.trim() || null;
    const winnersInput = interaction.fields.getTextInputValue('default_winners')?.trim();
    const autocheckInput = interaction.fields.getTextInputValue('default_autocheck')?.trim().toLowerCase();

    // Validate inputs
    const errors = [];

    if (typeInput && !['50/50 Buy Split', 'Tip', 'Custom'].includes(typeInput)) {
      errors.push('Type must be: 50/50 Buy Split, Tip, or Custom');
    }

    let duration = null;
    if (durationInput) {
      duration = parseInt(durationInput);
      if (isNaN(duration) || duration < 1 || duration > 15) {
        errors.push('Duration must be between 1-15 minutes');
      }
    }

    if (currencyInput && !['CAD', 'USD', 'NZD'].includes(currencyInput)) {
      errors.push('Currency must be: CAD, USD, or NZD');
    }

    let winners = null;
    if (winnersInput) {
      winners = parseInt(winnersInput);
      if (isNaN(winners) || winners < 1 || winners > 10) {
        errors.push('Winners must be between 1-10');
      }
    }

    let autocheck = null;
    if (autocheckInput) {
      if (!['true', 'false', '1', '0', 'on', 'off', 'yes', 'no'].includes(autocheckInput)) {
        errors.push('Auto-check must be: true, false, on, or off');
      } else {
        autocheck = ['true', '1', 'on', 'yes'].includes(autocheckInput) ? 1 : 0;
      }
    }

    if (errors.length > 0) {
      return await interaction.editReply({
        content: `❌ Validation errors:\n${errors.map(e => `• ${e}`).join('\n')}`,
      });
    }

    // Build update query dynamically based on what was provided
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (typeInput !== null) {
      updates.push(`default_type = $${paramCount}`);
      values.push(typeInput);
      paramCount++;
    }
    if (duration !== null) {
      updates.push(`default_duration = $${paramCount}`);
      values.push(duration);
      paramCount++;
    }
    if (currencyInput !== null) {
      updates.push(`default_currency = $${paramCount}`);
      values.push(currencyInput);
      paramCount++;
    }
    if (winners !== null) {
      updates.push(`default_winners = $${paramCount}`);
      values.push(winners);
      paramCount++;
    }
    if (autocheck !== null) {
      updates.push(`default_autocheck = $${paramCount}`);
      values.push(autocheck);
      paramCount++;
    }

    if (updates.length === 0) {
      return await interaction.editReply({
        content: '⚠️ No fields were provided. No changes made.',
      });
    }

    values.push(interaction.guildId);

    // Use INSERT OR IGNORE to insert if doesn't exist, then UPDATE if it does
    await dbRun(
      `INSERT INTO server_settings (guild_id) VALUES ($1) ON CONFLICT DO NOTHING`,
      [interaction.guildId]
    );

    await dbRun(
      `UPDATE server_settings SET ${updates.join(', ')} WHERE guild_id = $${paramCount}`,
      values
    );

    const summary = [];
    if (typeInput) summary.push(`Type: ${typeInput}`);
    if (duration) summary.push(`Duration: ${duration} minute${duration > 1 ? 's' : ''}`);
    if (currencyInput) summary.push(`Currency: ${currencyInput}`);
    if (winners) summary.push(`Winners: ${winners}`);
    if (autocheck !== null) summary.push(`Auto-check: ${autocheck === 1 ? '✅ ON' : '❌ OFF'}`);

    await interaction.editReply({
      content: `✅ Defaults updated:\n${summary.map(s => `• ${s}`).join('\n')}`,
    });
    return;
  }

  // ===== TEMPLATE CREATION MODAL 1 HANDLER =====
  if (interaction.customId.startsWith('gw_template_modal1_')) {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      console.error('Failed to defer Modal 1 reply:', err);
      return;
    }

    const interactionId = interaction.customId.replace('gw_template_modal1_', '');
    
    // Extract Modal 1 data
    const name = interaction.fields.getTextInputValue('template_name');
    const type = interaction.fields.getTextInputValue('template_type');
    const durationStr = interaction.fields.getTextInputValue('template_duration') || '';
    const winnersStr = interaction.fields.getTextInputValue('template_num_winners') || '';

    const duration = durationStr.trim() ? parseInt(durationStr) : null;
    const numWinners = winnersStr.trim() ? parseInt(winnersStr) : null;

    // Store Modal 1 data
    templateCreationData.set(interactionId, {
      name,
      type,
      duration,
      numWinners,
    });

    // Show confirmation and button to continue to Modal 2
    const continueButton = new ButtonBuilder()
      .setCustomId(`template_continue_${interactionId}`)
      .setLabel('Continue to Step 2')
      .setStyle(ButtonStyle.Primary);

    await interaction.editReply({
      content: `✅ Template Step 1 saved: **${name}** (${type})\n\nClick the button below to fill in additional details.`,
      components: [new ActionRowBuilder().addComponents(continueButton)],
    });

    return;
  }

  // ===== TEMPLATE CREATION MODAL 2 HANDLER =====
  if (interaction.customId.startsWith('gw_template_modal2_')) {
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      console.error('Failed to defer template modal2:', err);
      return;
    }

    const templateId = interaction.customId.replace('gw_template_modal2_', '');
    
    // Get Step 1 data
    const stepData = templateCreationData.get(templateId);
    if (!stepData) {
      await interaction.editReply({
        content: '❌ Template data expired. Please start over.',
      });
      return;
    }

    // Extract Modal 2 data
    const withMemberStr = interaction.fields.getTextInputValue('template_with_member') || '';
    const amountStr = interaction.fields.getTextInputValue('template_amount') || '';
    const minXpStr = interaction.fields.getTextInputValue('template_min_xp') || '';
    const additionalRequirements = interaction.fields.getTextInputValue('template_additional_requirements') || null;

    const withMember = withMemberStr.trim() ? withMemberStr.trim() : null;
    const amount = amountStr.trim() ? parseFloat(amountStr) : null;
    const minXp = minXpStr.trim() ? parseInt(minXpStr) : 0;

    // Check if this is an edit or create
    if (stepData.isEditing && stepData.originalTemplateId) {
      // UPDATE existing template
      await dbRun(
        `UPDATE templates SET name = $1, type = $2, duration = $3, num_winners = $4, auto_check = $5, min_xp = $6, amount = $7, currency = $8, with_member = $9, additional_requirements = $10
         WHERE template_id = $11`,
        [
          stepData.name,
          stepData.type,
          stepData.duration,
          stepData.numWinners,
          stepData.autoCheck ? 1 : 0,
          minXp,
          amount,
          stepData.currency,
          withMember,
          additionalRequirements,
          stepData.originalTemplateId
        ]
      );
    } else {
      // INSERT new template
      const templateId2 = `template_${Date.now()}`;
      
      await dbRun(
        `INSERT INTO templates (guild_id, template_id, name, type, duration, num_winners, auto_check, min_xp, amount, currency, with_member, additional_requirements)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          interaction.guildId,
          templateId2,
          stepData.name,
          stepData.type,
          stepData.duration,
          stepData.numWinners,
          stepData.autoCheck ? 1 : 0,
          minXp,
          amount,
          stepData.currency,
          withMember,
          additionalRequirements
        ]
      );
    }

    // Clean up
    templateCreationData.delete(templateId);

    // Build confirmation
    let details = `**${stepData.name}**\n`;
    details += `• Type: ${stepData.type}\n`;
    details += `• Duration: ${stepData.duration} min\n`;
    details += `• Winners: ${stepData.numWinners}\n`;
    details += `• Auto-check: ${stepData.autoCheck ? 'ON' : 'OFF'}\n`;
    details += `• Currency: ${stepData.currency}\n`;
    if (minXp) details += `• Min XP: ${minXp}k\n`;
    if (amount) details += `• Amount: ${formatAmount(amount)} ${stepData.currency}\n`;
    if (withMember) details += `• Featured: ${withMember}\n`;
    if (additionalRequirements) details += `• Requirements: Yes\n`;

    const action = stepData.isEditing ? 'updated' : 'created';
    await interaction.editReply({
      content: `✅ Template ${action}:\n${details}`,
    });

    return;
  }

  if (interaction.customId.startsWith('gw_start_modal_')) {
    // Defer reply immediately to avoid interaction timeout
    try {
      await interaction.deferReply({ flags: 64 });
    } catch (err) {
      console.error('Failed to defer modal reply:', err);
      return;
    }

    const encoded = interaction.customId.replace('gw_start_modal_', '');
    const parts = encoded.split('_');

    const step1MessageId = parts[0];
    console.log(`📋 Modal submitted - Step 1 ID: ${step1MessageId}`);
    const type = Buffer.from(parts[1], 'base64').toString('utf-8');
    const duration = parseInt(parts[2]);
    const currency = parts[3];
    const numWinners = parseInt(parts[4]);
    const autoCheck = parts[5] === 'true' ? 1 : 0;

    const memberInput = interaction.fields.getTextInputValue('gw_member') || '';
    const selectedMember = memberInput.trim().length === 0 ? 'none' : memberInput.trim();

    const amountInput = interaction.fields.getTextInputValue('gw_amount') || '';
    const minXpInput = interaction.fields.getTextInputValue('gw_min_xp') || '';
    const otherReq = interaction.fields.getTextInputValue('gw_other_req') || null;

    // Validate: Min XP ALWAYS requires Amount
    if (minXpInput.trim() !== '' && amountInput.trim() === '') {
      const retryId = `modal_retry_${interaction.user.id}_${Date.now()}`;
      failedModalSubmissions.set(retryId, {
        customId: interaction.customId,
        member: memberInput,
        amount: amountInput,
        minXp: minXpInput,
        otherReq: otherReq || '',
        userId: interaction.user.id
      });

      const retryButton = new ButtonBuilder()
        .setCustomId(retryId)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary);

      await interaction.editReply({
        content: '❌ **Minimum XP requires Amount** to be filled.',
        components: [new ActionRowBuilder().addComponents(retryButton)],
      });
      
      return;
    }

    // Validate: Amount alone is not allowed (needs Min XP or Other)
    if (amountInput.trim() !== '' && minXpInput.trim() === '' && !otherReq) {
      const retryId = `modal_retry_${interaction.user.id}_${Date.now()}`;
      failedModalSubmissions.set(retryId, {
        customId: interaction.customId,
        member: memberInput,
        amount: amountInput,
        minXp: minXpInput,
        otherReq: otherReq || '',
        userId: interaction.user.id
      });

      const retryButton = new ButtonBuilder()
        .setCustomId(retryId)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary);

      await interaction.editReply({
        content: '❌ **Amount** must be paired with **Minimum XP** or **Other Requirements**.',
        components: [new ActionRowBuilder().addComponents(retryButton)],
      });
      
      return;
    }

    // Validate: Must fill Amount or Other Requirements
    if (amountInput.trim() === '' && !otherReq) {
      const retryId = `modal_retry_${interaction.user.id}_${Date.now()}`;
      failedModalSubmissions.set(retryId, {
        customId: interaction.customId,
        member: memberInput,
        amount: amountInput,
        minXp: minXpInput,
        otherReq: otherReq || '',
        userId: interaction.user.id
      });

      const retryButton = new ButtonBuilder()
        .setCustomId(retryId)
        .setLabel('Retry')
        .setStyle(ButtonStyle.Primary);

      await interaction.editReply({
        content: '❌ Fill in **Amount** (with Min XP or Other Requirements) or **Other Requirements** alone.',
        components: [new ActionRowBuilder().addComponents(retryButton)],
      });
      
      return;
    }

    const amount = amountInput.trim() === '' ? null : parseFloat(amountInput);
    const minXp = minXpInput.trim() === '' ? 0 : parseInt(minXpInput);

    const channel = interaction.channel;

    let title = `GIVEAWAY:`;
    if (type !== 'Custom') {
      if (amount !== null) {
        title += ` ${formatAmount(amount)} ${currency}`;
      }
      title += ` ${type}`;
      if (selectedMember !== 'none') {
        title += ` with ${selectedMember}!`;
      } else {
        title += '!';
      }
    } else {
      // Custom type - only add member if specified
      if (selectedMember !== 'none') {
        title += ` with ${selectedMember}!`;
      }
    }

    const embed = getBrandEmbed(title);
    
    const endTime = Date.now() + duration * 60000;

    let reqText = '';
    if (minXp > 0) {
      reqText += `• ${minXp}k XP`;
    }
    if (otherReq) {
      const reqLines = otherReq.split('\n');
      if (reqLines.length > 0) {
        if (reqText) {
          reqText += '\n';
        }
        reqText += reqLines.map(line => {
          if (!line.trim()) {
            return '';
          }
          if (line.trim().startsWith('|')) {
            return line.trim().substring(1);
          }
          return `• ${line}`;
        }).join('\n');
      }
    }
    
    // If nothing is filled, show "None"
    if (!reqText) {
      reqText = 'None';
    }

    const discordTimestamp = formatDiscordTimestamp(endTime);

    // Build description with hosted by and winner/entry info
    const descParts = [
      '═════════════════════════\n⚠️ **MUST BE UNDER CODE *DONIC*** ⚠️\n═════════════════════════',
      `Hosted by: <@${interaction.user.id}>\n`,
      `Winners: ${numWinners}`,
      `Entries: 0`
    ];
    
    if (autoCheck) {
      descParts.push(`Ineligible: 0\n─────────────────────────`);
    } else {
      descParts.push(`─────────────────────────`);
    }

    embed.setDescription(descParts.join('\n'));

    embed.addFields(
      { name: 'DETAILS:', value: reqText, inline: false },
    );

embed.addFields(
  { name: '\u200b', value: '\u200b', inline: false }
);

    embed.addFields(
      { name: '🕐 Ends in:', value: `${discordTimestamp}`, inline: false }
    );


    const enterButton = new ButtonBuilder()
      .setCustomId('enter_giveaway')
      .setLabel('Enter Giveaway')
      .setStyle(ButtonStyle.Primary);

    const row = new ActionRowBuilder().addComponents(enterButton);

    const message = await channel.send({
      embeds: [embed],
      components: [row],
    });

    const withMember = selectedMember !== 'none' ? selectedMember : null;

    // Delete any old giveaway for this guild
    await dbRun('DELETE FROM active_giveaway WHERE guild_id = $1', [interaction.guildId]);

    await dbRun(
      `INSERT INTO active_giveaway 
       (guild_id, channel_id, message_id, giveaway_type, min_xp, additional_requirements, amount, currency, auto_check, hosted_by, with_member, num_winners, eligible_entrants, ineligible_entrants, initial_winners, started_at, duration_minutes, ends_at, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
      [
        interaction.guildId,
        channel.id,
        message.id,
        type,
        minXp,
        otherReq,
        amount,
        currency,
        autoCheck,
        interaction.user.id,
        withMember,
        numWinners,
        '[]',
        '[]',
        '[]',
        Date.now(),
        duration,
        endTime,
        1,
      ]
    );

    await interaction.editReply({
      content: `✅ Giveaway started!`,
    });

    startGiveawayUpdateLoop(interaction.guildId);
    startAutoEndTimer(interaction.guildId, endTime);
  }
}

// ============================================================================
// MESSAGE HANDLER (for username entry)
// ============================================================================

/*
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [message.guildId]
  );

  if (!giveaway) return;

  const giveawayChannel = await client.channels.fetch(giveaway.channel_id);
  if (message.channelId !== giveawayChannel.id) return;

  const mapped = await dbGet(
    'SELECT thrill_username FROM user_map WHERE discord_user_id = $1',
    [message.author.id]
  );

  if (!mapped) {
    const thrillUsername = message.content.trim();

    if (!thrillUsername || thrillUsername.length < 1) {
      return;
    }

    await dbRun(
`INSERT INTO user_map (discord_user_id, thrill_username, updated_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (discord_user_id) DO UPDATE SET thrill_username = EXCLUDED.thrill_username, updated_at = EXCLUDED.updated_at`,
      [message.author.id, thrillUsername, Date.now()]
    );

    if (giveaway.auto_check) {
      const eligibilityResult = await checkEligibility(
        thrillUsername,
        giveaway.min_xp
      );

      const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
      const ineligible = JSON.parse(giveaway.ineligible_entrants || '[]');

      if (eligibilityResult.requiresManualCheck) {
        eligible.push(message.author.id);
        await dbRun(
          'UPDATE active_giveaway SET eligible_entrants = $1 WHERE guild_id = $2',
          [JSON.stringify(eligible), message.guildId]
        );

        await updateGiveawayMessage(message.guildId);

        await message.reply({
          content: `🍀 Entered - Good luck!\n⚠️ *Eligibility could not be checked automatically*.\nBe prepared with *fresh* screenshots of **code Donic + XP** if you win.`,
        });
        return;
      }

      if (eligibilityResult.blocked) {
        ineligible.push(message.author.id);
        await dbRun(
          'UPDATE active_giveaway SET ineligible_entrants = $1 WHERE guild_id = $2',
          [JSON.stringify(ineligible), message.guildId]
        );

        await updateGiveawayMessage(message.guildId);

        await message.reply({
          content: `❌ ${eligibilityResult.reason}`,
        });
        return;
      }

      eligible.push(message.author.id);
      await dbRun(
        'UPDATE active_giveaway SET eligible_entrants = $1 WHERE guild_id = $2',
        [JSON.stringify(eligible), message.guildId]
      );
    } else {
      const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
      eligible.push(message.author.id);
      await dbRun(
        'UPDATE active_giveaway SET eligible_entrants = $1 WHERE guild_id = $2',
        [JSON.stringify(eligible), message.guildId]
      );
    }

    await updateGiveawayMessage(message.guildId);

    await message.reply({
      content: `✅ Username saved! You're entered.`,
    });
  }
});
*/

// ============================================================================
// ELIGIBILITY CHECK
// ============================================================================

async function checkEligibility(thrillUsername, minXp) {
  const cached = await dbGet(
    'SELECT * FROM eligibility_cache WHERE thrill_username = $1',
    [thrillUsername]
  );

  let xp = cached?.last_xp || 0;
  let underDonic = cached?.last_under_donic === 1;

  if (cached && cached.last_xp >= minXp) {
    return {
      blocked: !underDonic,
      xp,
      underDonic,
      reason: !underDonic ? 'Not under code donic' : null,
    };
  }

  const apiResult = await thrillService.lookupUserByUsername(thrillUsername);

  if (apiResult.status === 'NOT_FOUND') {
    return {
      blocked: true,
      xp: 0,
      underDonic: false,
      reason: 'Username not found. Try a different name.',
    };
  }

  if (apiResult.status === 'API_DOWN') {
    return {
      blocked: false,
      requiresManualCheck: true,
      xp: cached?.last_xp || 0,
      underDonic: cached?.last_under_donic === 1,
    };
  }

  xp = apiResult.xp;
  underDonic = apiResult.underDonic;

  await dbRun(
    `INSERT INTO eligibility_cache 
     (thrill_username, last_xp, last_under_donic, last_checked_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (thrill_username) DO UPDATE SET last_xp = EXCLUDED.last_xp, last_under_donic = EXCLUDED.last_under_donic, last_checked_at = EXCLUDED.last_checked_at`,
    [thrillUsername, xp, underDonic ? 1 : 0, Date.now()]
  );

  const blocked = xp < minXp || !underDonic;
  let reason = null;

  if (xp < minXp && !underDonic) {
    reason = `Not enough XP (${xp}/${minXp}) and not under code donic`;
  } else if (xp < minXp) {
    reason = `Not enough XP (${xp}/${minXp})`;
  } else if (!underDonic) {
    reason = 'Not under code donic';
  }

  return {
    blocked,
    xp,
    underDonic,
    reason,
  };
}

// ============================================================================
// UPDATE & TIMER LOOPS
// ============================================================================

const updateLoops = new Map();
const endTimers = new Map();
const failedModalSubmissions = new Map(); // Store failed modal data for retrying

function startGiveawayUpdateLoop(guildId) {
  if (updateLoops.has(guildId)) return;

  const interval = setInterval(async () => {
    const giveaway = await dbGet(
      'SELECT * FROM active_giveaway WHERE guild_id = $1',
      [guildId]
    );

    if (!giveaway || !giveaway.is_active) {
      clearInterval(interval);
      updateLoops.delete(guildId);
      return;
    }

    await updateGiveawayMessage(guildId);
  }, 2000);

  updateLoops.set(guildId, interval);
}

function startAutoEndTimer(guildId, endTime) {
  if (endTimers.has(guildId)) {
    clearTimeout(endTimers.get(guildId));
  }

  const delay = Math.max(0, endTime - Date.now());

  const timer = setTimeout(async () => {
    const giveaway = await dbGet(
      'SELECT * FROM active_giveaway WHERE guild_id = $1',
      [guildId]
    );

    if (giveaway && giveaway.is_active) {
      // Stop the update loop before editing
      if (updateLoops.has(guildId)) {
        clearInterval(updateLoops.get(guildId));
        updateLoops.delete(guildId);
      }

      console.log(`⏰ Giveaway timer expired for guild ${guildId}`);
      const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
      console.log(`📋 Eligible entrants: ${eligible.length}`);

      if (eligible.length === 0) {
        console.log(`⚠️ No eligible entrants`);
        await dbRun('UPDATE active_giveaway SET is_active = 0 WHERE guild_id = $1', [
          guildId,
        ]);
        try {
          const channel = await client.channels.fetch(giveaway.channel_id);
          console.log(`✓ Fetched channel: ${channel.id}`);
          const message = await channel.messages.fetch(giveaway.message_id);
          console.log(`✓ Fetched message: ${message.id}`);
          const embed = EmbedBuilder.from(message.embeds[0]);
          
          // Update the "Ends in" field to show it has ended
          const fields = embed.data.fields || [];
          const updatedFields = fields.map(f => {
            if (f.name === '🕐 Ends in:') {
              return { name: '🕐 Ends in:', value: 'This giveaway has ended', inline: f.inline };
            }
            return f;
          });
          
          // Set all fields at once
          embed.setFields(updatedFields);
          
          // Now add the result field
          embed.addFields({ name: '⚠️ Result:', value: 'No eligible entrants', inline: false });
          
          await message.edit({ embeds: [embed], components: [] });
          console.log(`✅ Updated message with no eligible entrants result`);
          
          // Send announcement message
          const announcement = `\n⚠️ **Giveaway Ended - No Eligible Entrants**`;
          console.log(`📢 Sending announcement: ${announcement}`);
          await channel.send(announcement);
          console.log(`✅ Sent announcement message`);
        } catch (err) {
          console.error(`❌ Failed to update giveaway message:`, err.message);
        }
      } else {
        console.log(`🎉 Selecting ${giveaway.num_winners} winner(s) from ${eligible.length} eligible`);
        const winnerIds = await selectWinners(eligible, giveaway.num_winners, guildId);
        try {
          const channel = await client.channels.fetch(giveaway.channel_id);
          console.log(`✓ Fetched channel: ${channel.id}`);
          const message = await channel.messages.fetch(giveaway.message_id);
          console.log(`✓ Fetched message: ${message.id}`);

          await dbRun('UPDATE active_giveaway SET initial_winners = $1 WHERE guild_id = $2', [
            JSON.stringify(winnerIds),
            guildId,
          ]);

          let winnerListText = '';

          for (const winnerId of winnerIds) {
            const userMap = await dbGet(
              'SELECT thrill_username FROM user_map WHERE discord_user_id = $1',
              [winnerId]
            );

            let winnerText = `<@${winnerId}>`;
            console.log(`🔍 Checking winner ${winnerId}: auto_check=${giveaway.auto_check}, userMap=${userMap ? 'YES' : 'NO'}`);

            if (giveaway.auto_check && userMap) {
              const eligibility = await checkEligibility(
                userMap.thrill_username,
                giveaway.min_xp
              );

              console.log(`📊 Eligibility result:`, eligibility);

              if (eligibility.requiresManualCheck) {
                winnerText += ` (Please comment *fresh* screenshots of **code Donic + XP**)`;
              } else if (eligibility.blocked) {
                winnerText += ` ⚠️ **Ineligible**: ${eligibility.reason}`;
              } else {
                winnerText += ` ⭐ XP: ${formatXP(eligibility.xp)}`;
              }
            } else if (!giveaway.auto_check) {
              winnerText += ` (Please comment *fresh* screenshots of **code Donic + XP**)`;
            } else {
              console.log(`⚠️ No userMap for winner ${winnerId}`);
            }

            winnerListText += winnerText + '\n';
          }

          const embed = EmbedBuilder.from(message.embeds[0]);
          
          // Update the "Ends in" field to show it has ended
          const fields = embed.data.fields || [];
          const updatedFields = fields.map(f => {
            if (f.name === '🕐 Ends in:') {
              return { name: '🕐 Ends in:', value: 'This giveaway has ended', inline: f.inline };
            }
            return f;
          });
          
          // Set all fields at once
          embed.setFields(updatedFields);
          
          // Now add the winners field
          embed.addFields({ name: '🎉 Winner(s):', value: winnerListText.trim(), inline: false });
          await message.edit({ embeds: [embed], components: [] });
          console.log(`✅ Updated message with winners`);
          
          // Send announcement message
          const announcement = `\n**Giveaway Ended!**\n\n🎉 **Congratulations**\n${winnerListText}`;
          console.log(`📢 Sending announcement: ${announcement.substring(0, 50)}...`);
          await channel.send(announcement);
          console.log(`✅ Sent announcement message`);

          await dbRun('UPDATE active_giveaway SET is_active = 0 WHERE guild_id = $1', [
            guildId,
          ]);
        } catch (err) {
          console.error(`❌ Failed to update giveaway message:`, err.message);
          console.error(`Error code: ${err.code}`);
        }
      }
    }

    endTimers.delete(guildId);
  }, delay);

  endTimers.set(guildId, timer);
}

async function updateGiveawayMessage(guildId) {
  const giveaway = await dbGet(
    'SELECT * FROM active_giveaway WHERE guild_id = $1',
    [guildId]
  );

  if (!giveaway) return;

  const channel = await client.channels.fetch(giveaway.channel_id);
  const message = await channel.messages.fetch(giveaway.message_id);

  const eligible = JSON.parse(giveaway.eligible_entrants || '[]');
  const ineligible = JSON.parse(giveaway.ineligible_entrants || '[]');

  let title = `GIVEAWAY:`;
  if (giveaway.giveaway_type !== 'Custom') {
    if (giveaway.amount !== null) {
      title += ` ${formatAmount(giveaway.amount)} ${giveaway.currency}`;
    }
    title += ` ${giveaway.giveaway_type}`;
    if (giveaway.with_member) {
      title += ` with ${giveaway.with_member}!`;
    } else {
      title += '!';
    }
  } else {
    // Custom type - only add member if specified
    if (giveaway.with_member) {
      title += ` with ${giveaway.with_member}!`;
    }
  }

  const embed = getBrandEmbed(title);
    
    const endTime = giveaway.ends_at;

    let reqText = '';
    if (giveaway.min_xp > 0) {
      reqText += `• ${giveaway.min_xp}k XP`;
    }
    if (giveaway.additional_requirements) {
      const reqLines = giveaway.additional_requirements.split('\n');
      if (reqLines.length > 0) {
        if (reqText) {
          reqText += '\n';
        }
        reqText += reqLines.map(line => {
          if (!line.trim()) {
            return '';
          }
          if (line.trim().startsWith('|')) {
            return line.trim().substring(1);
          }
          return `• ${line}`;
        }).join('\n');
      }
    }

    // If nothing is filled, show "None"
    if (!reqText) {
      reqText = 'None';
    }

    const discordTimestamp = formatDiscordTimestamp(endTime);

    // Build description with hosted by and winner/entry info
    const descParts = [
      '═════════════════════════\n⚠️ **MUST BE UNDER CODE *DONIC*** ⚠️\n═════════════════════════',
      `Hosted by: <@${giveaway.hosted_by}>\n`,
      `Winners: ${giveaway.num_winners}`,
      `Entries: ${eligible.length}`
    ];
    
    if (giveaway.auto_check) {
      descParts.push(`Ineligible: ${ineligible.length}\n─────────────────────────`);
    } else {
      descParts.push(`─────────────────────────`);
    }

    embed.setDescription(descParts.join('\n'));
  

embed.addFields(
      { name: 'DETAILS:', value: reqText, inline: false },
    );

embed.addFields(
  { name: '\u200b', value: '\u200b', inline: false }
);

embed.addFields(
      { name: '🕐 Ends in:', value: `${discordTimestamp}`, inline: false }
    );


  const enterButton = new ButtonBuilder()
    .setCustomId('enter_giveaway')
    .setLabel('Enter Giveaway')
    .setStyle(ButtonStyle.Primary);

  const row = new ActionRowBuilder().addComponents(enterButton);

  try {
    await message.edit({
      embeds: [embed],
      components: [row],
    });
  } catch (error) {
    console.error('Failed to update message:', error);
  }
}

async function selectWinners(entrants, count, guildId) {
  if (entrants.length === 0) return [];

  // Get last 5 completed giveaways for this server
  const recentGiveaways = await dbAll(
    'SELECT initial_winners FROM active_giveaway WHERE guild_id = $1 AND is_active = 0 ORDER BY ends_at DESC LIMIT 5',
    [guildId]
  );

  // Extract all winners from last 5 giveaways
  const recentWinners = new Set();
  for (const giveaway of recentGiveaways) {
    if (giveaway.initial_winners) {
      try {
        const winners = JSON.parse(giveaway.initial_winners);
        winners.forEach(winnerId => recentWinners.add(winnerId));
      } catch (err) {
        console.error('Failed to parse winners:', err);
      }
    }
  }

  const winners = [];
  const availableEntrants = [...entrants];

  for (let i = 0; i < Math.min(count, availableEntrants.length); i++) {
    // Create weighted list for this selection
    const weighted = [];
    for (const entrant of availableEntrants) {
      if (recentWinners.has(entrant)) {
        // Repeat winner - add 3 times (75% weight = 25% less chance)
        weighted.push(entrant, entrant, entrant);
      } else {
        // New winner - add 4 times (100% weight)
        weighted.push(entrant, entrant, entrant, entrant);
      }
    }

    // Select winner from weighted list
    const randomIndex = Math.floor(Math.random() * weighted.length);
    const winner = weighted[randomIndex];
    winners.push(winner);

    // Remove from available for next selection
    availableEntrants.splice(availableEntrants.indexOf(winner), 1);
  }

  return winners;
}

// ============================================================================
// REGISTER SLASH COMMANDS
// ============================================================================

client.once('ready', async () => {
  // Initialize database
  await initializeDatabase();

  const commands = [
    {
      name: 'gw',
      description: 'Giveaway commands',
      options: [
        {
          type: 1,
          name: 'start',
          description: 'Start a new giveaway with optional template',
          options: [
            {
              type: 3,
              name: 'template',
              description: 'Optional: Load a template to start with',
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: 'quick',
          description: 'Start a giveaway with defaults or a template',
          options: [
            {
              type: 3,
              name: 'template_name',
              description: 'Template name (optional, uses defaults if not provided)',
              required: false,
            },
          ],
        },
        {
          type: 1,
          name: 'end',
          description: 'End giveaway and pick winner(s)',
        },
        {
          type: 1,
          name: 'cancel',
          description: 'Cancel active giveaway',
        },
        {
          type: 1,
          name: 'reroll',
          description: 'Reroll winner(s) (excludes initial winners)',
        },
        {
          type: 1,
          name: 'runback',
          description: 'Run another giveaway with exact same values as last one',
        },
        {
          type: 2,
          name: 'template',
          description: 'Manage giveaway templates',
          options: [
            {
              type: 1,
              name: 'create',
              description: 'Create a template',
              options: [
                { type: 3, name: 'name', description: 'Template name', required: true },
              ],
            },
            {
              type: 1,
              name: 'edit',
              description: 'Edit an existing template',
              options: [
                { type: 3, name: 'templatename', description: 'Template to edit', required: true },
              ],
            },
            {
              type: 1,
              name: 'list',
              description: 'List all templates',
            },
            {
              type: 1,
              name: 'delete',
              description: 'Delete a template',
              options: [{ type: 3, name: 'name', description: 'Template name', required: true }],
            },
          ],
        },
        {
          type: 2,
          name: 'default',
          description: 'Manage server defaults',
          options: [
            {
              type: 1,
              name: 'view',
              description: 'View server defaults',
            },
            {
              type: 1,
              name: 'set',
              description: 'Set server defaults for Step 1 fields',
            },
          ],
        },
      ],
    },
    {
      name: 'gwmap',
      description: 'Manage Discord ↔ Thrill username mappings',
      options: [
        {
          type: 1,
          name: 'link',
          description: 'Link a Discord user to a Thrill username',
          options: [
            { type: 6, name: 'user', description: 'Discord user', required: true },
            { type: 3, name: 'thrill_username', description: 'Thrill username', required: true },
          ],
        },
        {
          type: 1,
          name: 'edit',
          description: 'Edit an existing mapping',
          options: [
            { type: 6, name: 'user', description: 'Discord user', required: true },
            { type: 3, name: 'new_thrill_username', description: 'New Thrill username', required: true },
          ],
        },
        {
          type: 1,
          name: 'delete',
          description: 'Delete a mapping',
          options: [{ type: 6, name: 'user', description: 'Discord user', required: true }],
        },
        {
          type: 1,
          name: 'list',
          description: 'List all mappings',
        },
        {
          type: 1,
          name: 'view',
          description: 'View a user\'s mapping',
          options: [{ type: 6, name: 'user', description: 'Discord user', required: true }],
        },
      ],
    },
    {
      name: 'gwcheck',
      description: 'Manually check user eligibility',
      options: [
        { type: 3, name: 'thrillname', description: 'Thrill username', required: false },
        { type: 6, name: 'user', description: 'Discord user', required: false },
      ],
    },
  ];

  // Register commands globally
await client.application?.commands.set(commands);
console.log(`✅ Slash commands registered globally`);
});

// ============================================================================
// LOGIN
// ============================================================================
console.log('Token value:', process.env.DISCORD_TOKEN);
client.login(process.env.DISCORD_TOKEN);
