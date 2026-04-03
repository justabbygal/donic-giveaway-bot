# Dynamic Per-Server Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hardcoded/env-var role names and support URL with per-guild DB config, plus a `/setup` command so any server admin can configure the bot without touching files.

**Architecture:** Add 5 columns to `server_settings`, introduce a cached `getServerConfig(guildId)` async helper that reads those columns with env var fallbacks, update all role-check call sites to pass `guildId`, and expose a `/setup` slash command (view + configure modal).

**Tech Stack:** Node.js, discord.js 14, PostgreSQL via `pg`, existing `dbGet`/`dbRun` helpers.

---

## File Map

- **Modify:** `bot.js` — all changes live here
  - DB migration in `initializeDatabase()`
  - `BOT_OWNER_ID` constant added near `SPECIAL_USERS`
  - New `getServerConfig` + `invalidateServerConfig` functions (replace module-level constants)
  - Updated `isAdminOrBot(member, guildId)` and `isVerified(member, guildId)` signatures
  - Updated call sites (10 total)
  - New `/setup` command definition in `getCommands()`
  - New routing in `handleCommand()` and modal handler
  - New `handleSetupView()`, `handleSetupConfigure()`, `handleSetupModalSubmit()` functions
  - New `guildCreate` event handler
- **Modify:** `.env` — document role vars as optional overrides, not required

---

### Task 0: Add BOT_OWNER_ID constant

**Files:**
- Modify: `bot.js` — near the `SPECIAL_USERS` block

- [ ] **Step 1: Add BOT_OWNER_ID after the SPECIAL_USERS block**

Find:
```javascript
const SPECIAL_USERS = {
  LYNCHY9595: '1055569375530319937',
```

Add this immediately before it:
```javascript
// Bot owner — can run /setup on any server regardless of roles
const BOT_OWNER_ID = '944830904034033725';

```

- [ ] **Step 2: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: add BOT_OWNER_ID for cross-server setup access"
```

---

### Task 1: DB Migration — Add config columns to server_settings

**Files:**
- Modify: `bot.js` — inside `initializeDatabase()`, after the existing migrations

- [ ] **Step 1: Add migration after the last existing migration block in `initializeDatabase()`**

Find the last `await pool.query(` block inside `initializeDatabase()` (the one that renames `thrill_username → casino_username` in `eligibility_cache`). Add this block immediately after it:

```javascript
    // Migration: add per-server config columns to server_settings (v3 → v4)
    await pool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='server_settings' AND column_name='role_admin') THEN
          ALTER TABLE server_settings ADD COLUMN role_admin TEXT;
          ALTER TABLE server_settings ADD COLUMN role_giveaway_managers TEXT;
          ALTER TABLE server_settings ADD COLUMN role_verified TEXT;
          ALTER TABLE server_settings ADD COLUMN support_channel_url TEXT;
          ALTER TABLE server_settings ADD COLUMN giveaway_manager_role_id TEXT;
        END IF;
      END$$;
    `);
```

- [ ] **Step 2: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: add per-server config columns to server_settings"
```

---

### Task 2: Add getServerConfig helper and replace module-level constants

**Files:**
- Modify: `bot.js` — SERVER CONFIGURATION section (lines ~54–81)

- [ ] **Step 1: Replace the SERVER CONFIGURATION block**

Find this block:
```javascript
// ============================================================================
// SERVER CONFIGURATION
// ============================================================================
// Role names — set these in .env to match your server's actual role names
const ROLE_ADMIN = process.env.ROLE_ADMIN || 'Admin';
const ROLE_GIVEAWAY_MANAGERS = process.env.ROLE_GIVEAWAY_MANAGERS || 'Giveaway Managers';
const ROLE_VERIFIED = process.env.ROLE_VERIFIED || 'Verified';

