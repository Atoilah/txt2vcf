// Load environment variables
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const UserManager = require('./users');
const fs = require('fs');
const fsPromises = fs.promises;
const path = require('path');
const sanitize = require('sanitize-filename');
const os = require('os');
const process = require('process');
const VcfConverter = require('./vcfConverter');

// Format bytes to human readable
function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(value) / Math.log(k)), sizes.length - 1);
  return `${(value / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// Inisialisasi converter
const vcfConverter = new VcfConverter();

// Command akan menggunakan default limits dari UserManager

// Bot token dari environment variable
const token = process.env.BOT_TOKEN;
const ownerId = process.env.OWNER_ID;
const ownerChatId = process.env.OWNER_CHAT_ID;

// Buat instance bot dengan error handling
const bot = new TelegramBot(token, {
  polling: {
    autoStart: true,
    params: {
      timeout: 10
    }
  },
  filepath: false,
  baseApiUrl: 'https://api.telegram.org',
  request: {
    url: 'https://api.telegram.org'
  }
});

// Handle polling errors
bot.on('polling_error', (error) => {
  console.error(`Polling error: ${error.code}`, error.message);
  if (error.code === 'ETELEGRAM' && error.message.includes('terminated by other getUpdates')) {
    console.log('Detected conflicting bot instance, waiting before reconnecting...');
    setTimeout(() => {
      console.log('Attempting to restart polling...');
      bot.stopPolling().then(() => {
        return bot.startPolling();
      }).catch(console.error);
    }, 5000);
  }
});

// Inisialisasi user manager
const userManager = new UserManager();

// Fungsi untuk cek apakah pengirim adalah owner
const isOwner = (msg) => msg?.from?.id?.toString() === ownerId;

// Helper function to escape special characters for MarkdownV2
const escapeMarkdown = (text) => {
  return text.toString().replace(/[_*[\]()~`>#+=|{}.!\\-]/g, '\\$&');
};

// Helper function to format size to MB
const formatSizeMB = (bytes) => {
  return (bytes / (1024 * 1024)).toFixed(1);
};

const ALLOWED_FILE_EXTENSIONS = ['.txt', '.vcf'];
const USERFILES_DIR = path.join(__dirname, 'userfiles');

function getUserFolder(chatId) {
  return path.join(USERFILES_DIR, chatId.toString());
}

function hasAccess(msg) {
  const chatId = msg.chat.id;
  return userManager.hasUser(chatId) || isOwner(msg);
}

async function fileExists(filePath) {
  try {
    await fsPromises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function downloadTelegramFile(fileId, outputPath) {
  await fsPromises.mkdir(path.dirname(outputPath), { recursive: true });
  const fileStream = await bot.getFileStream(fileId);
  const writeStream = fs.createWriteStream(outputPath);
  await new Promise((resolve, reject) => {
    fileStream.pipe(writeStream)
      .on('finish', resolve)
      .on('error', reject);
  });
}


// Setting aman untuk multi-user dan retry kirim file
const SEND_FILE_MAX_RETRIES = 3;
const SEND_FILE_RETRY_DELAY_MS = 3000; // 3 detik, masih dalam saran 2-5 detik
const SEND_FILE_DELAY_BETWEEN_FILES_MS = 1500; // 1,5 detik antar file
const PROCESS_TIMEOUT_MS = 15 * 60 * 1000; // 15 menit
const processTimeouts = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeChatId(chatId) {
  return chatId.toString();
}

function getProcessLabel(state) {
  return state?.processName || state?.action || 'proses lain';
}

function isUserProcessActive(chatId) {
  const state = userManager.getUserState(chatId);
  return Boolean(state?.processLocked);
}

async function startUserProcess(chatId, processName, state = {}, timeoutMs = PROCESS_TIMEOUT_MS) {
  const existing = userManager.getUserState(chatId);
  if (existing?.processLocked) {
    await bot.sendMessage(
      chatId,
      `⏳ Masih ada proses "${getProcessLabel(existing)}" yang belum selesai.\n\n` +
      'Selesaikan dulu proses tersebut, atau ketik /cancel untuk membatalkannya.'
    );
    return false;
  }

  const lockedState = {
    ...state,
    processLocked: true,
    processName,
    startedAt: Date.now(),
    processTimeoutMs: timeoutMs
  };
  userManager.setUserState(chatId, lockedState);
  scheduleProcessTimeout(chatId, timeoutMs);
  return true;
}

function updateUserProcess(chatId, patch = {}) {
  const existing = userManager.getUserState(chatId) || {};
  const nextState = {
    ...existing,
    ...patch,
    processLocked: existing.processLocked || patch.processLocked || false,
    processName: patch.processName || existing.processName,
    processTimeoutMs: patch.processTimeoutMs || existing.processTimeoutMs
  };

  userManager.setUserState(chatId, nextState);

  if (nextState.processLocked) {
    scheduleProcessTimeout(chatId, nextState.processTimeoutMs || PROCESS_TIMEOUT_MS);
  }
}

function finishUserProcess(chatId) {
  const key = normalizeChatId(chatId);
  const timeout = processTimeouts.get(key);
  if (timeout) clearTimeout(timeout);
  processTimeouts.delete(key);
  userManager.clearUserState(chatId);
}

function scheduleProcessTimeout(chatId, timeoutMs = PROCESS_TIMEOUT_MS) {
  const key = normalizeChatId(chatId);
  const oldTimeout = processTimeouts.get(key);
  if (oldTimeout) clearTimeout(oldTimeout);

  const timeout = setTimeout(() => {
    const state = userManager.getUserState(chatId);
    if (state?.processLocked) {
      userManager.clearUserState(chatId);
      processTimeouts.delete(key);
      bot.sendMessage(
        chatId,
        `⌛ Proses "${getProcessLabel(state)}" otomatis dibatalkan karena terlalu lama tidak selesai. Silakan mulai lagi.`
      ).catch(() => {});
    }
  }, timeoutMs);

  processTimeouts.set(key, timeout);
}

async function rejectIfBusy(chatId, processName) {
  const existing = userManager.getUserState(chatId);
  if (!existing?.processLocked) return false;

  await bot.sendMessage(
    chatId,
    `⏳ Tidak bisa memulai ${processName} karena proses "${getProcessLabel(existing)}" masih berjalan.\n\n` +
    'Tunggu sampai selesai, atau ketik /cancel untuk membatalkan proses yang aktif.'
  );
  return true;
}


function assertProcessActive(chatId, expectedProcessName = null) {
  const state = userManager.getUserState(chatId);
  const isActive = Boolean(state?.processLocked) && (!expectedProcessName || state.processName === expectedProcessName);
  if (!isActive) {
    const error = new Error('Proses sudah dibatalkan atau kedaluwarsa.');
    error.code = 'PROCESS_CANCELLED';
    throw error;
  }
  return state;
}



// Command /cancel - membatalkan proses multi-step aktif milik user
bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;

  if (!hasAccess(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const state = userManager.getUserState(chatId);
  if (!state?.processLocked) {
    bot.sendMessage(chatId, 'ℹ️ Tidak ada proses aktif yang perlu dibatalkan.');
    return;
  }

  const processName = getProcessLabel(state);
  finishUserProcess(chatId);
  bot.sendMessage(chatId, `❌ Proses "${processName}" dibatalkan. Anda bisa memulai proses baru sekarang.`);
});

// Command /getid - dapat diakses semua orang
bot.onText(/\/getid/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username || 'Tidak ada';
  const firstName = msg.from.first_name || 'Tidak ada';
  const lastName = msg.from.last_name || 'Tidak ada';

  const message = `💻 Informasi ID Anda:\n\n` +
    `🔑 Chat ID: ${chatId}\n` +
    `👤 User ID: ${userId}\n` +
    `📝 Username: @${username}\n` +
    `👱 Nama: ${firstName} ${lastName}\n\n` +
    `ℹ️ Gunakan Chat ID ini untuk mendaftar ke bot.\n` +
    `💬 Hubungi owner bot untuk didaftarkan.`;

  bot.sendMessage(chatId, message);
});

// Command /start - hanya untuk user terdaftar
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;

  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.\nHubungi owner untuk mendapatkan akses.');
    return;
  }

  let message = 'Halo! Selamat datang di bot. 👋\n';
  message += `\nℹ️ Status: ${isOwner(msg) ? 'Owner' : 'User Terdaftar'}`;
  message += `\nℹ️ Total pengguna: ${userManager.getUserCount()}`;
  bot.sendMessage(chatId, message);
});

// Command /status - hanya untuk owner
bot.onText(/\/status/, (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }
  bot.sendMessage(chatId, '✅ Bot berjalan normal\nMemory usage: ' + process.memoryUsage().heapUsed / 1024 / 1024 + ' MB');
});

// Command /broadcast - hanya untuk owner
bot.onText(/\/broadcast (.+)/, async (msg, match) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }
  const text = match[1];
  const users = userManager.getUsers();
  let successCount = 0;
  let failCount = 0;

  // Kirim pesan ke owner bahwa broadcast dimulai
  await bot.sendMessage(msg.chat.id, `📣 Memulai broadcast ke ${users.length} pengguna...`);

  // Broadcast ke semua user
  for (const userId of users) {
    try {
      await bot.sendMessage(userId, `📣 BROADCAST\n\n${text}`);
      successCount++;
    } catch (error) {
      console.log(`Failed to send to ${userId}:`, error.message);
      failCount++;
    }
  }

  // Kirim laporan hasil broadcast
  bot.sendMessage(msg.chat.id, `📣 Broadcast selesai!\n✅ Berhasil: ${successCount}\n❌ Gagal: ${failCount}`);
});

// Command /stats - hanya untuk owner
bot.onText(/\/stats/, async (msg) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }

  // Sistem info
  const cpus = os.cpus();
  const totalMemory = os.totalmem();
  const freeMemory = os.freemem();
  const usedMemory = totalMemory - freeMemory;
  const memoryUsage = process.memoryUsage();

  const stats = {
    totalUsers: userManager.getUserCount(),
    uptime: Math.floor(process.uptime()),
    system: {
      platform: os.platform(),
      type: os.type(),
      release: os.release(),
      arch: os.arch(),
      cpu: {
        model: cpus[0].model,
        cores: cpus.length,
        speed: cpus[0].speed + 'MHz'
      },
      memory: {
        total: (totalMemory / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
        free: (freeMemory / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
        used: (usedMemory / (1024 * 1024 * 1024)).toFixed(2) + ' GB',
        percentage: Math.round((usedMemory / totalMemory) * 100) + '%'
      },
      bot: {
        memory: (memoryUsage.heapUsed / (1024 * 1024)).toFixed(2) + ' MB',
        memoryTotal: (memoryUsage.heapTotal / (1024 * 1024)).toFixed(2) + ' MB'
      }
    }
  };

  const message = `📊 Statistik Bot:\n\n` +
    `👥 Total Pengguna: ${stats.totalUsers}\n` +
    `⏱ Uptime: ${Math.floor(stats.uptime / 3600)}h ${Math.floor((stats.uptime % 3600) / 60)}m ${stats.uptime % 60}s\n\n` +
    `💻 Informasi Sistem:\n` +
    `• Platform: ${stats.system.platform} (${stats.system.type})\n` +
    `• Versi OS: ${stats.system.release}\n` +
    `• Arsitektur: ${stats.system.arch}\n\n` +
    `📟 CPU Info:\n` +
    `• Model: ${stats.system.cpu.model}\n` +
    `• Cores: ${stats.system.cpu.cores}\n` +
    `• Speed: ${stats.system.cpu.speed}\n\n` +
    `📋 Memory Sistem:\n` +
    `• Total: ${stats.system.memory.total}\n` +
    `• Terpakai: ${stats.system.memory.used} (${stats.system.memory.percentage})\n` +
    `• Tersedia: ${stats.system.memory.free}\n\n` +
    `🤖 Memory Bot:\n` +
    `• Terpakai: ${stats.system.bot.memory}\n` +
    `• Dialokasikan: ${stats.system.bot.memoryTotal}`;

  bot.sendMessage(msg.chat.id, message);
});

