// Load environment variables
require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const UserManager = require('./users');
const fs = require('fs');
const fsPromises = fs.promises;
const FormData = require('form-data');
const path = require('path');
const sanitize = require('sanitize-filename');
const os = require('os');
const process = require('process');
const VcfConverter = require('./vcfConverter');

// Format bytes to human readable
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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
const isOwner = (msg) => msg.from.id.toString() === ownerId;

// Helper function to escape special characters for MarkdownV2
const escapeMarkdown = (text) => {
  return text.toString().replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
};

// Helper function to format size to MB
const formatSizeMB = (bytes) => {
  return (bytes / (1024 * 1024)).toFixed(1);
};

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
    // Buat folder jika belum ada
    await fsPromises.mkdir(userFolder, { recursive: true });

    // Baca isi folder
    const files = await fsPromises.readdir(userFolder);
    const txtFiles = files.filter(file => file.endsWith('.txt'));

    // Hitung total ukuran
    let totalSize = 0;
    for (const file of txtFiles) {
      const filePath = path.join(userFolder, file);
      const stats = await fsPromises.stat(filePath);
      totalSize += stats.size;
    }

    return {
      fileCount: txtFiles.length,
      totalSize
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

    // Kirim file ke user
    async function sendFile(chatId, filePath, caption) {
      return bot.sendDocument(chatId, fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType: path.extname(filePath).toLowerCase() === '.vcf' ? 'text/vcard' : 'text/plain',
        caption: caption,
        fileOptions: {
          contentType: 'application/octet-stream'
        }
      });
    }
    await sendFile(chatId, filePath, `📝 File txt Anda: ${fileName}.txt`);

  } catch (error) {
    console.error('Error creating file:', error);
    bot.sendMessage(chatId, '❌ Gagal membuat file: ' + error.message);
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

  const txtFileName = sanitize(match[1]);
  const userFolder = path.join(__dirname, 'userfiles', chatId.toString());
  const inputPath = path.join(userFolder, `${txtFileName}.txt`);

  try {
    // Cek apakah file txt ada
    await new Promise((resolve, reject) => {
      fs.access(inputPath, fs.constants.F_OK, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });


    bot.sendDocument(chatId, fs.createReadStream(inputPath), {
      filename: path.basename(inputPath),
      contentType: path.extname(inputPath).toLowerCase() === '.vcf' ? 'text/vcard' : 'text/plain',
      caption: '',
      fileOptions: {
        contentType: 'application/octet-stream'
      }
    });

  } catch (error) {
    if (error.code === 'ENOENT') {
      bot.sendMessage(chatId, `❌ File ${txtFileName}.txt tidak ditemukan.`);
    }
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

// Handle file upload
bot.on('document', async (msg) => {
  const chatId = msg.chat.id;
  const file = msg.document;

  // Cek akses user
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  // Cek tipe file
  if (!file.file_name.toLowerCase().endsWith('.txt')) {
    bot.sendMessage(chatId, '⚠️ Hanya file .txt yang diperbolehkan!');
    return;
  }

  try {
    const fileInfo = await bot.getFile(file.file_id);
    const fileName = sanitize(file.file_name);
    const userFolder = path.join(__dirname, 'userfiles', chatId.toString());
    const filePath = path.join(userFolder, fileName);

    // Cek apakah file sudah ada
    try {
      await fsPromises.access(filePath);
      // File exists, ask for confirmation
      const confirmMsg = await bot.sendMessage(
        chatId,
        `⚠️ File dengan nama "${fileName}" sudah ada!\n\nApakah Anda ingin:\n` +
        '1. Ganti nama file\n' +
        '2. Timpa file yang ada\n' +
        '3. Batalkan upload\n\n' +
        'Pilih dengan mengirim nomor (1-3)',
        {
          reply_markup: {
            force_reply: true,
            selective: true
          }
        }
      );

      const response = await new Promise(resolve => {
        bot.onReplyToMessage(chatId, confirmMsg.message_id, async (responseMsg) => {
          resolve(responseMsg.text);
        });
      });

      switch (response) {
        case '1': // Ganti nama
          const askNewName = await bot.sendMessage(
            chatId,
            '📝 Masukkan nama baru untuk file (tanpa .txt):',
            {
              reply_markup: {
                force_reply: true,
                selective: true
              }
            }
          );

          const newName = await new Promise(resolve => {
            bot.onReplyToMessage(chatId, askNewName.message_id, async (nameMsg) => {
              resolve(sanitize(nameMsg.text) + '.txt');
            });
          });

          filePath = path.join(userFolder, newName);
          break;

        case '2': // Timpa file
          // Lanjut dengan path yang sama
          break;

        case '3': // Batalkan
          bot.sendMessage(chatId, '❌ Upload dibatalkan.');
          return;

        default:
          bot.sendMessage(chatId, '❌ Pilihan tidak valid. Upload dibatalkan.');
          return;
      }
    } catch (err) {
      // File doesn't exist, continue with upload
    }

    // Cek batasan penyimpanan
    const storage = await getUserStorageInfo(userFolder);
    const limits = userManager.getStorageLimits(chatId);

    // Cek jumlah file
    if (storage.fileCount >= limits.MAX_FILES_PER_USER) {
      bot.sendMessage(chatId, '⚠️ Batas maksimal jumlah file tercapai!\n\nHapus beberapa file lama menggunakan /deletefile untuk mengunggah file baru.');
      return;
    }

    // Cek ukuran file
    if (file.file_size > limits.MAX_FILE_SIZE) {
      bot.sendMessage(chatId, `⚠️ Ukuran file terlalu besar!\n\nMaksimal: ${formatBytes(limits.MAX_FILE_SIZE)}\nUkuran file: ${formatBytes(file.file_size)}`);
      return;
    }

    // Cek total ukuran
    if (storage.totalSize + file.file_size > limits.MAX_TOTAL_SIZE) {
      bot.sendMessage(chatId, '⚠️ Total ukuran penyimpanan akan melebihi batas!\n\nHapus beberapa file lama menggunakan /deletefile untuk mengunggah file baru.');
      return;
    }

    // Buat folder jika belum ada
    await fsPromises.mkdir(userFolder, { recursive: true });

    // Download dan simpan file
    const fileStream = await bot.getFileStream(file.file_id);
    const writeStream = fs.createWriteStream(filePath);

    await new Promise((resolve, reject) => {
      fileStream.pipe(writeStream)
        .on('finish', resolve)
        .on('error', reject);
    });

    const finalFileName = path.basename(filePath);
    bot.sendMessage(chatId, `✅ File berhasil diunggah!\n\n📝 Nama: ${finalFileName}\n💾 Lokasi: /userfiles/${chatId}/${finalFileName}\n\nGunakan command /txt2vcf ${path.parse(finalFileName).name} untuk mengkonversi ke VCF`);

  } catch (error) {
    console.error('Error uploading file:', error);
    bot.sendMessage(chatId, '❌ Gagal mengunggah file: ' + error.message);
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
  if (!userManager.hasUser(chatId) && !isOwner(msg)) {
    bot.sendMessage(chatId, '⛔ Maaf, Anda tidak memiliki akses ke bot ini.');
    return;
  }

  const userFolder = path.join(__dirname, 'userfiles', chatId.toString());

  // Jika tidak ada parameter, itu adalah mode pilih file
  if (!match[1]) {
    try {
      // List semua file txt di folder user
      const files = await fsPromises.readdir(userFolder);
      const txtFiles = files.filter(f => f.toLowerCase().endsWith('.txt'));

      if (txtFiles.length === 0) {
        bot.sendMessage(chatId, '❌ Tidak ada file .txt yang tersedia.\n\nSilakan upload file .txt terlebih dahulu.');
        return;
      }

      // Tampilkan daftar file yang tersedia
      const message = '📝 Pilih file yang ingin dikonversi:\n\n' +
        txtFiles.map((file, i) => `${i + 1}. ${file}`).join('\n') + '\n\n' +
        'Ketik nomor file atau kirim nama file (tanpa .txt)';

      const selectMsg = await bot.sendMessage(chatId, message, {
        reply_markup: {
          force_reply: true,
          selective: true
        }
      });

      // Tunggu respon user
      const response = await new Promise(resolve => {
        bot.onReplyToMessage(chatId, selectMsg.message_id, async (fileMsg) => {
          resolve(fileMsg.text);
        });
      });

      // Cek apakah input adalah nomor
      const fileIndex = parseInt(response) - 1;
      let txtFileName;

      if (!isNaN(fileIndex) && fileIndex >= 0 && fileIndex < txtFiles.length) {
        // User memilih dengan nomor
        txtFileName = path.parse(txtFiles[fileIndex]).name;
      } else {
        // User mengetik nama file
        txtFileName = sanitize(response);
      }

      // Lanjut ke proses konversi
      await processConversion(chatId, txtFileName, userFolder);

    } catch (error) {
      console.error('Error listing files:', error);
      bot.sendMessage(chatId, '❌ Gagal membaca daftar file: ' + error.message);
    }
    return;
  }

  // Jika ada parameter, itu adalah mode konversi file
  const txtFileName = sanitize(match[1]);
  await processConversion(chatId, txtFileName, userFolder);
});

// Fungsi untuk memproses konversi txt ke vcf
async function processConversion(chatId, txtFileName, userFolder) {
  const inputPath = path.join(userFolder, `${txtFileName}.txt`);

  try {
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
        '1. Format lokal: 08xx, 628xx\n' +
        '2. Format internasional: +1xxx (US), +44xxx (UK), dll\n' +
        '3. Minimal 10 digit (termasuk kode negara)');
      return;
    }

    // Tanya nama kontak
    const askName = await bot.sendMessage(chatId,
      '📝 Masukkan nama untuk kontak ini:\n' +
      'Contoh: Teman SMA, Rekan Kerja, dll\n\n' +
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

    // Tanya nomor urut awal
    const askStartNumber = await bot.sendMessage(chatId,
      '🔢 Masukkan nomor urut awal:\n' +
      'Contoh: 1 (untuk mulai dari 1)\n\n' +
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

    // Tanya jumlah file
    const totalContacts = cleanContent.split('\n').length;
    const recommendedSplit = totalContacts > 1000 ? Math.ceil(totalContacts / 1000) : 0;

    const askSplitCount = await bot.sendMessage(chatId,
      '📂 Ingin memecah kontak menjadi berapa file?\n\n' +
      `ℹ️ Total kontak: ${totalContacts}\n` +
      (recommendedSplit > 0 ? `💡 Rekomendasi: ${recommendedSplit} file\n` : '') +
      '\nKetik 0 untuk tidak memecah (semua kontak dalam 1 file)\n' +
      'Ketik 2-10 untuk membagi kontak ke beberapa file', {
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

    // Konversi ke vcf dengan nama dan nomor urut yang diberikan
    const result = await vcfConverter.convertTxtToVcf(inputPath, {
      name: nameResponse,
      startNumber: startNumberResponse,
      splitCount: splitCountResponse
    });

    // Simpan file-file vcf
    const outputPaths = [];
    for (let i = 0; i < result.contents.length; i++) {
      const suffix = result.fileCount > 1 ? `_${i + 1}` : '';
      const outputPath = path.join(userFolder, `${vcfFileName}${suffix}.vcf`);
      await fsPromises.writeFile(outputPath, result.contents[i], 'utf8');
      outputPaths.push(outputPath);
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
      `📝 Input: ${txtFileName}.txt\n` +
      `💾 Output: ${result.fileCount} file VCF\n` +
      `💼 Nama: ${nameResponse}\n` +
      `🔢 Mulai dari: ${startNumberResponse}\n` +
      `📂 Jumlah file: ${result.fileCount}\n\n` +
      `🌍 Ditemukan ${totalCountries} negara:\n${countrySummary}`);

    // Kirim semua file vcf
    for (let i = 0; i < outputPaths.length; i++) {
      try {
        const suffix = result.fileCount > 1 ? ` (${i + 1}/${result.fileCount})` : '';
        const contactsInFile = Math.ceil(result.count / result.fileCount);
        async function sendFile(chatId, filePath, caption) {
          return bot.sendDocument(chatId, fs.createReadStream(filePath), {
            filename: path.basename(filePath),
            contentType: path.extname(filePath).toLowerCase() === '.vcf' ? 'text/vcard' : 'text/plain',
            caption: caption,
            fileOptions: {
              contentType: 'application/octet-stream'
            }
          });
        }
        await sendFile(chatId, outputPaths[i],
          `${suffix}\n ℹ️ Berisi ${contactsInFile} kontak\n\n`
        );
      } catch (error) {
        console.error(`Error sending file ${i + 1}:`, error);
        bot.sendMessage(chatId, `❌ Gagal mengirim file ${i + 1}: ${error.message}`);
      }
    }

  } catch (error) {
    if (error.code === 'ENOENT') {
      bot.sendMessage(chatId, `❌ File ${txtFileName}.txt tidak ditemukan.\n\nGunakan /txt2vcf untuk melihat daftar file yang tersedia.`);
    } else {
      console.error('Error converting to vcf:', error);
      bot.sendMessage(chatId, '❌ Gagal mengkonversi file: ' + error.message);
    }
  }
}

// Command /checklimit - cek batasan storage user
bot.onText(/\/checklimit(?:\s+(\d+))?/, async (msg, match) => {
  const chatId = msg.chat.id;

  // Cek apakah pengirim adalah owner
  if (!isOwner(msg)) {
    await bot.sendMessage(chatId, '⛔ Maaf, command ini hanya untuk owner\\.', {
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

  const userFolder = path.join(__dirname, 'userfiles', chatId.toString());

  try {
    // Baca daftar file
    const files = await fsPromises.readdir(userFolder);
    const txtFiles = files.filter(file => file.toLowerCase().endsWith('.txt'));
    const vcfFiles = files.filter(file => file.toLowerCase().endsWith('.vcf'));

    if (txtFiles.length === 0 && vcfFiles.length === 0) {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada file yang perlu dibersihkan.');
      return;
    }

    // Jika ada parameter, itu adalah mode pembersihan
    const mode = match?.[1]?.toLowerCase();

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

    let filesToDelete = [];
    let successCount = 0;
    let totalSize = 0;

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
      case 'old':
        const now = Date.now();
        const sevenDaysAgo = now - (7 * 24 * 60 * 60 * 1000);

        filesToDelete = files.filter(file => {
          if (!file.toLowerCase().endsWith('.txt') && !file.toLowerCase().endsWith('.vcf')) {
            return false;
          }
          const stats = fs.statSync(path.join(userFolder, file));
          return stats.mtimeMs < sevenDaysAgo;
        });
        break;
      default:
        bot.sendMessage(chatId, '❌ Mode pembersihan tidak valid. Gunakan /clean untuk melihat opsi yang tersedia.');
        return;
    }

    if (filesToDelete.length === 0) {
      bot.sendMessage(chatId, 'ℹ️ Tidak ada file yang perlu dibersihkan untuk mode ini.');
      return;
    }

    // Konfirmasi penghapusan
    const confirmMsg = await bot.sendMessage(
      chatId,
      `⚠️ Anda akan menghapus ${filesToDelete.length} file.\n\n` +
      `File yang akan dihapus:\n` +
      filesToDelete.map((file, i) => {
        const stats = fs.statSync(path.join(userFolder, file));
        totalSize += stats.size;
        const size = formatBytes(stats.size);
        return `${i + 1}. ${file} (${size})`;
      }).join('\n') + '\n\n' +
      `Total ukuran: ${formatBytes(totalSize)}\n\n` +
      `Ketik 'CONFIRM' untuk melanjutkan atau ketik apa saja untuk membatalkan.`,
      {
        reply_markup: {
          // force_reply: true,
          // selective: true
          inline_keyboard: [
            [
              {
                text: "Yes",
                callback_data: "btn_yes"
              },
              {
                text: "No",
                callback_data: "btn_no"
              },

            ]
          ]
        }
      }
    );

    const response = await new Promise(resolve => {
      bot.on('callback_query', async (ctx) => {
        if (ctx.from.id == chatId) {
          resolve(ctx.data == 'btn_yes');
        }
      })
    });

    if (!response) {
      bot.sendMessage(chatId, '❌ Pembersihan dibatalkan.');
      return;
    }

    // Hapus file
    for (const file of filesToDelete) {
      try {
        await fsPromises.unlink(path.join(userFolder, file));
        successCount++;
      } catch (err) {
        console.error(`Failed to delete ${file}:`, err);
      }
    }

    const message = `✅ Pembersihan selesai!\n\n` +
      `📊 Ringkasan:\n` +
      `• File dihapus: ${successCount}/${filesToDelete.length}\n` +
      `• Ukuran dibebaskan: ${formatBytes(totalSize)}\n\n` +
      `Gunakan /storage untuk melihat penggunaan storage terbaru.`;

    bot.sendMessage(chatId, message);

  } catch (error) {
    console.error('Error cleaning storage:', error);
    bot.sendMessage(chatId, '❌ Gagal membersihkan storage: ' + error.message);
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
+62812xxxxxxx

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
      'Format: `/setlimit <chat\\_id> <files> <size\\_mb> <total\\_mb>`\n\n' +
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
      '• chat\\_id: ID user yang akan diatur\n' +
      '• files: Jumlah maksimal file \\(\\- = tidak diubah\\)\n' +
      '• size\\_mb: Ukuran maksimal per file \\(\\- = tidak diubah\\)\n' +
      '• total\\_mb: Total ukuran maksimal \\(\\- = tidak diubah\\)';

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

    // Get current limits for reference
    const currentLimits = userManager.getStorageLimits(targetId);

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
    const effectiveFileSize = fileSize || Math.floor(currentLimits.MAX_FILE_SIZE / (1024 * 1024));
    const effectiveTotalSize = totalSize || Math.floor(currentLimits.MAX_TOTAL_SIZE / (1024 * 1024));
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

bot.onText(/\/testing/, async (ctx) => {
  const to = ctx.chat.id
  const message = await bot.sendMessage(ctx.chat.id, "Please click on button below.", {
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Yes",
            callback_data: "btn_yes"
          },
          {
            text: "No",
            callback_data: "btn_no"
          },

        ]
      ]
    }
  });

  console.log(message)

  bot.on('callback_query', async (ctx) => {
    if (ctx.from.id === to) {
      if (ctx.data === "btn_yes") {
        await bot.sendMessage(ctx.from.id, "You clicked Yes");
      } else if (ctx.data === "btn_no") {
        await bot.sendMessage(ctx.from.id, "You clicked No");
      }
    }
  });
})