// URL shown to banned users so they can open a support ticket
// Set SUPPORT_CHANNEL_URL in .env to your server's ticket channel link
const SUPPORT_CHANNEL_URL = process.env.SUPPORT_CHANNEL_URL || '';
```

Replace with:
```javascript
// ============================================================================
// SERVER CONFIGURATION
// ============================================================================
// Per-guild config cache — avoids a DB hit on every role check
const _configCache = new Map(); // guildId -> { config, fetchedAt }
const _CONFIG_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getServerConfig(guildId) {
  const cached = _configCache.get(guildId);
  if (cached && Date.now() - cached.fetchedAt < _CONFIG_TTL_MS) {
    return cached.config;
  }
  const settings = await dbGet(
    'SELECT * FROM server_settings WHERE guild_id = $1',
    [guildId]
  );
  const config = {
    roleAdmin:             settings?.role_admin              || process.env.ROLE_ADMIN              || 'Admin',
    roleGiveawayManagers:  settings?.role_giveaway_managers  || process.env.ROLE_GIVEAWAY_MANAGERS  || 'Giveaway Managers',
    roleVerified:          settings?.role_verified           || process.env.ROLE_VERIFIED           || 'Verified',
    supportChannelUrl:     settings?.support_channel_url     || process.env.SUPPORT_CHANNEL_URL     || '',
    giveawayManagerRoleId: settings?.giveaway_manager_role_id || process.env.GIVEAWAY_MANAGER_ROLE_ID || '',
  };
  _configCache.set(guildId, { config, fetchedAt: Date.now() });
  return config;
}

function invalidateServerConfig(guildId) {
  _configCache.delete(guildId);
}
```

- [ ] **Step 2: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: add getServerConfig helper with per-guild DB config and cache"
```

---

### Task 3: Update isAdminOrBot and isVerified to accept guildId

**Files:**
- Modify: `bot.js` — ROLE CHECKING HELPERS section and all 10 call sites

- [ ] **Step 1: Update the helper functions**

Find:
```javascript
function isAdminOrBot(member) {
  if (!member) return false;
  return hasRole(member, ROLE_ADMIN) || hasRole(member, ROLE_GIVEAWAY_MANAGERS);
}

function isVerified(member) {
  if (!member) return false;
  return hasRole(member, ROLE_VERIFIED);
}
```

Replace with:
```javascript
async function isAdminOrBot(member, guildId) {
  if (!member || !guildId) return false;
  if ((member.id ?? member.user?.id) === BOT_OWNER_ID) return true;
  const config = await getServerConfig(guildId);
  return hasRole(member, config.roleAdmin) || hasRole(member, config.roleGiveawayManagers);
}

async function isVerified(member, guildId) {
  if (!member || !guildId) return false;
  if ((member.id ?? member.user?.id) === BOT_OWNER_ID) return true;
  const config = await getServerConfig(guildId);
  return hasRole(member, config.roleVerified);
}
```

- [ ] **Step 2: Update handleCommand — hasGwModRole line**

Find:
```javascript
  const hasGwModRole = member?.roles.cache.some(role => role.name === ROLE_GIVEAWAY_MANAGERS);
```

Replace with:
```javascript
  const config = await getServerConfig(interaction.guildId);
  const hasGwModRole = interaction.user.id === BOT_OWNER_ID || member?.roles.cache.some(role => role.name === config.roleGiveawayManagers);
```

- [ ] **Step 3: Update the two GIVEAWAY_MANAGER_ROLE_ID role-ID checks**

There are two places that do `member.roles.cache.has(process.env.GIVEAWAY_MANAGER_ROLE_ID)`. Both are inside async functions. Change each one:

Find (first occurrence):
```javascript
  const isManager = member.roles.cache.has(process.env.GIVEAWAY_MANAGER_ROLE_ID);
  const isAdmin = isAdminOrBot(member);
```

Replace with:
```javascript
  const cfg = await getServerConfig(interaction.guildId);
  const isManager = interaction.user.id === BOT_OWNER_ID || (cfg.giveawayManagerRoleId ? member.roles.cache.has(cfg.giveawayManagerRoleId) : false);
  const isAdmin = await isAdminOrBot(member, interaction.guildId);
```

Find (second occurrence — same pattern, different handler):
```javascript
  const isManager = member.roles.cache.has(process.env.GIVEAWAY_MANAGER_ROLE_ID);
  const isAdmin = isAdminOrBot(member);
```

Replace with:
```javascript
  const cfg = await getServerConfig(interaction.guildId);
  const isManager = interaction.user.id === BOT_OWNER_ID || (cfg.giveawayManagerRoleId ? member.roles.cache.has(cfg.giveawayManagerRoleId) : false);
  const isAdmin = await isAdminOrBot(member, interaction.guildId);
```

- [ ] **Step 4: Update remaining isAdminOrBot / isVerified call sites**

Run this grep to locate all remaining call sites:
```bash
grep -n "isAdminOrBot\|isVerified" gw-bot/bot.js
```

For each remaining call site, apply the appropriate change:

**Pattern A** — `const isAdmin = isAdminOrBot(member);`
→ `const isAdmin = await isAdminOrBot(member, interaction.guildId);`