// Command /restart - hanya untuk owner
bot.onText(/\/restart/, async (msg) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }

  try {
    await bot.sendMessage(msg.chat.id, '🔄 Memulai proses restart bot...');
    console.log('Restarting bot by owner command...');
    // Gunakan exit code 100 untuk menandakan restart
    process.exit(100);
  } catch (error) {
    console.error('Error during restart:', error);
    bot.sendMessage(msg.chat.id, '❌ Gagal melakukan restart: ' + error.message);
  }
});

// Command user management - hanya untuk owner
bot.onText(/\/adduser (.+)/, async (msg, match) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }

  const chatId = match[1];
  try {
    const added = await userManager.addUser(chatId);
    if (added) {
      bot.sendMessage(msg.chat.id, `✅ Berhasil menambahkan user dengan Chat ID: ${chatId}`);
      try {
        await bot.sendMessage(chatId, '🎉 Selamat! Anda telah ditambahkan sebagai user bot oleh owner.');
      } catch (error) {
        bot.sendMessage(msg.chat.id, '⚠️ User ditambahkan tapi gagal mengirim notifikasi ke user.');
      }
    } else {
      bot.sendMessage(msg.chat.id, 'ℹ️ User sudah terdaftar sebelumnya.');
    }
  } catch (error) {
    bot.sendMessage(msg.chat.id, '❌ Gagal menambahkan user: ' + error.message);
  }
});

bot.onText(/\/removeuser (.+)/, async (msg, match) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }

  const chatId = match[1];
  try {
    const removed = await userManager.removeUser(chatId);
    if (removed) {
      bot.sendMessage(msg.chat.id, `✅ Berhasil menghapus user dengan Chat ID: ${chatId}`);
      try {
        await bot.sendMessage(chatId, '⚠️ Akses Anda ke bot telah dicabut oleh owner.');
      } catch (error) {
        bot.sendMessage(msg.chat.id, '⚠️ User dihapus tapi gagal mengirim notifikasi ke user.');
      }
    } else {
      bot.sendMessage(msg.chat.id, 'ℹ️ User tidak ditemukan dalam daftar.');
    }
  } catch (error) {
    bot.sendMessage(msg.chat.id, '❌ Gagal menghapus user: ' + error.message);
  }
});

bot.onText(/\/listusers/, async (msg) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }

  const users = userManager.getUsers();
  const message = `📊 Daftar User (${users.length}):\n\n` +
    users.map((userId, index) => `${index + 1}. Chat ID: ${userId}`).join('\n');

  bot.sendMessage(msg.chat.id, message);
});

// Fungsi untuk mengecek ukuran folder user
async function getUserStorageInfo(userFolder) {
  try {
    await fsPromises.mkdir(userFolder, { recursive: true });
    const files = await fsPromises.readdir(userFolder);
    const managedFiles = files.filter(file => ALLOWED_FILE_EXTENSIONS.includes(path.extname(file).toLowerCase()));
    const sizes = await Promise.all(
      managedFiles.map(async (file) => {
        const stats = await fsPromises.stat(path.join(userFolder, file));
        return stats.size;
      })
    );

    return {
      fileCount: managedFiles.length,
      totalSize: sizes.reduce((total, size) => total + size, 0)
    };
  } catch (error) {
    console.error('Error getting storage info:', error);
    throw error;
  }
}

// Command /storage - cek penggunaan storage
bot.onText(/\/storage/, async (msg) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const userFolder = path.join(__dirname, 'userfiles', chatId.toString());
  const storage = await getUserStorageInfo(userFolder);

  const limits = userManager.getStorageLimits(chatId);
  const message = `💾 Info Penyimpanan Anda:\n\n` +
    `🖪 Batasan:\n` +
    `• Jumlah File: ${limits.MAX_FILES_PER_USER}\n` +
    `• Ukuran/File: ${formatBytes(limits.MAX_FILE_SIZE)}\n` +
    `• Total Ukuran: ${formatBytes(limits.MAX_TOTAL_SIZE)}\n\n` +
    `📂 Penggunaan:\n` +
    `• Jumlah File: ${storage.fileCount}/${limits.MAX_FILES_PER_USER}\n` +
    `• Total Ukuran: ${formatBytes(storage.totalSize)}/${formatBytes(limits.MAX_TOTAL_SIZE)}\n` +
    `• Maks. Ukuran/File: ${formatBytes(limits.MAX_FILE_SIZE)}\n` +
    `• Persentase: ${Math.round((storage.totalSize / limits.MAX_TOTAL_SIZE) * 100)}%`;

  bot.sendMessage(chatId, message);
});

// Command /createtxt - membuat file txt
bot.onText(/\/createtxt ([\w-]+) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  if (!(await startUserProcess(chatId, 'membuat file TXT', { action: 'create_txt' }))) return;

  const fileName = sanitize(match[1]); // Nama file dari user (parameter pertama)
  const content = match[2]; // Konten file (parameter kedua)
  const userFolder = path.join(__dirname, 'userfiles', chatId.toString());
  const filePath = path.join(userFolder, `${fileName}.txt`);

  try {
    // Cek batasan penyimpanan
    const storage = await getUserStorageInfo(userFolder);
    const contentSize = Buffer.from(content).length;
    const limits = userManager.getStorageLimits(chatId);

    // Cek jumlah file
    if (storage.fileCount >= limits.MAX_FILES_PER_USER) {
      bot.sendMessage(chatId, '⚠️ Batas maksimal jumlah file tercapai!\n\nHapus beberapa file lama menggunakan /deletefile untuk membuat file baru.');
      return;
    }

    // Cek ukuran file baru
    if (contentSize > limits.MAX_FILE_SIZE) {
      bot.sendMessage(chatId, `⚠️ Ukuran file terlalu besar!\n\nMaksimal: ${(limits.MAX_FILE_SIZE / 1024).toFixed(1)}KB\nUkuran file: ${(contentSize / 1024).toFixed(1)}KB`);
      return;
    }

    // Cek total ukuran
    if (storage.totalSize + contentSize > limits.MAX_TOTAL_SIZE) {
      bot.sendMessage(chatId, '⚠️ Total ukuran penyimpanan akan melebihi batas!\n\nHapus beberapa file lama menggunakan /deletefile untuk membuat file baru.');
      return;
    }
    // Buat folder user jika belum ada
    await fsPromises.mkdir(userFolder, { recursive: true });

    // Tulis file
    await fsPromises.writeFile(filePath, content, 'utf8');

    bot.sendMessage(chatId, `✅ File berhasil dibuat!\n\n📝 Nama: ${fileName}.txt\n💾 Lokasi: /userfiles/${chatId}/${fileName}.txt`);

    // Kirim file ke user dengan retry 3x
    try {
      await sendFile(chatId, filePath, `📝 File txt Anda: ${fileName}.txt`);
    } catch (sendError) {
      console.error('Error sending created TXT file:', sendError);
      await bot.sendMessage(
        chatId,
        `⚠️ File ${fileName}.txt sudah dibuat dan tersimpan, tetapi gagal dikirim setelah ${SEND_FILE_MAX_RETRIES}x percobaan. Gunakan /getfile ${fileName} untuk mengambil ulang.`
      );
    }

  } catch (error) {
    console.error('Error creating file:', error);
    bot.sendMessage(chatId, '❌ Gagal membuat file: ' + error.message);
  } finally {
    finishUserProcess(chatId);
  }
});

// Command /myfiles - melihat daftar file
bot.onText(/\/myfiles/, async (msg) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const userFolder = path.join(__dirname, 'userfiles', chatId.toString());

  try {
    // Buat folder user jika belum ada
    await fsPromises.mkdir(userFolder, { recursive: true });

    // Baca daftar file
    const files = await fsPromises.readdir(userFolder);
    const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'));
    const vcfFiles = files.filter(f => f.toLowerCase().endsWith('.vcf'));

    if (txtFiles.length === 0 && vcfFiles.length === 0) {
      bot.sendMessage(chatId, 'ℹ️ Anda belum memiliki file apapun.');
      return;
    }

    let message = `📁 Daftar File Anda\n\n`;

    // Tampilkan file txt
    if (txtFiles.length > 0) {
      message += `📝 File TXT (${txtFiles.length}):\n`;
      message += txtFiles.map((file, index) => {
        const stats = fs.statSync(path.join(userFolder, file));
        const size = formatBytes(stats.size);
        return `${index + 1}. ${file}\n   └ Ukuran: ${size}`;
      }).join('\n');
    }

    // Tampilkan file vcf
    if (vcfFiles.length > 0) {
      if (txtFiles.length > 0) message += '\n\n';
      message += `📱 File VCF (${vcfFiles.length}):\n`;
      message += vcfFiles.map((file, index) => {
        const stats = fs.statSync(path.join(userFolder, file));
        const size = formatBytes(stats.size);
        return `${index + 1}. ${file}\n   └ Ukuran: ${size}`;
      }).join('\n');
    }

    message += '\n\nℹ️ Perintah yang tersedia:\n';
    message += '• /getfile [nama] - mengambil file\n';
    message += '• /deletefile [nama] - menghapus file\n';
    message += '• /txt2vcf [nama] - konversi TXT ke VCF\n\n';
    message += '💡 Tips: Gunakan nama file tanpa ekstensi\n';
    message += 'Contoh: /getfile contacts';

    bot.sendMessage(chatId, message);

  } catch (error) {
    console.error('Error listing files:', error);
    bot.sendMessage(chatId, '❌ Gagal membaca daftar file: ' + error.message);
  }
});

// Command /getfile - mengambil file
bot.onText(/\/getfile (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const requestedName = sanitize(path.parse(match[1]).name);
  const requestedExt = path.extname(match[1]).toLowerCase();
  const userFolder = getUserFolder(chatId);
  const candidates = requestedExt
    ? [path.join(userFolder, `${requestedName}${requestedExt}`)]
    : [path.join(userFolder, `${requestedName}.txt`), path.join(userFolder, `${requestedName}.vcf`)];

  try {
    const inputPath = candidates.find(filePath => fs.existsSync(filePath));
    if (!inputPath) {
      bot.sendMessage(chatId, `❌ File ${requestedName}.txt atau ${requestedName}.vcf tidak ditemukan.`);
      return;
    }

    await sendFile(chatId, inputPath, '');
  } catch (error) {
    bot.sendMessage(chatId, '❌ Gagal mengambil file: ' + error.message);
  }
});

