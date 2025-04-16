const { spawn } = require('child_process');
const path = require('path');

// Start the bot process with nodemon
function startBot() {
  const botProcess = spawn('nodemon', ['index.js'], {
    stdio: 'inherit',
    detached: false,
    env: {
      ...process.env,
      FORCE_COLOR: '1' // Enable colored output
    }
  });

  botProcess.on('close', (code) => {
    console.log(`Bot process exited with code ${code}`);
    if (code === 100) { // Special exit code for restart
      console.log('Restarting bot...');
      startBot();
    }
  });

  // Handle process termination
  process.on('SIGINT', () => {
    botProcess.kill('SIGINT');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    botProcess.kill('SIGTERM');
    process.exit(0);
  });
}

console.log('🔄 Starting bot with hot-reload enabled...');
startBot();