**Pattern B** — `const isVerif = isVerified(member);`
→ `const isVerif = await isVerified(member, interaction.guildId);`

**Pattern C** — `if (!isAdminOrBot(member)) {`
→ `if (!await isAdminOrBot(member, interaction.guildId)) {`

**Pattern D** — `if (!isVerified(member) && !isAdminOrBot(member)) {`
→ `if (!await isVerified(member, interaction.guildId) && !await isAdminOrBot(member, interaction.guildId)) {`

**Pattern E** — `if (!isAdminOrBot(interaction.member)) {`
→ `if (!await isAdminOrBot(interaction.member, interaction.guildId)) {`

- [ ] **Step 5: Update the ban/unban ROLE_ADMIN references**

Find (handleGiveawayBan):
```javascript
  if (!hasRole(member, ROLE_ADMIN)) {
    return await interaction.editReply({ content: `❌ Only members with the **${ROLE_ADMIN}** role can ban users from giveaways.` });
  }
```

Replace with:
```javascript
  const banConfig = await getServerConfig(interaction.guildId);
  if (interaction.user.id !== BOT_OWNER_ID && !hasRole(member, banConfig.roleAdmin)) {
    return await interaction.editReply({ content: `❌ Only members with the **${banConfig.roleAdmin}** role can ban users from giveaways.` });
  }
```

Find (handleGiveawayUnban):
```javascript
  if (!hasRole(member, ROLE_ADMIN)) {
    return await interaction.editReply({ content: `❌ Only members with the **${ROLE_ADMIN}** role can unban users from giveaways.` });
  }
```

Replace with:
```javascript
  const unbanConfig = await getServerConfig(interaction.guildId);
  if (interaction.user.id !== BOT_OWNER_ID && !hasRole(member, unbanConfig.roleAdmin)) {
    return await interaction.editReply({ content: `❌ Only members with the **${unbanConfig.roleAdmin}** role can unban users from giveaways.` });
  }
```

- [ ] **Step 6: Update SUPPORT_CHANNEL_URL in ban message**

Find:
```javascript
        content: `\u{1F6AB} You have been banned from entering giveaways for **${banRecord.ban_days} day${banRecord.ban_days === 1 ? '' : 's'}**.\n\nYou have **${remaining}** remaining until you can enter again.${SUPPORT_CHANNEL_URL ? `\n\nIf you have questions, please open a ticket: ${SUPPORT_CHANNEL_URL}` : ''}`,
```

This is inside `handleGiveawayEnter`. Add a config fetch near the top of that function (after `await interaction.deferReply`) and update the ban message:

```javascript
  const entryConfig = await getServerConfig(interaction.guildId);
```

Then replace the SUPPORT_CHANNEL_URL reference:
```javascript
        content: `\u{1F6AB} You have been banned from entering giveaways for **${banRecord.ban_days} day${banRecord.ban_days === 1 ? '' : 's'}**.\n\nYou have **${remaining}** remaining until you can enter again.${entryConfig.supportChannelUrl ? `\n\nIf you have questions, please open a ticket: ${entryConfig.supportChannelUrl}` : ''}`,
```

- [ ] **Step 7: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: make role and config checks dynamic per guild"
```

---

### Task 4: Add /setup slash command definition

**Files:**
- Modify: `bot.js` — `getCommands()` function

- [ ] **Step 1: Add setup command to the returned array in getCommands()**

Find the closing of the commands array in `getCommands()` — the last `}` before the closing `]` of the `return [` statement. Add this entry before the closing `]`:

```javascript
    {
      name: 'setup',
      description: 'Configure the giveaway bot for this server (Admin only)',
      options: [
        {
          type: 1,
          name: 'view',
          description: 'View current bot configuration for this server',
        },
        {
          type: 1,
          name: 'configure',
          description: 'Set role names, manager role ID, and support channel URL',
        },
      ],
    },
```

- [ ] **Step 2: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: register /setup slash command"
```

---

### Task 5: Route /setup in handleCommand and modal handler

**Files:**
- Modify: `bot.js` — `handleCommand()` and the modal submission handler

- [ ] **Step 1: Add /setup routing in handleCommand**

Inside `handleCommand()`, find where `commandName === 'gw'` and other top-level command names are checked. Add:

```javascript
  if (commandName === 'setup') {
    const sub = interaction.options.getSubcommand();
    const isBotOwner = interaction.user.id === BOT_OWNER_ID;
    if (!isBotOwner && !await isAdminOrBot(interaction.member, interaction.guildId)) {
      return await interaction.reply({ content: '❌ You need Admin or Giveaway Managers role to use /setup.', flags: 64 });
    }
    if (sub === 'view') return await handleSetupView(interaction);
    if (sub === 'configure') return await handleSetupConfigure(interaction);
    return;
  }
```

- [ ] **Step 2: Add setup_modal routing in the modal submission handler**

Find the block that handles `defaults_modal_` (search for `defaults_modal_`). It will be inside an `if (interaction.isModalSubmit())` block. Add a sibling check for setup modals:

```javascript
    if (interaction.customId === 'setup_modal') {
      return await handleSetupModalSubmit(interaction);
    }
```

- [ ] **Step 3: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: route /setup command and setup_modal submission"
```

---

### Task 6: Implement handleSetupView, handleSetupConfigure, handleSetupModalSubmit

**Files:**
- Modify: `bot.js` — add three new functions before the `// LOGIN` section at the bottom

- [ ] **Step 1: Add handleSetupView**

```javascript
// ============================================================================
// HANDLE: /setup view
// ============================================================================
async function handleSetupView(interaction) {
  const config = await getServerConfig(interaction.guildId);

  const lines = [
    '**Bot Configuration for this Server:**',
    `Admin role: \`${config.roleAdmin}\``,
    `Giveaway Managers role: \`${config.roleGiveawayManagers}\``,
    `Verified role: \`${config.roleVerified}\``,
    `Giveaway Manager Role ID: ${config.giveawayManagerRoleId || '_not set_'}`,
    `Support channel URL: ${config.supportChannelUrl || '_not set_'}`,
    '',
    '_Run `/setup configure` to change these values._',
  ];

  await interaction.reply({ content: lines.join('\n'), flags: 64 });
}
```

- [ ] **Step 2: Add handleSetupConfigure**

```javascript
// ============================================================================
// HANDLE: /setup configure
// ============================================================================
async function handleSetupConfigure(interaction) {
  const config = await getServerConfig(interaction.guildId);

  const modal = new ModalBuilder()
    .setCustomId('setup_modal')
    .setTitle('Bot Server Configuration');

  const adminRoleInput = new TextInputBuilder()
    .setCustomId('role_admin')
    .setLabel('Admin role name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Admin')
    .setRequired(false)
    .setValue(config.roleAdmin);

  const gwManagersInput = new TextInputBuilder()
    .setCustomId('role_giveaway_managers')
    .setLabel('Giveaway Managers role name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Giveaway Managers')
    .setRequired(false)
    .setValue(config.roleGiveawayManagers);

  const verifiedInput = new TextInputBuilder()
    .setCustomId('role_verified')
    .setLabel('Verified role name')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Verified')
    .setRequired(false)
    .setValue(config.roleVerified);

  const roleIdInput = new TextInputBuilder()
    .setCustomId('giveaway_manager_role_id')
    .setLabel('Giveaway Manager Role ID')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Right-click role → Copy Role ID')
    .setRequired(false)
    .setValue(config.giveawayManagerRoleId);

  const supportUrlInput = new TextInputBuilder()
    .setCustomId('support_channel_url')
    .setLabel('Support channel URL (for ban messages)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('https://discord.com/channels/...')
    .setRequired(false)
    .setValue(config.supportChannelUrl);

  modal.addComponents(
    new ActionRowBuilder().addComponents(adminRoleInput),
    new ActionRowBuilder().addComponents(gwManagersInput),
    new ActionRowBuilder().addComponents(verifiedInput),
    new ActionRowBuilder().addComponents(roleIdInput),
    new ActionRowBuilder().addComponents(supportUrlInput),
  );

  await interaction.showModal(modal);
}
```

- [ ] **Step 3: Add handleSetupModalSubmit**

```javascript
// ============================================================================
// HANDLE: setup_modal submission
// ============================================================================
async function handleSetupModalSubmit(interaction) {
  await interaction.deferReply({ flags: 64 });

  const roleAdmin            = interaction.fields.getTextInputValue('role_admin').trim();
  const roleGiveawayManagers = interaction.fields.getTextInputValue('role_giveaway_managers').trim();
  const roleVerified         = interaction.fields.getTextInputValue('role_verified').trim();
  const giveawayManagerRoleId = interaction.fields.getTextInputValue('giveaway_manager_role_id').trim();
  const supportChannelUrl    = interaction.fields.getTextInputValue('support_channel_url').trim();

  await dbRun(
    `INSERT INTO server_settings (guild_id, role_admin, role_giveaway_managers, role_verified, giveaway_manager_role_id, support_channel_url)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (guild_id) DO UPDATE SET
       role_admin = EXCLUDED.role_admin,
       role_giveaway_managers = EXCLUDED.role_giveaway_managers,
       role_verified = EXCLUDED.role_verified,
       giveaway_manager_role_id = EXCLUDED.giveaway_manager_role_id,
       support_channel_url = EXCLUDED.support_channel_url`,
    [interaction.guildId, roleAdmin || null, roleGiveawayManagers || null, roleVerified || null, giveawayManagerRoleId || null, supportChannelUrl || null]
  );

  invalidateServerConfig(interaction.guildId);

  await interaction.editReply({
    content: [
      '✅ **Server configuration saved.**',
      `Admin role: \`${roleAdmin || '(default)'}\``,
      `Giveaway Managers role: \`${roleGiveawayManagers || '(default)'}\``,
      `Verified role: \`${roleVerified || '(default)'}\``,
      `Giveaway Manager Role ID: ${giveawayManagerRoleId || '_not set_'}`,
      `Support channel URL: ${supportChannelUrl || '_not set_'}`,
    ].join('\n'),
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: implement /setup view, configure, and modal submit handlers"
```

---

### Task 7: Add guildCreate event handler

**Files:**
- Modify: `bot.js` — add event listener before `client.login(...)`

- [ ] **Step 1: Add guildCreate listener**

Find `client.login(process.env.DISCORD_TOKEN);` at the bottom of the file. Add this block immediately before it:

```javascript
// ============================================================================
// GUILD JOIN — prompt admin to run /setup
// ============================================================================
client.on('guildCreate', async (guild) => {
  try {
    // Find the first text channel the bot can send messages in
    const channel = guild.channels.cache
      .filter(c => c.type === 0 && c.permissionsFor(guild.members.me)?.has('SendMessages'))
      .sort((a, b) => a.position - b.position)
      .first();

    if (!channel) return;

    await channel.send(
      `👋 Thanks for adding the Giveaway Bot!\n\nTo finish setup, please run \`/setup configure\` to set your role names and support channel. An admin or Giveaway Manager role is required to use the bot.\n\nRun \`/setup view\` at any time to see the current configuration.`
    );
  } catch (err) {
    console.error(`[guildCreate] Could not send welcome message to ${guild.name}:`, err);
  }
});
```

- [ ] **Step 2: Commit**

```bash
git add gw-bot/bot.js
git commit -m "feat: send setup prompt when bot joins a new server"
```

---

### Task 8: Clean up .env

**Files:**
- Modify: `.env`

- [ ] **Step 1: Update .env to mark role vars as optional overrides**

Replace the role/config section of `.env`:

```dotenv
# ============================================================================
# ROLE NAMES (optional — override defaults or set via /setup configure in Discord)
# Only needed if you cannot use /setup, or want to set a global fallback.
# Defaults: Admin | Giveaway Managers | Verified
# ============================================================================
# ROLE_ADMIN=Admin
# ROLE_GIVEAWAY_MANAGERS=Giveaway Managers
# ROLE_VERIFIED=Verified
# GIVEAWAY_MANAGER_ROLE_ID=

# ============================================================================
# SUPPORT CHANNEL (optional — set via /setup configure in Discord instead)
# ============================================================================
# SUPPORT_CHANNEL_URL=
```

- [ ] **Step 2: Commit**

```bash
git add gw-bot/.env
git commit -m "docs: mark role name env vars as optional overrides"
```

---

## Self-Review

**Spec coverage:**
- ✅ Per-guild config stored in DB
- ✅ `/setup configure` modal with all 5 fields
- ✅ `/setup view` shows current config
- ✅ Config cache with TTL + invalidation on save
- ✅ Fallback chain: DB → env var → hardcoded default
- ✅ All `isAdminOrBot` / `isVerified` call sites updated
- ✅ `GIVEAWAY_MANAGER_ROLE_ID` reads from config
- ✅ `SUPPORT_CHANNEL_URL` reads from config
- ✅ `guildCreate` welcome message
- ✅ `.env` cleaned up

**Placeholder scan:** No TBDs or incomplete steps.

**Type consistency:** `getServerConfig` returns the same shape (`roleAdmin`, `roleGiveawayManagers`, `roleVerified`, `supportChannelUrl`, `giveawayManagerRoleId`) in every task that references it.