// Command /active - melihat user aktif (owner only)
bot.onText(/\/active/, async (msg) => {
  if (!isOwner(msg)) {
    bot.sendMessage(msg.chat.id, '⛔ Maaf, command ini hanya untuk owner!');
    return;
  }

  const activeUsers = userManager.getActiveUsers();
  if (activeUsers.length === 0) {
    bot.sendMessage(msg.chat.id, 'ℹ️ Tidak ada user yang aktif saat ini.');
    return;
  }

  const message = `📊 User Aktif (${activeUsers.length}):\n\n` +
    activeUsers.map((user, index) => {
      return `${index + 1}. Chat ID: ${user.chatId}\n` +
        `   ⏰ Terakhir aktif: ${user.lastActive}\n` +
        `   ⏳ Idle: ${user.idleTime} menit`;
    }).join('\n\n');

  bot.sendMessage(msg.chat.id, message);
});

// Handle file upload umum (.txt/.vcf) dengan lock per user
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const file = msg.document;
  const currentState = userManager.getUserState(chatId);

  // File yang dikirim sebagai reply untuk flow tertentu akan diproses oleh handler flow tersebut.
  // Upload merge VCF juga memiliki handler khusus di bawah.
  if (msg.reply_to_message || currentState?.action === 'merge_upload_files') return;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const fileExt = path.extname(file.file_name).toLowerCase();
  if (!ALLOWED_FILE_EXTENSIONS.includes(fileExt)) {
    bot.sendMessage(chatId, '⚠️ Hanya file .txt dan .vcf yang diperbolehkan!');
    return;
  }

  if (!(await startUserProcess(chatId, 'upload file', { action: 'upload_file' }))) return;

  try {
    const userFolder = getUserFolder(chatId);
    await fsPromises.mkdir(userFolder, { recursive: true });

    let fileName = sanitize(file.file_name);
    let filePath = path.join(userFolder, fileName);
    let alreadyExists = await fileExists(filePath);
    let oldSize = alreadyExists ? (await fsPromises.stat(filePath)).size : 0;

    // Jika nama file sudah ada, minta keputusan user tanpa melepas lock.
    if (alreadyExists) {
      updateUserProcess(chatId, { action: 'upload_wait_overwrite_choice' });
      const confirmMsg = await bot.sendMessage(
        chatId,
        `⚠️ File dengan nama "${fileName}" sudah ada!\n\nApakah Anda ingin:\n` +
        '1. Ganti nama file\n' +
        '2. Timpa file yang ada\n' +
        '3. Batalkan upload\n\n' +
        'Pilih dengan mengirim nomor (1-3)',
        { reply_markup: { force_reply: true, selective: true } }
      );

      const response = await new Promise(resolve => {
        bot.onReplyToMessage(chatId, confirmMsg.message_id, (responseMsg) => {
          resolve((responseMsg.text || '').trim());
        });
      });
      assertProcessActive(chatId, 'upload file');

      if (response === '1') {
        updateUserProcess(chatId, { action: 'upload_wait_new_name' });
        const askNewName = await bot.sendMessage(
          chatId,
          `📝 Masukkan nama baru untuk file (tanpa ${fileExt}):`,
          { reply_markup: { force_reply: true, selective: true } }
        );

        const newName = await new Promise(resolve => {
          bot.onReplyToMessage(chatId, askNewName.message_id, (nameMsg) => {
            resolve(`${sanitize(path.parse(nameMsg.text || '').name)}${fileExt}`);
          });
        });
        assertProcessActive(chatId, 'upload file');

        if (!sanitize(path.parse(newName).name)) {
          bot.sendMessage(chatId, '❌ Nama file tidak valid. Upload dibatalkan.');
          return;
        }

        fileName = newName;
        filePath = path.join(userFolder, fileName);
        alreadyExists = await fileExists(filePath);
        oldSize = alreadyExists ? (await fsPromises.stat(filePath)).size : 0;
      } else if (response === '2') {
        // Lanjut timpa file yang ada
      } else {
        bot.sendMessage(chatId, '❌ Upload dibatalkan.');
        return;
      }
    }

    updateUserProcess(chatId, { action: 'upload_check_limit' });

    // Cek batasan penyimpanan
    const storage = await getUserStorageInfo(userFolder);
    const limits = userManager.getStorageLimits(chatId);

    if (!alreadyExists && storage.fileCount >= limits.MAX_FILES_PER_USER) {
      bot.sendMessage(chatId, '⚠️ Batas maksimal jumlah file tercapai!\n\nHapus beberapa file lama menggunakan /deletefile untuk mengunggah file baru.');
      return;
    }

    if (file.file_size > limits.MAX_FILE_SIZE) {
      bot.sendMessage(chatId, `⚠️ Ukuran file terlalu besar!\n\nMaksimal: ${formatBytes(limits.MAX_FILE_SIZE)}\nUkuran file: ${formatBytes(file.file_size)}`);
      return;
    }

    if (storage.totalSize - oldSize + file.file_size > limits.MAX_TOTAL_SIZE) {
      bot.sendMessage(chatId, '⚠️ Total ukuran penyimpanan akan melebihi batas!\n\nHapus beberapa file lama menggunakan /deletefile untuk mengunggah file baru.');
      return;
    }

    updateUserProcess(chatId, { action: 'upload_downloading' });
    await downloadTelegramFile(file.file_id, filePath);

    const finalFileName = path.basename(filePath);
    bot.sendMessage(chatId, `✅ File berhasil diunggah!\n\n📝 Nama: ${finalFileName}\n💾 Lokasi: /userfiles/${chatId}/${finalFileName}\n\nGunakan command /txt2vcf ${path.parse(finalFileName).name} untuk mengkonversi ke VCF`);

  } catch (error) {
    if (error.code !== 'PROCESS_CANCELLED') {
      console.error('Error uploading file:', error);
      bot.sendMessage(chatId, '❌ Gagal mengunggah file: ' + error.message);
    }
  } finally {
    finishUserProcess(chatId);
  }
});

// Handle semua interaksi untuk tracking aktivitas
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  if (userManager.hasUser(chatId.toString()) || isOwner(msg)) {
    userManager.trackUserActivity(chatId);
  }

  // Handle pesan biasa
  if (msg.text && !msg.text.startsWith('/')) {
    const chatId = msg.chat.id;
    if (!userManager.hasUser(chatId) && !isOwner(msg)) {
      bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.\nHubungi owner untuk mendapatkan akses.');
      return;
    }

    // Jangan balas generik saat user sedang menjalankan proses multi-step.
    if (userManager.getUserState(chatId)) return;

    if (isOwner(msg)) {
      bot.sendMessage(chatId, 'Hai Owner! 👑');
    } else {
      bot.sendMessage(chatId, 'Hai User! Gunakan command yang tersedia.');
    }
  }
});

console.log('Bot telah dimulai!');

// Kirim pesan broadcast ke owner saat bot start
if (ownerChatId && ownerChatId !== 'your_telegram_chat_id') {
  const startTime = new Date().toLocaleString();
  bot.sendMessage(ownerChatId, `🤖 Bot telah aktif!
⏰ Waktu: ${startTime}
✅ Status: Online

Siap menerima perintah, Owner! 👋`)
    .catch(error => {
      console.log('Gagal mengirim pesan startup:', error.message);
      if (error.message.includes('chat not found')) {
        console.log('Pastikan OWNER_CHAT_ID di file .env sudah diisi dengan benar!');
      }
    });
} else {
  console.log('OWNER_CHAT_ID belum diset di file .env');
}

// Handle shutdown signals
async function handleShutdown() {
  console.log('Mematikan bot...');
  if (ownerChatId && ownerChatId !== 'your_telegram_chat_id') {
    const shutdownTime = new Date().toLocaleString();
    try {
      await bot.sendMessage(ownerChatId, `⚠️ Bot dimatikan!
⏰ Waktu: ${shutdownTime}
❌ Status: Offline

Bot akan berhenti menerima perintah. Goodbye! 👋`);
    } catch (error) {
      console.error('Gagal mengirim pesan shutdown:', error.message);
      if (error.message.includes('chat not found')) {
        console.log('Pastikan OWNER_CHAT_ID di file .env sudah diisi dengan benar!');
      }
    }
  }
  process.exit(0);
}

// Menangkap sinyal shutdown
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

