// Load environment variables
require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');

// Default storage limits
const DEFAULT_STORAGE_LIMITS = {
  MAX_FILES_PER_USER: 10, // Maksimal 10 file per user
  MAX_FILE_SIZE: 1024 * 1024, // 1MB per file
  MAX_TOTAL_SIZE: 5 * 1024 * 1024 // 5MB total per user
};

class UserManager {
  constructor() {
    this.usersFile = process.env.USERS_FILE || path.join(__dirname, 'users.txt');
    this.usersLimitsFile = process.env.USERS_LIMITS_FILE || path.join(__dirname, 'user_limits.json');
    this.maxIdleTime = parseInt(process.env.MAX_IDLE_TIME || '30', 10); // minutes
    this.cleanInterval = parseInt(process.env.ACTIVE_USERS_CLEAN_INTERVAL || '5', 10); // minutes
    this.ownerId = process.env.OWNER_ID;
    
    this.users = new Set();
    this.activeUsers = new Map(); // Menyimpan user aktif dan timestamp aktivitas terakhir
    this.userLimits = new Map(); // Stores custom storage limits for users
    this.userStates = new Map(); // Stores user states for multi-step operations
    
    this.loadUsers();
    this.loadUserLimits();
    
    // Start cleaning inactive users periodically
    setInterval(() => this.cleanInactiveUsers(), this.cleanInterval * 60 * 1000);
  }

  getStorageLimits(chatId) {
    const userLimits = this.userLimits.get(chatId.toString());
    return userLimits || DEFAULT_STORAGE_LIMITS;
  }

  setStorageLimits(chatId, limits) {
    if (!limits || typeof limits !== 'object') {
      throw new Error('Invalid limits object');
    }

    // Validate input values
    const files = parseInt(limits.files);
    const fileSize = parseInt(limits.fileSize);
    const totalSize = parseInt(limits.totalSize);

    if (files && (isNaN(files) || files < 1)) {
      throw new Error('Files limit must be a positive number');
    }
    if (fileSize && (isNaN(fileSize) || fileSize < 1)) {
      throw new Error('File size limit must be a positive number');
    }
    if (totalSize && (isNaN(totalSize) || totalSize < 1)) {
      throw new Error('Total size limit must be a positive number');
    }

    const currentLimits = this.getStorageLimits(chatId);
    const newLimits = {
      MAX_FILES_PER_USER: files || currentLimits.MAX_FILES_PER_USER,
      MAX_FILE_SIZE: (fileSize || Math.floor(currentLimits.MAX_FILE_SIZE / (1024 * 1024))) * 1024 * 1024,
      MAX_TOTAL_SIZE: (totalSize || Math.floor(currentLimits.MAX_TOTAL_SIZE / (1024 * 1024))) * 1024 * 1024
    };

    // Ensure total size is not less than max file size
    if (newLimits.MAX_TOTAL_SIZE < newLimits.MAX_FILE_SIZE) {
      throw new Error('Total size limit cannot be less than file size limit');
    }

    this.userLimits.set(chatId.toString(), newLimits);
    this.saveUserLimits();
    return this.getUserStorageInfo(chatId);
  }

  resetStorageLimits(chatId) {
    this.userLimits.delete(chatId.toString());
    this.saveUserLimits();
  }

  async saveUsers() {
    const lines = [];
    for (const userId of this.users) {
      const limits = this.userLimits.get(userId);
      if (limits) {
        lines.push(`${userId}|${JSON.stringify(limits)}`);
      } else {
        lines.push(userId);
      }
    }
    try {
      await fs.writeFile(this.usersFile, lines.join('\n'));
    } catch (error) {
      console.error('Error saving users:', error);
    }
  }

  async saveUserLimits() {
    try {
      const limitsData = {};
      this.userLimits.forEach((limits, chatId) => {
        limitsData[chatId] = {
          files: limits.MAX_FILES_PER_USER,
          fileSize: Math.floor(limits.MAX_FILE_SIZE / (1024 * 1024)), // Convert bytes to MB
          totalSize: Math.floor(limits.MAX_TOTAL_SIZE / (1024 * 1024)) // Convert bytes to MB
        };
      });
      await fs.writeFile(
        this.usersLimitsFile,
        JSON.stringify(limitsData, null, 2)
      );
    } catch (error) {
      console.error('Error saving user limits:', error);
    }
  }

