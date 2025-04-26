# 📱 Bot Konversi TXT ke VCF

Bot Telegram untuk mengkonversi daftar nomor telepon dari file TXT menjadi file VCF (vCard) yang siap diimpor ke smartphone.

## 🌟 Fitur Utama

### 📝 Manajemen File
1. **Upload File**
   - Upload file TXT berisi daftar nomor telepon
   - Validasi format file dan ukuran
   - Deteksi file duplikat dengan opsi:
     - Ganti nama file
     - Timpa file yang ada
     - Batalkan upload

2. **Lihat File**
   - Command: `/myfiles`
   - Menampilkan daftar file TXT dan VCF
   - Informasi ukuran file
   - Opsi untuk mengambil atau menghapus file

3. **Ambil File**
   - Command: `/getfile [nama]`
   - Download file TXT atau VCF
   - Preview isi file TXT

4. **Hapus File**
   - Command: `/deletefile [nama]`
   - Hapus file yang tidak digunakan
   - Konfirmasi sebelum penghapusan

### 📱 Konversi ke VCF
1. **Konversi File**
   - Command: `/txt2vcf [nama]`
   - Konversi file TXT ke format VCF
   - Validasi format nomor telepon
   - Dukungan format:
     - Lokal: 08xx, 628xx
     - Internasional: +1xxx (US), +44xxx (UK), dll
     - Minimal 10 digit (termasuk kode negara)

2. **Kustomisasi Kontak**
   - Atur nama kontak (prefix)
   - Pilih nomor urut awal
   - Opsi pemecahan file:
     - Single file
     - Multiple file (2-10 file)
     - Rekomendasi otomatis berdasarkan jumlah kontak

3. **Ringkasan Konversi**
   - Total kontak yang dikonversi
   - Ringkasan format nomor per negara
   - Informasi jumlah kontak per file
   - Preview format kontak

### 💾 Manajemen Storage
1. **Cek Storage**
   - Command: `/storage`
   - Informasi penggunaan storage:
     - Jumlah file
     - Total ukuran
     - Batasan storage

2. **Bersihkan Storage**
   - Command: `/clean`
   - Mode pembersihan:
     - `/clean vcf` - Hapus semua VCF
     - `/clean txt` - Hapus semua TXT
     - `/clean all` - Hapus semua file
     - `/clean old` - Hapus file > 7 hari
   - Preview file yang akan dihapus
   - Konfirmasi sebelum penghapusan
   - Ringkasan hasil pembersihan

### 👥 Manajemen User
1. **Registrasi User**
   - Command: `/getid` - Dapatkan Chat ID
   - Registrasi oleh owner bot
   - Batasan akses per user

2. **Batasan Storage**
   - Batas jumlah file
   - Batas ukuran per file
   - Batas total ukuran
   - Kustomisasi batasan per user

3. **Monitoring User**
   - Tracking aktivitas user
   - Status user aktif/non-aktif
   - Total pengguna bot

### 👑 Fitur Owner
1. **Manajemen User**
   - `/adduser` - Tambah user baru
   - `/removeuser` - Hapus user
   - `/listusers` - Lihat daftar user
   - `/active` - Lihat user aktif

2. **Pengaturan Storage**
   - `/setlimit` - Atur batasan storage
   - `/resetlimit` - Reset ke default
   - `/checklimit` - Cek batasan user

3. **Monitoring**
   - `/status` - Status bot
   - `/stats` - Statistik bot
   - `/broadcast` - Kirim pesan ke semua user

## 🔧 Penggunaan

### Persiapan File TXT
1. Buat file txt berisi daftar nomor telepon
2. Satu nomor per baris
3. Format nomor yang didukung:
   ```
   0812xxxxxxxx
   628xxxxxxxxx
   +62812xxxxxxx
   +1234xxxxxxx (format internasional)
   ```

### Konversi ke VCF
1. Upload file txt ke bot
2. Gunakan command `/txt2vcf [nama]`
3. Ikuti panduan konversi:
   - Masukkan nama kontak
   - Pilih nomor urut awal
   - Pilih jumlah file output