// Command /txt2vcf - konversi file txt ke vcf
bot.onText(/\/txt2vcf(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!hasAccess(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  if (!(await startUserProcess(chatId, 'konversi TXT ke VCF', { action: 'txt2vcf_start' }))) return;

  const userFolder = getUserFolder(chatId);
  const requestedName = match?.[1] ? sanitize(path.parse(match[1]).name) : null;

  // Mode cepat: /txt2vcf nama_file yang sudah tersimpan
  if (requestedName) {
    await processConversion(chatId, requestedName, userFolder);
    return;
  }

  try {
    updateUserProcess(chatId, { action: 'txt2vcf_wait_upload' });

    // Minta user untuk upload file
    const uploadMsg = await bot.sendMessage(
      chatId,
      '📤 Silakan kirim file .txt yang ingin dikonversi ke VCF\n\nAtau gunakan: /txt2vcf nama_file jika file sudah ada di /myfiles',
      { reply_markup: { force_reply: true, selective: true } }
    );

    // Tunggu user mengirim file
    bot.onReplyToMessage(chatId, uploadMsg.message_id, async (fileMsg) => {
      try {
        assertProcessActive(chatId, 'konversi TXT ke VCF');
      } catch {
        return;
      }

      if (!fileMsg.document) {
        bot.sendMessage(chatId, '⚠️ Mohon kirim file dalam format dokumen!');
        finishUserProcess(chatId);
        return;
      }

      const file = fileMsg.document;

      // Cek tipe file
      if (!file.file_name.toLowerCase().endsWith('.txt')) {
        bot.sendMessage(chatId, '⚠️ Hanya file .txt yang diperbolehkan!');
        finishUserProcess(chatId);
        return;
      }

      try {
        updateUserProcess(chatId, { action: 'txt2vcf_download_input' });
        await fsPromises.mkdir(userFolder, { recursive: true });

        const fileName = sanitize(file.file_name);
        const filePath = path.join(userFolder, fileName);

        // Cek batasan penyimpanan
        const storage = await getUserStorageInfo(userFolder);
        const limits = userManager.getStorageLimits(chatId);
        const alreadyExists = await fileExists(filePath);
        const oldSize = alreadyExists ? (await fsPromises.stat(filePath)).size : 0;

        if (!alreadyExists && storage.fileCount >= limits.MAX_FILES_PER_USER) {
          bot.sendMessage(chatId, '⚠️ Batas maksimal jumlah file tercapai!\n\nHapus beberapa file lama menggunakan /deletefile untuk mengunggah file baru.');
          finishUserProcess(chatId);
          return;
        }

        if (file.file_size > limits.MAX_FILE_SIZE) {
          bot.sendMessage(chatId, `⚠️ Ukuran file terlalu besar!\n\nMaksimal: ${formatBytes(limits.MAX_FILE_SIZE)}\nUkuran file: ${formatBytes(file.file_size)}`);
          finishUserProcess(chatId);
          return;
        }

        if (storage.totalSize - oldSize + file.file_size > limits.MAX_TOTAL_SIZE) {
          bot.sendMessage(chatId, '⚠️ Total ukuran penyimpanan akan melebihi batas!\n\nHapus beberapa file lama menggunakan /deletefile untuk mengunggah file baru.');
          finishUserProcess(chatId);
          return;
        }

        await downloadTelegramFile(file.file_id, filePath);

        const txtFileName = path.parse(fileName).name;
        await processConversion(chatId, txtFileName, userFolder);

      } catch (error) {
        if (error.code !== 'PROCESS_CANCELLED') {
          console.error('Error uploading file:', error);
          bot.sendMessage(chatId, '❌ Gagal mengunggah file: ' + error.message);
        }
        finishUserProcess(chatId);
      }
    });
  } catch (error) {
    console.error('Error starting txt2vcf:', error);
    bot.sendMessage(chatId, '❌ Gagal memulai konversi: ' + error.message);
    finishUserProcess(chatId);
  }
});

// Fungsi untuk memproses konversi txt ke vcf
async function processConversion(chatId, txtFileName, userFolder) {
  const inputPath = path.join(userFolder, `${txtFileName}.txt`);

  try {
    updateUserProcess(chatId, { action: 'txt2vcf_validate_input' });

    // Cek apakah file txt ada
    try {
      await fsPromises.access(inputPath, fs.constants.F_OK);
    } catch (err) {
      bot.sendMessage(chatId, `❌ File ${txtFileName}.txt tidak ditemukan.\n\nGunakan /txt2vcf untuk melihat daftar file yang tersedia.`);
      return;
    }

    // Baca file dan validasi nomor
    const content = await fsPromises.readFile(inputPath, 'utf8');

    // Hapus baris kosong dan whitespace
    const cleanContent = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0)
      .join('\n');

    // Validasi format nomor
    const validation = vcfConverter.validatePhoneNumbers(cleanContent);

    if (!validation.valid) {
      const invalidList = validation.invalidNumbers
        .map((item, i) => `${i + 1}. ${item.original} - ${item.error}`)
        .join('\n');

      bot.sendMessage(chatId,
        `⚠️ Ditemukan ${validation.invalidNumbers.length} nomor tidak valid:\n\n${invalidList}\n\n` +
        'Format yang didukung:\n' +
        '1. Format lokal: 0812xxx, 628xxx\n' +
        '2. Format internasional: +1xxx (US), +44xxx (UK), dll\n' +
        '3. Minimal 10 digit (termasuk kode negara)');
      return;
    }

    updateUserProcess(chatId, { action: 'txt2vcf_wait_contact_name' });

    // Tanya nama kontak
    const askName = await bot.sendMessage(chatId,
      '📝 Masukkan nama untuk kontak ini:\n' +
      '💡 Tips: Nama akan digunakan sebagai prefix untuk semua kontak', {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });

    const nameResponse = await new Promise(resolve => {
      bot.onReplyToMessage(chatId, askName.message_id, async (nameMsg) => {
        resolve(nameMsg.text);
      });
    });
    assertProcessActive(chatId, 'konversi TXT ke VCF');

    updateUserProcess(chatId, { action: 'txt2vcf_wait_start_number' });

    // Tanya nomor urut awal
    const askStartNumber = await bot.sendMessage(chatId,
      '🔢 Masukkan nomor urut awal:\n' +
      '💡 Tips: Nomor urut akan ditambahkan setelah nama kontak', {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });

    const startNumberResponse = await new Promise(resolve => {
      bot.onReplyToMessage(chatId, askStartNumber.message_id, async (numMsg) => {
        const num = parseInt(numMsg.text);
        resolve(isNaN(num) ? 1 : num);
      });
    });
    assertProcessActive(chatId, 'konversi TXT ke VCF');

    updateUserProcess(chatId, { action: 'txt2vcf_wait_vcf_name' });

    // Tanya nama file VCF
    const defaultVcfName = txtFileName.replace(/[-_\s]+/g, '_').toLowerCase();
    const askVcfName = await bot.sendMessage(chatId,
      '💾 Masukkan nama file VCF:\n' +
      `Default: ${defaultVcfName}\n\n` +
      'Ketik nama baru atau kirim . (titik) untuk menggunakan nama default', {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });

    const vcfFileName = await new Promise(resolve => {
      bot.onReplyToMessage(chatId, askVcfName.message_id, async (vcfMsg) => {
        const name = vcfMsg.text.trim();
        resolve(name === '.' ? defaultVcfName : sanitize(name));
      });
    });
    assertProcessActive(chatId, 'konversi TXT ke VCF');

    updateUserProcess(chatId, { action: 'txt2vcf_wait_file_number' });

    // Tanya nomor urut file
    const askFileNumber = await bot.sendMessage(chatId,
      '🔢 Masukkan nomor urut awal untuk file:\n' +
      'Contoh: Jika anda ketik 1, file akan dimulai dari _1.vcf\n' +
      'Default: 1\n\n' +
      'Ketik angka atau kirim . (titik) untuk menggunakan default', {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });

    const fileStartNumber = await new Promise(resolve => {
      bot.onReplyToMessage(chatId, askFileNumber.message_id, async (numMsg) => {
        const num = numMsg.text.trim() === '.' ? 1 : parseInt(numMsg.text);
        resolve(isNaN(num) ? 1 : num);
      });
    });
    assertProcessActive(chatId, 'konversi TXT ke VCF');

    updateUserProcess(chatId, { action: 'txt2vcf_wait_split_count' });

    // Tanya jumlah file
    const totalContacts = cleanContent.split('\n').length;
    const recommendedSplit = totalContacts > 1000 ? Math.ceil(totalContacts / 1000) : 0;

    const askSplitCount = await bot.sendMessage(chatId,
      '📂 Ingin memecah kontak menjadi berapa file?\n\n' +
      `ℹ️ Total kontak: ${totalContacts}\n` +
      (recommendedSplit > 0 ? `💡 Rekomendasi: ${recommendedSplit} file\n` : '') +
      '\nKetik 0 untuk tidak memecah (semua kontak dalam 1 file)\n' +
      'Ketik angka untuk jumlah kontak setiap file', {
      reply_markup: {
        force_reply: true,
        selective: true
      }
    });

    const splitCountResponse = await new Promise(resolve => {
      bot.onReplyToMessage(chatId, askSplitCount.message_id, async (splitMsg) => {
        const num = parseInt(splitMsg.text);
        resolve(isNaN(num) ? 0 : num);
      });
    });
    assertProcessActive(chatId, 'konversi TXT ke VCF');

    updateUserProcess(chatId, { action: 'txt2vcf_converting' });

    // Konversi ke vcf dengan nama dan nomor urut yang diberikan
    const result = await vcfConverter.convertTxtToVcf(inputPath, {
      name: nameResponse,
      startNumber: startNumberResponse,
      splitCount: splitCountResponse,
      fileStartNumber: fileStartNumber
    });

    updateUserProcess(chatId, { action: 'txt2vcf_saving_output' });

    // Siapkan output dan cek limit storage sebelum file ditulis
    const outputItems = [];
    for (let i = 0; i < result.contents.length; i++) {
      const suffix = result.fileCount > 1 ? ` ${i + fileStartNumber}` : '';
      const outputPath = path.join(userFolder, `${vcfFileName}${suffix}.vcf`);
      outputItems.push({
        outputPath,
        content: result.contents[i],
        size: Buffer.byteLength(result.contents[i], 'utf8')
      });
    }

    const storageBeforeOutput = await getUserStorageInfo(userFolder);
    const limits = userManager.getStorageLimits(chatId);
    let replacedSize = 0;
    let newFileCount = 0;

    for (const item of outputItems) {
      const exists = await fileExists(item.outputPath);
      if (exists) {
        replacedSize += (await fsPromises.stat(item.outputPath)).size;
      } else {
        newFileCount++;
      }

      if (item.size > limits.MAX_FILE_SIZE) {
        throw new Error(`File hasil VCF terlalu besar: ${path.basename(item.outputPath)} (${formatBytes(item.size)}). Maksimal ${formatBytes(limits.MAX_FILE_SIZE)}.`);
      }
    }

    const totalOutputSize = outputItems.reduce((sum, item) => sum + item.size, 0);

    if (storageBeforeOutput.fileCount + newFileCount > limits.MAX_FILES_PER_USER) {
      throw new Error('Jumlah file hasil konversi akan melewati batas. Kurangi jumlah split atau hapus file lama dengan /clean.');
    }

    if (storageBeforeOutput.totalSize - replacedSize + totalOutputSize > limits.MAX_TOTAL_SIZE) {
      throw new Error('Total storage akan melewati batas setelah konversi. Hapus file lama dulu dengan /clean atau kecilkan hasil split.');
    }

    // Simpan file-file vcf
    const outputPaths = [];
    for (const item of outputItems) {
      await fsPromises.writeFile(item.outputPath, item.content, 'utf8');
      outputPaths.push(item.outputPath);
    }

    // Hitung total nomor
    const totalNumbers = Object.values(result.countrySummary)
      .reduce((total, count) => total + count, 0);

    // Import country data
    const { COUNTRY_DATA } = require('./countryData');

    // Buat ringkasan per negara
    const countries = Object.entries(result.countrySummary);
    const totalCountries = countries.length;
    const countrySummary = countries
      .sort((a, b) => b[1] - a[1]) // Sort by count descending
      .map(([code, count]) => {
        const countryName = COUNTRY_DATA[code]?.name || code;
        const percentage = ((count / totalNumbers) * 100).toFixed(1);
        return `${countryName}: ${count} (${percentage}%)`;
      })
      .join('\n');

    // Kirim pesan sukses
    await bot.sendMessage(chatId,
      `✅ Berhasil mengkonversi ${result.count} kontak!\n\n` +
      `📄 Input: ${txtFileName}.txt\n` +
      `💾 Output: ${result.fileCount} file VCF\n` +
      `💼 Nama: ${nameResponse}\n` +
      `🔢 Mulai dari: ${startNumberResponse}\n` +
      `📂 Jumlah file: ${result.fileCount}\n\n` +
      `🌍 Ditemukan ${totalCountries} negara:\n${countrySummary}\n\n` +
      `📄 Hasil: ${vcfFileName}`);

    updateUserProcess(chatId, { action: 'txt2vcf_sending_output' });

    const failedFiles = await sendFilesSequentially(
      chatId,
      outputPaths.map((filePath, index) => {
        const suffix = result.fileCount > 1 ? ` (${index + 1}/${result.fileCount})` : '';
        const contactsInFile = Math.ceil(result.count / result.fileCount);
        return {
          filePath,
          caption: `ℹ️ Berisi sekitar ${contactsInFile} kontak${suffix}`
        };
      })
    );

    if (failedFiles.length > 0) {
      await bot.sendMessage(
        chatId,
        `⚠️ Konversi sudah selesai dan file sudah tersimpan, tetapi ada ${failedFiles.length} file yang tetap gagal dikirim setelah ${SEND_FILE_MAX_RETRIES}x percobaan:

` +
        failedFiles.map(item => `- ${path.basename(item.filePath)}: ${item.error}`).join('\n') +
        '\n\nGunakan /getfile nama_file untuk mengambil ulang file yang gagal, tanpa mengulang convert dari awal.'
      );
    }

  } catch (error) {
    if (error.code === 'ENOENT') {
      bot.sendMessage(chatId, `❌ File ${txtFileName}.txt tidak ditemukan.\n\nGunakan /txt2vcf untuk melihat daftar file yang tersedia.`);
    } else {
      console.error('Error converting to vcf:', error);
      bot.sendMessage(chatId, '❌ Gagal mengkonversi file: ' + error.message);
    }
  } finally {
    finishUserProcess(chatId);
  }
}