  async loadUsers() {
    try {
      const data = await fs.readFile(this.usersFile, 'utf8');
      const lines = data.split('\n').filter(Boolean);
      
      this.users = new Set();
      for (const line of lines) {
        if (line.includes('|')) {
          const [userId, limits] = line.split('|');
          this.users.add(userId);
          try {
            this.userLimits.set(userId, JSON.parse(limits));
          } catch (e) {
            console.error('Error parsing limits for user:', userId);
          }
        } else {
          this.users.add(line);
        }
      }
      console.log(`Loaded ${this.users.size} users`);
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('Users file not found, creating new one');
        await this.saveUsers();
      } else {
        console.error('Error loading users:', error);
      }
    }
  }

  async loadUserLimits() {
    try {
      if (await fs.access(this.usersLimitsFile).then(() => true).catch(() => false)) {
        const data = await fs.readFile(this.usersLimitsFile, 'utf8');
        const limitsData = JSON.parse(data);
        Object.entries(limitsData).forEach(([chatId, limits]) => {
          this.userLimits.set(chatId, {
            MAX_FILES_PER_USER: limits.files,
            MAX_FILE_SIZE: limits.fileSize * 1024 * 1024,
            MAX_TOTAL_SIZE: limits.totalSize * 1024 * 1024
          });
        });
      }
    } catch (error) {
      console.error('Error loading user limits:', error);
    }
  }

  async addUser(chatId) {
    if (!this.users.has(chatId.toString())) {
      this.users.add(chatId.toString());
      await this.saveUsers();
      return true;
    }
    return false;
  }

  async removeUser(chatId) {
    if (this.users.has(chatId.toString())) {
      this.users.delete(chatId.toString());
      await this.saveUsers();
      return true;
    }
    return false;
  }

  getUsers() {
    return Array.from(this.users);
  }

  hasUser(chatId) {
    return this.users.has(chatId.toString());
  }

  getUserCount() {
    return this.users.size;
  }

  // Catat aktivitas user
  trackUserActivity(chatId) {
    if (this.hasUser(chatId.toString())) {
      this.activeUsers.set(chatId.toString(), Date.now());
    }
  }

  // Hapus user yang tidak aktif selama lebih dari 30 menit
  cleanInactiveUsers() {
    const now = Date.now();
    for (const [userId, lastActive] of this.activeUsers) {
      if (now - lastActive > this.maxIdleTime * 60 * 1000) {
        this.activeUsers.delete(userId);
        this.userStates.delete(userId); // Clean up any lingering states
      }
    }
  }

  // Dapatkan daftar user aktif
  getActiveUsers() {
    this.cleanInactiveUsers(); // Bersihkan dulu user tidak aktif
    return Array.from(this.activeUsers.entries()).map(([chatId, lastActive]) => ({
      chatId,
      lastActive: new Date(lastActive).toLocaleString(),
      idleTime: Math.floor((Date.now() - lastActive) / 60000) // dalam menit
    }));
  }

  getUserStorageInfo(chatId) {
    const limits = this.getStorageLimits(chatId);
    return {
      maxFiles: limits.MAX_FILES_PER_USER,
      maxFileSize: Math.floor(limits.MAX_FILE_SIZE / (1024 * 1024)), // MB
      maxTotalSize: Math.floor(limits.MAX_TOTAL_SIZE / (1024 * 1024)) // MB
    };
  }

  // Get user state for multi-step operations
  getUserState(chatId) {
    return this.userStates.get(chatId.toString());
  }

  // Set user state for multi-step operations
  setUserState(chatId, state) {
    this.userStates.set(chatId.toString(), state);
  }

  // Clear user state when operation is complete
  clearUserState(chatId) {
    this.userStates.delete(chatId.toString());
  }
}

module.exports = UserManager;