4. Download file VCF yang dihasilkan
5. Import ke smartphone menggunakan aplikasi kontak bawaan

### Tips
1. Gunakan `/myfiles` untuk melihat daftar file
2. Hapus file yang tidak digunakan dengan `/clean`
3. Cek penggunaan storage dengan `/storage`
4. Backup file penting sebelum dihapus
5. Gunakan fitur split file untuk file besar

## 📋 Format Perintah

### Perintah Umum
```
/start - Mulai bot
/help - Panduan penggunaan bot
/getid - Dapatkan Chat ID
/storage - Cek penggunaan storage
/myfiles - Lihat daftar file
/getfile [nama] - Ambil file
/deletefile [nama] - Hapus file
/txt2vcf [nama] - Konversi TXT ke VCF
/clean - Bersihkan storage
```

### Perintah Owner
```
/adduser [chat_id] - Tambah user
/removeuser [chat_id] - Hapus user
/listusers - Daftar user
/active - User aktif
/status - Status bot
/stats - Statistik bot
/broadcast [pesan] - Broadcast pesan
/setlimit [chat_id] [files] [size_mb] [total_mb] - Set limit
/resetlimit [chat_id] - Reset limit
/checklimit [chat_id] - Cek limit
```

## 🔒 Batasan Default
- Maksimal file: 50 file
- Ukuran per file: 5 MB
- Total storage: 100 MB
- Format file: TXT, VCF
- Minimal digit nomor: 10
- Maksimal split file: 10

## 🔧 Technical Details

### Architecture
- **Core Components**
  - `index.js`: Main bot logic and command handlers
  - `users.js`: User management and storage limits
  - `vcfConverter.js`: TXT to VCF conversion logic

### Storage System
- **File Structure**
  - User files stored in `userfiles/<chat_id>/`
  - User limits in `user_limits.json`
  - Active users in `users.txt`

### Security & Limits
- Default storage limits:
  - 10 files per user
  - 1MB per file
  - 5MB total per user
- Owner-only commands for user management
- File type validation (.txt, .vcf)
- Sanitized filenames

### Dependencies
- **Core**
  - `node-telegram-bot-api`: Telegram Bot API interface
  - `dotenv`: Environment configuration
  - `uuid`: Unique file ID generation
  - `sanitize-filename`: Safe file handling
- **Development**
  - `nodemon`: Auto-restart during development

### Environment Setup
```bash
# Required environment variables
BOT_TOKEN=your_telegram_bot_token
OWNER_ID=your_telegram_user_id

# Optional configurations
MAX_FILE_SIZE=1048576  # 1MB in bytes
MAX_TOTAL_SIZE=5242880 # 5MB in bytes
MAX_FILES=10           # Max files per user
```

### Running the Bot
```bash
# Install dependencies
npm install

# Development mode with auto-restart
npm run dev

# Production mode
npm start

# Run tests
npm test
```

### Error Handling
- File size validation
- Storage quota checks
- File format validation
- Duplicate file detection
- Network error recovery
- Invalid phone number handling

### Performance
- Async file operations
- Streaming file uploads/downloads
- Batch processing for large files
- Memory-efficient file handling

## 🔧 Error Handling & Reliability
1. **Polling Error Recovery**
   - Automatic detection of conflicting bot instances
   - Smart reconnection with 5-second cooldown
   - Graceful error handling for Telegram API issues

2. **Bot Instance Management**
   - Single instance enforcement
   - Proper shutdown handling
   - Automatic recovery from network issues

### 🛠️ Technical Details
1. **Bot Configuration**
   - Polling timeout: 10 seconds
   - Auto-start enabled
   - Filepath caching disabled
   - Custom API URL configuration

2. **Error Types Handled**
   - ETELEGRAM conflicts
   - Network connectivity issues
   - API rate limiting
   - Timeout errors

## 💡 Catatan
- Pastikan format nomor telepon sesuai
- Backup file penting secara berkala
- Gunakan fitur clean untuk menghemat storage
- Hubungi owner bot untuk pendaftaran
- Bot akan offline saat maintenance