// Fungsi untuk mengirim file ke user dengan retry 3x.
// Kalau gagal setelah retry, proses utama tidak diulang dari awal.
async function sendFile(chatId, filePath, caption = '') {
  let lastError;

  for (let attempt = 1; attempt <= SEND_FILE_MAX_RETRIES; attempt++) {
    try {
      await bot.sendDocument(chatId, fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        caption,
        contentType: path.extname(filePath).toLowerCase() === '.vcf' ? 'text/vcard' : 'text/plain'
      });
      return { ok: true, attempts: attempt };
    } catch (error) {
      lastError = error;
      console.error(`Error sending file ${path.basename(filePath)} attempt ${attempt}/${SEND_FILE_MAX_RETRIES}:`, error.message);

      if (attempt < SEND_FILE_MAX_RETRIES) {
        await sleep(SEND_FILE_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Gagal mengirim file setelah ${SEND_FILE_MAX_RETRIES}x percobaan: ${lastError?.message || 'Unknown error'}`);
}

async function sendFilesSequentially(chatId, files) {
  const failedFiles = [];

  for (let i = 0; i < files.length; i++) {
    const item = typeof files[i] === 'string' ? { filePath: files[i], caption: '' } : files[i];

    try {
      await sendFile(chatId, item.filePath, item.caption || '');
    } catch (error) {
      failedFiles.push({
        filePath: item.filePath,
        error: error.message
      });
    }

    if (i < files.length - 1) {
      await sleep(SEND_FILE_DELAY_BETWEEN_FILES_MS);
    }
  }

  return failedFiles;
}

// Command /merge2vcf - merge multiple VCF files with custom name
bot.onText(/\/mergevcf(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  
  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    await bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini!');
    return;
  }


  try {
    // Parse custom name from command
    const customName = match[1] ? sanitize(match[1]) : 'merged';
    const outputFileName = `${customName}.vcf`;

    if (!(await startUserProcess(chatId, 'merge VCF', {
      action: 'merge_choose_method',
      outputName: outputFileName,
      selectedFiles: []
    }))) return;

    // Ask user to choose method
    bot.sendMessage(chatId, 
      '📱 Pilih metode untuk menggabungkan VCF:\n\n' +
      '1. Pilih dari file yang sudah ada\n' +
      '2. Upload file VCF baru',
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "1. File yang ada", callback_data: "merge_select_numbers" },
              { text: "2. Upload baru", callback_data: "merge_upload" }
            ]
          ]
        }
      }
    );

  } catch (error) {
    console.error('Error in merge command:', error);
    bot.sendMessage(chatId, '❌ Terjadi kesalahan: ' + error.message);
    finishUserProcess(chatId);
  }
});

// Helper function to show file selection message
async function showFileSelectionMessage(chatId, files) {
  const state = userManager.getUserState(chatId);
  if (!state) return;

  // Show numbered list of files
  const message = '📋 Daftar File VCF:\n\n' +
    files.map((file, index) => `${index + 1}. ${file}`).join('\n') +
    '\n\n💡 Kirim nomor file yang ingin digabungkan (minimal 2)\n' +
    'Contoh: 1,3,4 atau 1 2 4';

  const sent = await bot.sendMessage(chatId, message);
  
  // Save state with file list
  userManager.setUserState(chatId, {
    ...state,
    action: 'merge_select_numbers',
    messageId: sent.message_id,
    availableFiles: files
  });
}

// Handle number selection for merging
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const state = userManager.getUserState(chatId);
  
  if (!state) return;
  
  const text = msg.text.trim().toLowerCase();
  
  // Handle confirmation state
  if (state.action === 'merge_confirm') {
    if (text === 'ok') {
      await bot.sendMessage(chatId, '⏳ Sedang menggabungkan file...');
      await mergeSelectedFiles(chatId, state.selectedFiles, state.outputName);
    } else if (text === 'batal') {
      finishUserProcess(chatId);
      await bot.sendMessage(chatId, '❌ Penggabungan file dibatalkan');
    }
    return;
  }
  
  // Handle number selection state
  if (state.action !== 'merge_select_numbers') return;
  
  if (text === '/cancel') {
    finishUserProcess(chatId);
    await bot.sendMessage(chatId, '❌ Penggabungan file dibatalkan');
    return;
  }
  
  try {
    // Parse numbers from input (supports both comma and space separation)
    const numbers = text.split(/[,\s]+/)
      .map(n => parseInt(n.trim()))
      .filter(n => !isNaN(n));
    
    // Check for duplicates
    const uniqueNumbers = [...new Set(numbers)];
    if (uniqueNumbers.length !== numbers.length) {
      await bot.sendMessage(chatId, '❌ Jangan pilih nomor yang sama berulang kali');
      return;
    }
    
    // Check max files limit
    const MAX_FILES = 5;
    if (numbers.length > MAX_FILES) {
      await bot.sendMessage(chatId, `❌ Maksimal ${MAX_FILES} file yang dapat digabungkan sekaligus`);
      return;
    }
    
    // Validate numbers
    const invalidNumbers = numbers.filter(n => n < 1 || n > state.availableFiles.length);
    if (invalidNumbers.length > 0) {
      await bot.sendMessage(chatId, 
        `❌ Nomor tidak valid: ${invalidNumbers.join(', ')}\n` +
        `Pilih nomor 1-${state.availableFiles.length}`);
      return;
    }
    
    // Get selected files
    const selectedFiles = numbers.map(n => state.availableFiles[n - 1]);
    
    if (selectedFiles.length < 2) {
      await bot.sendMessage(chatId, '❌ Pilih minimal 2 file untuk digabungkan');
      return;
    }
    
    // Show confirmation
    const confirm = `✅ File yang akan digabungkan:\n\n${selectedFiles.map(f => `• ${f}`).join('\n')}`;
    await bot.sendMessage(chatId, confirm, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Lanjutkan', callback_data: 'merge_confirm' },
            { text: '❌ Batal', callback_data: 'merge_cancel' }
          ]
        ]
      }
    });
    
    // Update state for confirmation
    userManager.setUserState(chatId, {
      ...state,
      action: 'merge_confirm',
      selectedFiles
    });
    
  } catch (error) {
    console.error('Error processing number selection:', error);
    await bot.sendMessage(chatId, '❌ Format tidak valid. Contoh: 1,3,4 atau 1 2 4');
  }
});

// Helper function to merge selected files
async function mergeSelectedFiles(chatId, files, outputName) {
  try {
    updateUserProcess(chatId, { action: 'merge_processing' });
    const userFolder = getUserFolder(chatId);
    
    // Get full paths of all files
    const filePaths = files.map(file => path.join(userFolder, file));
    
    // Merge files and get stats
    const result = await vcfConverter.mergeVcfFiles(filePaths, outputName);
    
    // Save merged file setelah cek storage
    const outputPath = path.join(userFolder, outputName);
    const storage = await getUserStorageInfo(userFolder);
    const limits = userManager.getStorageLimits(chatId);
    const outputExists = await fileExists(outputPath);
    const oldSize = outputExists ? (await fsPromises.stat(outputPath)).size : 0;
    const outputSize = Buffer.byteLength(result.content, 'utf8');

    if (!outputExists && storage.fileCount >= limits.MAX_FILES_PER_USER) {
      throw new Error('Batas maksimal jumlah file tercapai. Hapus file lama dulu dengan /deletefile atau /clean.');
    }

    if (outputSize > limits.MAX_FILE_SIZE) {
      throw new Error(`Ukuran file hasil merge terlalu besar. Maksimal ${formatBytes(limits.MAX_FILE_SIZE)}, hasil ${formatBytes(outputSize)}.`);
    }

    if (storage.totalSize - oldSize + outputSize > limits.MAX_TOTAL_SIZE) {
      throw new Error('Total storage akan melewati batas setelah merge. Hapus file lama dulu dengan /deletefile atau /clean.');
    }

    await fsPromises.writeFile(outputPath, result.content);
    
    // Format country stats
    const countryStats = Object.entries(result.stats.countries)
      .map(([country, count]) => `${country}: ${count} kontak`)
      .join('\n');
    
    // Send success message and merged file
    const message = `✅ File VCF berhasil digabungkan!\n\n` +
      `📄 File yang digabungkan:\n${files.map(f => `- ${f}`).join('\n')}\n\n` +
      `📊 Statistik:\n` +
      `Total kontak: ${result.stats.totalContacts}\n\n` +
      `📱 Kontak per negara:\n${countryStats}\n\n` +
      `📄 Hasil: ${outputName}`;
    
    await bot.sendMessage(chatId, message);
    try {
      await sendFile(chatId, outputPath, `📁 File VCF hasil penggabungan`);
    } catch (sendError) {
      console.error('Error sending merged VCF file:', sendError);
      await bot.sendMessage(
        chatId,
        `⚠️ File merge ${outputName} sudah berhasil dibuat dan tersimpan, tetapi gagal dikirim setelah ${SEND_FILE_MAX_RETRIES}x percobaan. Gunakan /getfile ${path.parse(outputName).name} untuk mengambil ulang.`
      );
    }
    finishUserProcess(chatId);
    
  } catch (error) {
    console.error('Error merging files:', error);
    bot.sendMessage(chatId, '❌ Gagal menggabungkan file: ' + error.message);
    finishUserProcess(chatId);
  }
}

// Command /checklimit - cek batasan storage user
bot.onText(/\/checklimit(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek apakah pengirim adalah owner
  if (!isOwner(msg)) {
    await bot.sendMessage(chatId, '⛔ Maaf, hanya owner yang bisa menggunakan command ini\\.', {
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  const targetId = match[1];

  if (!targetId) {
    await bot.sendMessage(chatId, 'ℹ️ Format: `/checklimit <chat_id>`', {
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  try {
    // Pastikan user target terdaftar
    if (!userManager.hasUser(targetId)) {
      await bot.sendMessage(chatId, `⚠️ User dengan ID ${escapeMarkdown(targetId)} tidak terdaftar\\.`, {
        parse_mode: 'MarkdownV2'
    });
    return;
  }

  // Ambil info batasan storage
  const limits = userManager.getStorageLimits(targetId);

  // Ambil info penggunaan storage
  const userFolder = path.join(__dirname, 'userfiles', targetId);
  const storage = await getUserStorageInfo(userFolder);

  // Format pesan
  const message = [
    '*Info Batasan Storage User*\\n',
    `User ID: \`${escapeMarkdown(targetId)}\`\\n`,
    '*Batasan:*',
    `• Files: ${escapeMarkdown(limits.MAX_FILES_PER_USER.toString())} file`,
    `• Size/file: ${escapeMarkdown(formatSizeMB(limits.MAX_FILE_SIZE))} MB`,
    `• Total size: ${escapeMarkdown(formatSizeMB(limits.MAX_TOTAL_SIZE))} MB\\n`,
    '*Penggunaan:*',
    `• Files: ${escapeMarkdown(storage.fileCount.toString())}/${escapeMarkdown(limits.MAX_FILES_PER_USER.toString())}`,
    `• Total size: ${escapeMarkdown(formatBytes(storage.totalSize))}/${escapeMarkdown(formatBytes(limits.MAX_TOTAL_SIZE))}`,
    `• Persentase: ${escapeMarkdown(Math.round((storage.totalSize / limits.MAX_TOTAL_SIZE) * 100).toString())}%`
  ].join('\n');

  await bot.sendMessage(chatId, message, {
    parse_mode: 'MarkdownV2'
  });
} catch (error) {
  await bot.sendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`, {
    parse_mode: 'MarkdownV2'
  });
}
});

// Command /clean - membersihkan storage
bot.onText(/\/clean(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const mode = match?.[1]?.toLowerCase();

  if (await rejectIfBusy(chatId, mode ? 'pembersihan storage' : 'menu clean')) return;

  const userFolder = getUserFolder(chatId);

  try {
    await fsPromises.mkdir(userFolder, { recursive: true });

    // Baca daftar file
    const files = await fsPromises.readdir(userFolder);
    const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
    const vcfFiles = files.filter(file => file.toLowerCase().endsWith('.vcf'));

    if (txtFiles.length === 0 && vcfFiles.length === 0) {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada file yang perlu dibersihkan.');
      return;
    }

    if (!mode) {
      // Tampilkan menu opsi pembersihan
      const message = `🧹 Pilih mode pembersihan:\n\n` +
        `1. /clean vcf - Hapus semua file VCF\n` +
        `2. /clean txt - Hapus semua file TXT\n` +
        `3. /clean all - Hapus semua file\n` +
        `4. /clean old - Hapus file lebih dari 7 hari\n\n` +
        `ℹ️ Total file:\n` +
        `• TXT: ${txtFiles.length} file\n` +
        `• VCF: ${vcfFiles.length} file`;

      bot.sendMessage(chatId, message);
      return;
    }

    if (!(await startUserProcess(chatId, 'pembersihan storage', { action: 'clean_prepare', mode }))) return;

    let filesToDelete = [];

    switch (mode) {
      case 'vcf':
        filesToDelete = vcfFiles;
        break;
      case 'txt':
        filesToDelete = txtFiles;
        break;
      case 'all':
        filesToDelete = [...txtFiles, ...vcfFiles];
        break;
      case 'old': {
        const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
        for (const file of files) {
          if (!file.toLowerCase().endsWith('.txt') && !file.toLowerCase().endsWith('.vcf')) continue;
          const stats = await fsPromises.stat(path.join(userFolder, file));
          if (stats.mtimeMs < sevenDaysAgo) filesToDelete.push(file);
        }
        break;
      }
      default:
        bot.sendMessage(chatId, '❌ Mode pembersihan tidak valid. Gunakan /clean untuk melihat opsi yang tersedia.');
        finishUserProcess(chatId);
        return;
    }

    if (filesToDelete.length === 0) {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada file yang perlu dibersihkan untuk mode ini.');
      finishUserProcess(chatId);
      return;
    }

    // Konfirmasi penghapusan
    let totalSize = 0;
    const details = [];
    for (const [i, file] of filesToDelete.entries()) {
      const stats = await fsPromises.stat(path.join(userFolder, file));
      totalSize += stats.size;
      if (i < 20) details.push(`${i + 1}. ${file} (${formatBytes(stats.size)})`);
    }

    const moreFiles = filesToDelete.length > 20
      ? `\n...dan ${filesToDelete.length - 20} file lainnya`
      : '';

    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

    updateUserProcess(chatId, {
      action: 'clean_confirm',
      cleanToken: token,
      filesToDelete,
      totalSize,
      userFolder,
      mode
    });

    await bot.sendMessage(
      chatId,
      `⚠️ Anda akan menghapus ${filesToDelete.length} file.\n\n` +
      `File yang akan dihapus:\n${details.join('\n')}${moreFiles}\n\n` +
      `Total ukuran: ${formatBytes(totalSize)}\n\n` +
      `Klik YA untuk menghapus atau TIDAK untuk membatalkan.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: 'YA', callback_data: `clean_yes_${token}` },
            { text: 'TIDAK', callback_data: `clean_no_${token}` }
          ]]
        }
      }
    );
  } catch (error) {
    console.error('Error cleaning storage:', error);
    bot.sendMessage(chatId, '❌ Gagal membersihkan storage: ' + error.message);
    finishUserProcess(chatId);
  }
});

