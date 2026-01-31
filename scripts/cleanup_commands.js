const { Client, GatewayIntentBits } = require('discord.js');
require('dotenv').config();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
  console.log('✅ Bot logged in, fetching commands...');
  
  try {
    const existingCommands = await client.application?.commands.fetch();
    console.log(`Found ${existingCommands.size} total commands\n`);
    
    const commandsToDelete = ['gw', 't', 'gwcheck'];
    let deletedCount = 0;
    
    for (const cmd of existingCommands.values()) {
      if (commandsToDelete.includes(cmd.name)) {
        console.log(`🗑️  Deleting /${cmd.name}...`);
        await cmd.delete();
        deletedCount++;
      }
    }
    
    if (deletedCount === 0) {
      console.log('⚠️  No stale commands found to delete.');
      console.log('Commands to delete:', commandsToDelete);
      console.log('Available commands:', existingCommands.map(c => c.name).join(', '));
    } else {
      console.log(`\n✅ Successfully deleted ${deletedCount} command(s)`);
      console.log('⏳ Restart your bot now to re-register commands fresh.');
    }
  } catch (err) {
    console.error('❌ Error during cleanup:', err);
  }
  
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN);
