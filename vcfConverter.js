const fs = require('fs').promises;
const { COUNTRY_DATA, getCountryByCode } = require('./countryData');

class VcfConverter {
  constructor() {
    // Create pattern from country codes
    const codes = [...new Set(Object.values(COUNTRY_DATA).map(data => data.code))];
    this.countryCodePattern = new RegExp(
      '^(' + codes.sort((a, b) => b.length - a.length).join('|') + ')',
    );
    this.vCardTemplate = `BEGIN:VCARD
VERSION:3.0
N:;{name};;;
FN:{name}
TEL;TYPE=CELL:{number}
END:VCARD
`;
  }

  // Deteksi kode negara dari nomor
  detectCountryCode(number) {
    const match = number.match(this.countryCodePattern);
    return match ? match[1] : null;
  }

  // Bersihkan dan format nomor telepon
  cleanPhoneNumber(number) {
    // Hapus semua karakter non-digit
    let cleaned = number.replace(/\D/g, '');

    // Jika nomor dimulai dengan 0, coba deteksi negara dari input asli
    if (cleaned.startsWith('0')) {
      // Cek apakah ada kode negara di input asli (e.g. +44, +1, dll)
      const originalCode = number.match(/^\+?(\d+)/)?.[1];
      if (originalCode && getCountryByCode(originalCode)) {
        cleaned = originalCode + cleaned.substring(1);
      } else {
        // Default ke 62 (Indonesia) jika tidak ada kode negara
        cleaned = '62' + cleaned.substring(1);
      }
    }

    // Deteksi kode negara yang ada
    const countryCode = this.detectCountryCode(cleaned);

    // Jika tidak ada kode negara valid, tambahkan 62 (Indonesia)
    if (!countryCode) {
      cleaned = '62' + cleaned;
    }

    // Validasi panjang nomor (min 10 digit termasuk kode negara)
    if (cleaned.length < 10) {
      throw new Error(`Nomor terlalu pendek: ${number}`);
    }

    return cleaned;
  }

  // Dapatkan info negara dari nomor
  getCountryInfo(number) {
    const countryCode = this.detectCountryCode(number);
    if (!countryCode) return null;
    return getCountryByCode(countryCode);
  }

  // Baca file txt dan konversi ke format vcf
  async convertTxtToVcf(inputPath, options = {}) {
    const { name = 'Contact', startNumber = 1, splitCount = 0 } = options;

    // Baca file txt
    const content = await fs.readFile(inputPath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim());

    let vcfContents = [];
    let currentVcf = '';
    let count = 0;
    let fileCount = 0;
    const countries = {};
    let current = 0;

    // Proses setiap baris
    for (const line of lines) {
      const cleanNumber = this.cleanPhoneNumber(line);

      if (!cleanNumber) continue;

      // Deteksi negara
      const country = this.getCountryInfo(cleanNumber);
      countries[country.name] = (countries[country.name] || 0) + 1;

      // Format nomor dengan kode negara
      const formattedNumber = `+${cleanNumber}`;

      // Buat vCard untuk nomor ini
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `N:;${name} ${startNumber + count};;;;`,
        `FN:${name} ${startNumber + count}`,
        `TEL;TYPE=CELL:${formattedNumber}`,
        'END:VCARD'
      ].join('\n');

      currentVcf += vcard + '\n\n';
      count++;

      if (splitCount > 0 && current + 1 >= splitCount) {
        vcfContents.push(currentVcf);
        currentVcf = '';
        fileCount++;
        current = 0;
        continue;
      }
      current++
    }

    // Simpan sisa kontak jika ada
    if (currentVcf) {
      vcfContents.push(currentVcf);
      fileCount++;
    }

    // Jika tidak dipecah, gabung semua jadi satu
    if (splitCount <= 0) {
      vcfContents = [currentVcf];
      fileCount = 1;
    }

    // Buat ringkasan negara
    const numbers = lines.map(line => line.trim()).filter(line => line.length > 0);
    const countrySummary = {};
    for (const number of numbers) {
      try {
        const cleaned = this.cleanPhoneNumber(number);
        const countryInfo = this.getCountryInfo(cleaned);
        if (countryInfo) {
          const isoCode = countryInfo.iso;
          countrySummary[isoCode] = (countrySummary[isoCode] || 0) + 1;
        }
      } catch (error) {
        // ignore error
      }
    }

    return {
      contents: vcfContents,
      count,
      fileCount,
      countrySummary
    };
  }

  // Validasi format nomor telepon
  validatePhoneNumbers(content) {
    const validations = [];

    const numbers = content.split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);

    for (const number of numbers) {
      try {
        const cleaned = this.cleanPhoneNumber(number);
        const country = this.getCountryInfo(cleaned);
        validations.push({
          original: number,
          cleaned: cleaned,
          valid: true,
          country: country?.name || 'Unknown'
        });
      } catch (error) {
        validations.push({
          original: number,
          valid: false,
          error: error.message
        });
      }
    }

    const invalid = validations.filter(v => !v.valid);
    const valid = validations.filter(v => v.valid);

    return {
      valid: invalid.length === 0,
      total: numbers.length,
      validNumbers: valid,
      invalidNumbers: invalid,
      summary: valid.reduce((acc, v) => {
        acc[v.country] = (acc[v.country] || 0) + 1;
        return acc;
      }, {})
    };
  }

  // Merge multiple VCF files into one
  async mergeVcfFiles(filePaths, outputName) {
    try {
      let mergedContent = '';
      let totalContacts = 0;
      const countries = {};

      // Process each file
      for (const filePath of filePaths) {
        const content = await fs.readFile(filePath, 'utf8');
        const vcards = content.split('BEGIN:VCARD')
          .filter(card => card.trim())
          .map(card => 'BEGIN:VCARD' + card.trim());
        
        // Add each vCard to merged content
        for (const vcard of vcards) {
          // Extract phone number to track country stats
          const phoneMatch = vcard.match(/TEL[^:]*:(.+)/);
          if (phoneMatch) {
            const number = phoneMatch[1].trim();
            const cleanNumber = this.cleanPhoneNumber(number);
            const country = this.getCountryInfo(cleanNumber);
            if (country) {
              countries[country.name] = (countries[country.name] || 0) + 1;
            }
          }
          
          mergedContent += vcard + '\n';
          totalContacts++;
        }
      }

      return {
        content: mergedContent.trim(),
        stats: {
          totalContacts,
          countries: Object.entries(countries)
            .sort(([,a], [,b]) => b - a)
            .reduce((acc, [country, count]) => {
              acc[country] = count;
              return acc;
            }, {})
        }
      };
    } catch (error) {
      throw new Error(`Error merging VCF files: ${error.message}`);
    }
  }
}

module.exports = VcfConverter;