// Callback khusus /clean. Tidak memakai bot.once agar aman saat banyak user klik bersamaan.
bot.on('callback_query', async (query) => {
  if (!query.data?.startsWith('clean_')) return;

  const chatId = query.message.chat.id;
  const state = userManager.getUserState(chatId);

  try {
    if (!state || state.action !== 'clean_confirm' || !state.processLocked) {
      await bot.answerCallbackQuery(query.id, { text: 'Konfirmasi clean sudah tidak aktif.' }).catch(() => {});
      return;
    }

    const expectedYes = `clean_yes_${state.cleanToken}`;
    const expectedNo = `clean_no_${state.cleanToken}`;

    if (![expectedYes, expectedNo].includes(query.data)) {
      await bot.answerCallbackQuery(query.id, { text: 'Tombol konfirmasi sudah kedaluwarsa.' }).catch(() => {});
      return;
    }

    await bot.answerCallbackQuery(query.id).catch(() => {});

    if (query.data === expectedNo) {
      finishUserProcess(chatId);
      await bot.editMessageText('❌ Pembersihan dibatalkan.', {
        chat_id: chatId,
        message_id: query.message.message_id
      }).catch(() => bot.sendMessage(chatId, '❌ Pembersihan dibatalkan.'));
      return;
    }

    updateUserProcess(chatId, { action: 'clean_deleting' });

    let deletedCount = 0;
    for (const file of state.filesToDelete) {
      try {
        await fsPromises.unlink(path.join(state.userFolder, file));
        deletedCount++;
      } catch (err) {
        console.error(`Failed to delete ${file}:`, err.message);
      }
    }

    finishUserProcess(chatId);

    const message = `✅ Pembersihan selesai!\n\n` +
      `📊 Ringkasan:\n` +
      `• File dihapus: ${deletedCount}/${state.filesToDelete.length} file\n` +
      `• Ukuran dibebaskan: ${formatBytes(state.totalSize)}\n\n` +
      `Gunakan /storage untuk melihat penggunaan storage terbaru.`;

    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: query.message.message_id
    }).catch(() => bot.sendMessage(chatId, message));
  } catch (error) {
    console.error('Error handling clean callback:', error);
    finishUserProcess(chatId);
    await bot.sendMessage(chatId, '❌ Gagal membersihkan storage: ' + error.message);
  }
});

// Command /help - panduan penggunaan bot
bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;

  const helpMessage =
    `*Panduan Penggunaan Bot*

1️⃣ *Persiapan File TXT*
• Buat file txt berisi daftar nomor
• Format: 0812xxx, 628xxx, +62812xxx
• Satu nomor per baris
• Minimal 10 digit

2️⃣ *Langkah Konversi*
1. Kirim file txt ke bot
2. Ketik: /txt2vcf [nama_file]
3. Ikuti instruksi bot
4. Download file VCF
5. Import ke smartphone

3️⃣ *Perintah Penting*
• /myfiles - lihat daftar file
• /getfile [nama] - ambil file
• /deletefile [nama] - hapus file
• /clean - bersihkan storage
• /storage - cek penggunaan storage

4️⃣ *Format Nomor Valid*
✅ Benar:
0812xxxxxxxx
628xxxxxxxxx
+62 812 xxxx

❌ Salah:
812xxxxxxxx (tanpa 0)
62812xxxxx (kurang digit)
+62 812 xxxx (ada spasi)

5️⃣ *Tips*
• Cek format nomor sebelum konversi
• Backup file penting
• Hapus file tidak terpakai
• Gunakan split file untuk file besar

Ketik perintah tanpa tanda [ ]
Contoh: /txt2vcf contacts`;

  await bot.sendMessage(chatId, helpMessage, {
    parse_mode: 'Markdown',
    disable_web_page_preview: true
  });
});

// Command /setlimit - atur batasan storage user
bot.onText(/\/setlimit(?:\s+(\d+))(?:\s+(-|reset|\d+))?(?:\s+(-|\d+))?(?:\s+(-|\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek apakah pengirim adalah owner
  if (!isOwner(msg)) {
    await bot.sendMessage(chatId, '⛔ Maaf, hanya owner yang bisa menggunakan command ini\\.', {
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  // Parse parameters
  const [, targetId, filesStr, fileSizeStr, totalSizeStr] = match;

  // Jika hanya chat_id, tampilkan bantuan
  if (!filesStr && !fileSizeStr && !totalSizeStr) {
    const helpMessage =
      '*Pengaturan Batasan Storage*\n\n' +
      'Format: `/setlimit <chat_id> <files> <size_mb> <total_mb>`\n\n' +
      'Contoh:\n' +
      '• `/setlimit 123456789 50 5 100`\n' +
      '  Set limit: 50 file, 5MB/file, total 100MB\n' +
      '• `/setlimit 123456789 20 - -`\n' +
      '  Set jumlah file saja: 20 file\n' +
      '• `/setlimit 123456789 - 10 -`\n' +
      '  Set ukuran file saja: 10MB/file\n' +
      '• `/setlimit 123456789 reset`\n' +
      '  Reset ke default\n\n' +
      'Parameter:\n' +
      '• chat_id: ID user yang akan diatur\n' +
      '• files: Jumlah maksimal file \\(\\- = tidak diubah\\)\n' +
      '• size_mb: Ukuran maksimal per file \\(\\- = tidak diubah\\)\n' +
      '• total_mb: Total ukuran maksimal \\(\\- = tidak diubah\\)';

    await bot.sendMessage(chatId, helpMessage, {
      parse_mode: 'MarkdownV2',
      disable_web_page_preview: true
    });
    return;
  }

  try {
    // Pastikan user target terdaftar
    if (!userManager.hasUser(targetId)) {
      await bot.sendMessage(chatId, `⚠️ User dengan ID ${escapeMarkdown(targetId)} tidak terdaftar\\.`, {
        parse_mode: 'MarkdownV2'
      });
      return;
    }

    // Handle reset command
    if (filesStr === 'reset') {
      userManager.resetStorageLimits(targetId);
      const newLimits = userManager.getStorageLimits(targetId);
      const confirmMessage = [
        '✅ *Berhasil reset batasan storage ke default*\n',
        `User ID: \`${escapeMarkdown(targetId)}\``,
        'Limit default:',
        `• Files: ${escapeMarkdown(newLimits.MAX_FILES_PER_USER)} file`,
        `• Size/file: ${escapeMarkdown(formatSizeMB(newLimits.MAX_FILE_SIZE))} MB`,
        `• Total size: ${escapeMarkdown(formatSizeMB(newLimits.MAX_TOTAL_SIZE))} MB`
      ].join('\n');

      await bot.sendMessage(chatId, confirmMessage, {
        parse_mode: 'MarkdownV2'
      });
      return;
    }

    // Parse parameters, keeping current values if '-' is specified
    const files = filesStr === '-' ? null : parseInt(filesStr);
    const fileSize = fileSizeStr === '-' ? null : parseInt(fileSizeStr);
    const totalSize = totalSizeStr === '-' ? null : parseInt(totalSizeStr);

    // Validasi nilai parameter
    if (files !== null) {
      if (files <= 0) throw new Error('Jumlah file harus lebih dari 0');
    }
    if (fileSize !== null) {
      if (fileSize <= 0) throw new Error('Ukuran file harus lebih dari 0 MB');
    }
    if (totalSize !== null) {
      if (totalSize <= 0) throw new Error('Total ukuran harus lebih dari 0 MB');
    }

    // Check file size vs total size
    const effectiveFileSize = fileSize || Math.floor(userManager.getStorageLimits(targetId).MAX_FILE_SIZE / (1024 * 1024));
    const effectiveTotalSize = totalSize || Math.floor(userManager.getStorageLimits(targetId).MAX_TOTAL_SIZE / (1024 * 1024));
    if (effectiveFileSize > effectiveTotalSize) {
      throw new Error('Ukuran per file tidak boleh lebih besar dari total ukuran');
    }

    // Set limit storage untuk user
    const newLimits = await userManager.setStorageLimits(targetId, {
      files,
      fileSize,
      totalSize
    });

    // Format pesan konfirmasi
    const confirmMessage = [
      '✅ *Berhasil mengatur batasan storage*\n',
      `User ID: \`${escapeMarkdown(targetId)}\``,
      'Limit baru:',
      `• Files: ${escapeMarkdown(newLimits.maxFiles)} file`,
      `• Size/file: ${escapeMarkdown(formatSizeMB(newLimits.maxFileSize))} MB`,
      `• Total size: ${escapeMarkdown(formatSizeMB(newLimits.maxTotalSize))} MB`
    ].join('\n');

    await bot.sendMessage(chatId, confirmMessage, {
      parse_mode: 'MarkdownV2'
    });
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`, {
      parse_mode: 'MarkdownV2'
    });
  }
});

// Command /resetlimit - reset batasan storage ke default
bot.onText(/\/resetlimit(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek apakah pengirim adalah owner
  if (!isOwner(msg)) {
    await bot.sendMessage(chatId, '⛔ Maaf, hanya owner yang bisa menggunakan command ini.');
    return;
  }

  const targetId = match[1];

  if (!targetId) {
    await bot.sendMessage(chatId, 'ℹ️ Format: `/resetlimit <chat_id>`', {
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  try {
    await userManager.resetStorageLimits(targetId);
    const info = userManager.getUserStorageInfo(targetId);
    const message =
      '✅ *Berhasil reset limit storage*\n\n' +
      `User ID: \`${targetId}\`\n` +
      'Limit default:\n' +
      `• Files: ${info.maxFiles} file\n` +
      `• Size/file: ${info.maxFileSize} MB\n` +
      `• Total size: ${info.maxTotalSize} MB`;

    await bot.sendMessage(chatId, message, {
      parse_mode: 'MarkdownV2'
    });
  } catch (error) {
    await bot.sendMessage(chatId, `❌ Error: ${error.message}`, {
      parse_mode: 'MarkdownV2'
    });
  }
});

// Command /getlimits - tampilkan batasan storage semua user
bot.onText(/\/getlimits/, async (msg) => {
  const chatId = msg.chat.id;

  // Cek apakah pengirim adalah owner
  if (!isOwner(msg)) {
    await bot.sendMessage(chatId, '⛔ Maaf, hanya owner yang bisa menggunakan command ini\\.', {
      parse_mode: 'MarkdownV2'
    });
    return;
  }

  try {
    const users = userManager.getUsers();
    if (users.length === 0) {
      await bot.sendMessage(chatId, '❕ Belum ada user yang terdaftar\\.', {
        parse_mode: 'MarkdownV2'
    });
    return;
  }

  let message = '*Daftar Batasan Storage User*\n\n';

  for (const userId of users) {
    const limits = userManager.getStorageLimits(userId);
    message += `👤 User ID: \`${escapeMarkdown(userId)}\`\n`;
    message += `• Files: ${escapeMarkdown(limits.MAX_FILES_PER_USER)} file\n`;
    message += `• Size/file: ${escapeMarkdown(formatSizeMB(limits.MAX_FILE_SIZE))} MB\n`;
    message += `• Total size: ${escapeMarkdown(formatSizeMB(limits.MAX_TOTAL_SIZE))} MB\n\n`;
  }

  await bot.sendMessage(chatId, message, {
    parse_mode: 'MarkdownV2'
  });
} catch (error) {
  await bot.sendMessage(chatId, `❌ Error: ${escapeMarkdown(error.message)}`, {
    parse_mode: 'MarkdownV2'
  });
}
});

// Handle VCF file uploads for merging
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const userState = userManager.getUserState(chatId);
  
  if (!userState || userState.action !== 'merge_upload_files') return;
  
  const file = msg.document;
  if (!file.file_name.toLowerCase().endsWith('.vcf')) {
    bot.sendMessage(chatId, '❌ File harus berformat VCF');
    return;
  }

  try {
    const userFolder = getUserFolder(chatId);
    await fsPromises.mkdir(userFolder, { recursive: true });
    const fileName = sanitize(file.file_name);
    const filePath = path.join(userFolder, fileName);

    const storage = await getUserStorageInfo(userFolder);
    const limits = userManager.getStorageLimits(chatId);
    const alreadyExists = await fileExists(filePath);
    const oldSize = alreadyExists ? (await fsPromises.stat(filePath)).size : 0;

    if (!alreadyExists && storage.fileCount >= limits.MAX_FILES_PER_USER) {
      bot.sendMessage(chatId, '⚠️ Batas maksimal jumlah file tercapai. Hapus file lama dulu dengan /deletefile atau /clean.');
      return;
    }

    if (file.file_size > limits.MAX_FILE_SIZE) {
      bot.sendMessage(chatId, `⚠️ Ukuran file terlalu besar! Maksimal ${formatBytes(limits.MAX_FILE_SIZE)}, file ini ${formatBytes(file.file_size)}.`);
      return;
    }

    if (storage.totalSize - oldSize + file.file_size > limits.MAX_TOTAL_SIZE) {
      bot.sendMessage(chatId, '⚠️ Total storage akan melewati batas. Hapus file lama dulu dengan /deletefile atau /clean.');
      return;
    }

    await downloadTelegramFile(file.file_id, filePath);

    // Add file to selected files
    const selectedFiles = userState.selectedFiles || [];
    if (!selectedFiles.includes(fileName)) selectedFiles.push(fileName);
    
    // Update state with new file
    userManager.setUserState(chatId, {
      ...userState,
      selectedFiles
    });
    
    // Send confirmation and reminder
    const message = `✅ File "${fileName}" berhasil diupload!\n\n` +
      `📄 File terpilih (${selectedFiles.length}):\n${selectedFiles.map(f => `- ${f}`).join('\n')}\n\n` +
      `Upload file VCF lainnya atau kirim /done untuk menggabungkan`;
    
    await bot.sendMessage(chatId, message);
    
  } catch (error) {
    console.error('Error handling file upload:', error);
    bot.sendMessage(chatId, '❌ Gagal mengupload file: ' + error.message);
  }
});

// Handle /done command for finishing upload
bot.onText(/\/done/, async (msg) => {
  const chatId = msg.chat.id;
  const userState = userManager.getUserState(chatId);
  
  if (!userState || userState.action !== 'merge_upload_files') return;
  
  const selectedFiles = userState.selectedFiles || [];
  
  if (selectedFiles.length < 2) {
    bot.sendMessage(chatId, '❌ Anda harus upload minimal 2 file VCF untuk digabungkan');
    return;
  }
  
  // Merge the uploaded files
  await mergeSelectedFiles(chatId, selectedFiles, userState.outputName);
});

bot.on('callback_query', async (query) => {
  const handledMergeCallbacks = ['merge_select_numbers', 'merge_upload', 'merge_done', 'merge_cancel'];
  if (!handledMergeCallbacks.includes(query.data) && !query.data.startsWith('select_')) return;

  const chatId = query.message.chat.id;
  const userState = userManager.getUserState(chatId);

  // Biarkan handler konfirmasi merge memproses tombol Lanjutkan/Batal.
  if (userState?.action === 'merge_confirm') return;

  if (!userState) {
    await bot.answerCallbackQuery(query.id);
    return;
  }

  const userFolder = getUserFolder(chatId);

  try {
    if (query.data === 'merge_select_numbers') {
      // Create user directory if it doesn't exist
      try {
        await fsPromises.access(userFolder);
      } catch {
        await fsPromises.mkdir(userFolder, { recursive: true });
      }

      // Get list of VCF files
      const files = await fsPromises.readdir(userFolder);
      const vcfFiles = files.filter(file => file.toLowerCase().endsWith('.vcf'));

      if (vcfFiles.length === 0) {
        await bot.sendMessage(chatId, '❌ Tidak ada file VCF yang tersedia. Silakan upload file terlebih dahulu.');
        finishUserProcess(chatId);
        return;
      }

      // Update state for file selection
      userManager.setUserState(chatId, {
        ...userState,
        action: 'merge_select_files',
        availableFiles: vcfFiles,
        selectedFiles: []
      });

      // Show file selection message with checkboxes
      await showFileSelectionMessage(chatId, vcfFiles);

    } else if (query.data === 'merge_upload') {
      // Create user directory if it doesn't exist
      try {
        await fsPromises.access(userFolder);
      } catch {
        await fsPromises.mkdir(userFolder, { recursive: true });
      }

      userManager.setUserState(chatId, {
        ...userState,
        action: 'merge_upload_files',
        selectedFiles: []
      });
      
      await bot.sendMessage(chatId, 
        '📤 Silakan kirim file VCF yang ingin digabungkan.\n' +
        'Kirim /done jika sudah selesai mengirim semua file.'
      );
      
    } else if (query.data.startsWith('select_')) {
      const fileName = query.data.replace('select_', '');
      const state = userManager.getUserState(chatId);
      
      if (state && state.action === 'merge_select_files') {
        const selectedFiles = state.selectedFiles || [];
        const fileIndex = selectedFiles.indexOf(fileName);
        
        if (fileIndex === -1) {
          selectedFiles.push(fileName);
        } else {
          selectedFiles.splice(fileIndex, 1);
        }
        
        // Update state
        userManager.setUserState(chatId, {
          ...state,
          selectedFiles
        });
        
        // Update selection message
        await showFileSelectionMessage(chatId, state.availableFiles, selectedFiles);
      }
    } else if (query.data === 'merge_done') {
      const state = userManager.getUserState(chatId);
      
      if (state && state.selectedFiles.length >= 2) {
        await mergeSelectedFiles(chatId, state.selectedFiles, state.outputName);
      } else {
        await bot.sendMessage(chatId, '❌ Pilih minimal 2 file untuk digabungkan');
      }
    } else if (query.data === 'merge_cancel') {
      // Clear user state and send cancellation message
      finishUserProcess(chatId);
      await bot.editMessageText('❌ Penggabungan file dibatalkan', {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    }
  } catch (error) {
    console.error('Error handling callback query:', error);
    await bot.sendMessage(chatId, '❌ Terjadi kesalahan: ' + error.message);
  } finally {
    // Always answer callback query to remove loading state
    await bot.answerCallbackQuery(query.id);
  }
});

// Handle merge confirmation callbacks
bot.on('callback_query', async (query) => {
  if (!['merge_confirm', 'merge_cancel'].includes(query.data)) return;

  const chatId = query.message.chat.id;
  const userState = userManager.getUserState(chatId);

  if (!userState || userState.action !== 'merge_confirm') return;

  await bot.answerCallbackQuery(query.id);

  if (query.data === 'merge_confirm') {
    // Process the merge
    await mergeSelectedFiles(chatId, userState.selectedFiles, userState.outputName);
    // State sudah dibersihkan oleh mergeSelectedFiles().
  } else if (query.data === 'merge_cancel') {
    await bot.editMessageText('❌ Penggabungan file dibatalkan', {
      chat_id: chatId,
      message_id: query.message.message_id
    });
    finishUserProcess(chatId);
  }
});

// Command /createvcf - buat file vcf dari pesan
bot.onText(/\/createvcf(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses. Gunakan /start untuk mendaftar.');
    return;
  }

  // Cek format input
  const input = match[1];
  if (!input) {
    bot.sendMessage(chatId, 
      '📝 Format:\n' +
      '1. Multiple kontak (nama berbeda):\n' +
      '   /createvcf nama|nomor[; nama|nomor]...\n\n' +
      '2. Multiple kontak (nama sama):\n' +
      '   /createvcf nama >> nomor[; nomor]...\n\n' +
      'Contoh:\n' +
      '• Nama berbeda:\n' +
      '  /createvcf John|081234567890; Alice|+6281234567890\n\n' +
      '• Nama sama:\n' +
      '  /createvcf John >> 081234567890; +6281234567890; 628123456789\n' +
      '  ➡️ Akan menjadi: John, John 2, John 3\n\n' +
      'Catatan:\n' +
      '• Format 1: Gunakan | antara nama dan nomor\n' +
      '• Format 2: Gunakan >> antara nama dan daftar nomor\n' +
      '• Gunakan ; untuk memisahkan antar nomor\n' +
      '• Nomor minimal 10 digit\n' +
      '• Mendukung format: 08xx, 628xx, +62xx\n' +
      '• Nama yang sama akan otomatis diberi nomor urut'
    );
    return;
  }

  if (await rejectIfBusy(chatId, 'pembuatan VCF')) return;

  try {
    let rawContacts = [];

    // Cek format input (format biasa atau format nama sama)
    if (input.includes('>>')) {
      // Format nama sama: "nama >> nomor1; nomor2; nomor3"
      const [name, numbersList] = input.split('>>').map(s => s.trim());
      if (!name || !numbersList) {
        throw new Error('Format tidak valid. Gunakan: nama >> nomor1; nomor2; ...');
      }

      // Parse semua nomor
      const numbers = numbersList.split(';').map(n => n.trim());
      rawContacts = numbers.map(number => ({ name, number }));
    } else {
      // Format biasa: "nama1|nomor1; nama2|nomor2"
      rawContacts = input.split(';').map(contact => {
        const [name, number] = contact.trim().split('|').map(s => s.trim());
        if (!name || !number) {
          throw new Error('Format tidak valid. Gunakan: nama|nomor[; nama|nomor]...');
        }
        return { name, number };
      });
    }

    // Validate and clean phone numbers
    rawContacts = rawContacts.map(contact => {
      const cleanedNumber = vcfConverter.cleanPhoneNumber(contact.number);
      if (!cleanedNumber || cleanedNumber.length < 10) {
        throw new Error(`Nomor tidak valid untuk kontak "${contact.name}". Minimal 10 digit.`);
      }
      return { ...contact, number: cleanedNumber };
    });

    if (rawContacts.length === 0) {
      throw new Error('Minimal masukkan 1 kontak');
    }

    // Process duplicate names
    const nameCount = {};
    const contacts = rawContacts.map(contact => {
      const baseName = contact.name;
      nameCount[baseName] = (nameCount[baseName] || 0) + 1;
      
      return {
        ...contact,
        name: nameCount[baseName] === 1 ? baseName : `${baseName} ${nameCount[baseName]}`
      };
    });

    // Ask user for filename preference
    const defaultFilename = contacts.length === 1 ? 
      `${sanitize(contacts[0].name)}_${Date.now()}.vcf` :
      `contacts_${contacts.length}_${Date.now()}.vcf`;

    // Generate preview with numbered names
    const contactSummary = contacts.map((c, i) => {
      const isNumbered = c.name !== rawContacts[i].name;
      return `${i + 1}. ${c.name}${isNumbered ? ' 🔄' : ''} (${c.number})`;
    }).join('\n');

    if (!(await startUserProcess(chatId, 'pembuatan VCF', {
      action: 'create_vcf',
      data: {
        contacts,
        defaultFilename
      }
    }))) return;

    await bot.sendMessage(chatId,
      `📝 Kontak yang akan dibuat (${contacts.length}):\n\n${contactSummary}\n\n` +
      (contacts.some((c, i) => c.name !== rawContacts[i].name) ? 
        '🔄 Nama yang sama telah diberi nomor urut\n\n' : '') +
      `Pilih nama file:\n` +
      `• Default: ${defaultFilename}`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Gunakan nama default', callback_data: `vcf_default_multi` },
              { text: '✏️ Custom nama file', callback_data: `vcf_custom_multi` }
            ]
          ]
        }
      }
    );

  } catch (error) {
    console.error('Error creating VCF:', error);
    bot.sendMessage(chatId, '❌ ' + error.message);
    finishUserProcess(chatId);
  }
});

// Handle VCF filename selection
bot.on('callback_query', async (query) => {
  if (!['vcf_default_multi', 'vcf_custom_multi'].includes(query.data)) return;

  const chatId = query.message.chat.id;
  const userState = userManager.getUserState(chatId);

  if (!userState || userState.action !== 'create_vcf') return;

  await bot.answerCallbackQuery(query.id);

  if (query.data === 'vcf_default_multi') {
    // Use default filename
    await createAndSendMultiVcf(chatId, userState.data.contacts, userState.data.defaultFilename);
    finishUserProcess(chatId);
  } else if (query.data === 'vcf_custom_multi') {
    // Ask for custom filename
    await bot.sendMessage(chatId, 
      '✏️ Kirim nama file yang diinginkan (tanpa ekstensi .vcf)\n' +
      'Contoh: kontak_grup_a'
    );
    // Update state to wait for filename
    userManager.setUserState(chatId, {
      ...userState,
      action: 'create_vcf_filename'
    });
  }
});

// Handle custom filename input
bot.on('text', async (msg) => {
  const chatId = msg.chat.id;
  const userState = userManager.getUserState(chatId);

  if (!userState || userState.action !== 'create_vcf_filename') return;

  const customName = sanitize(msg.text.trim());
  if (!customName) {
    bot.sendMessage(chatId, '❌ Nama file tidak valid. Silakan coba lagi.');
    return;
  }

  await createAndSendMultiVcf(chatId, userState.data.contacts, `${customName}.vcf`);
  finishUserProcess(chatId);
});

// Helper function to create and send VCF file with multiple contacts
async function createAndSendMultiVcf(chatId, contacts, filename) {
  try {
    // Generate VCF content for all contacts
    const vcfContent = contacts.map(contact => 
      vcfConverter.vCardTemplate
        .replace(/{name}/g, contact.name)
        .replace(/{number}/g, contact.number)
    ).join('\n');

    // Create user folder if not exists
    const userFolder = getUserFolder(chatId);
    await fsPromises.mkdir(userFolder, { recursive: true });

    // Save VCF file setelah cek storage
    const filePath = path.join(userFolder, filename);
    const storage = await getUserStorageInfo(userFolder);
    const limits = userManager.getStorageLimits(chatId);
    const alreadyExists = await fileExists(filePath);
    const oldSize = alreadyExists ? (await fsPromises.stat(filePath)).size : 0;
    const outputSize = Buffer.byteLength(vcfContent, 'utf8');

    if (!alreadyExists && storage.fileCount >= limits.MAX_FILES_PER_USER) {
      throw new Error('Batas maksimal jumlah file tercapai. Hapus file lama dulu dengan /deletefile atau /clean.');
    }

    if (outputSize > limits.MAX_FILE_SIZE) {
      throw new Error(`Ukuran file VCF terlalu besar. Maksimal ${formatBytes(limits.MAX_FILE_SIZE)}, hasil ${formatBytes(outputSize)}.`);
    }

    if (storage.totalSize - oldSize + outputSize > limits.MAX_TOTAL_SIZE) {
      throw new Error('Total storage akan melewati batas. Hapus file lama dulu dengan /deletefile atau /clean.');
    }

    await fsPromises.writeFile(filePath, vcfContent);

    // Generate contact summary
    const summary = contacts.map((c, i) => `${i + 1}. ${c.name} (${c.number})`).join('\n');

    // Send file to user dengan retry 3x
    try {
      await sendFile(
        chatId,
        filePath,
        `✅ File VCF berhasil dibuat dengan ${contacts.length} kontak:

${summary}

File: ${filename}`
      );
    } catch (sendError) {
      console.error('Error sending created VCF file:', sendError);
      await bot.sendMessage(
        chatId,
        `⚠️ File ${filename} sudah dibuat dan tersimpan, tetapi gagal dikirim setelah ${SEND_FILE_MAX_RETRIES}x percobaan. Gunakan /getfile ${path.parse(filename).name} untuk mengambil ulang.`
      );
    }
  } catch (error) {
    console.error('Error creating VCF:', error);
    bot.sendMessage(chatId, '❌ Gagal membuat file: ' + error.message);
  }
}
