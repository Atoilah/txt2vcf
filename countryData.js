// Data negara dan kode telepon
const COUNTRY_DATA = {
  // Asia
  'ID': { code: '62', name: 'Indonesia' },
  'MY': { code: '60', name: 'Malaysia' },
  'SG': { code: '65', name: 'Singapura' },
  'TH': { code: '66', name: 'Thailand' },
  'VN': { code: '84', name: 'Vietnam' },
  'PH': { code: '63', name: 'Filipina' },
  'JP': { code: '81', name: 'Jepang' },
  'KR': { code: '82', name: 'Korea Selatan' },
  'CN': { code: '86', name: 'Tiongkok' },
  'HK': { code: '852', name: 'Hong Kong' },
  'IN': { code: '91', name: 'India' },

  // Timur Tengah
  'SA': { code: '966', name: 'Arab Saudi' },
  'AE': { code: '971', name: 'Uni Emirat Arab' },
  'QA': { code: '974', name: 'Qatar' },
  'BH': { code: '973', name: 'Bahrain' },
  'KW': { code: '965', name: 'Kuwait' },

  // Eropa
  'GB': { code: '44', name: 'Inggris' },
  'FR': { code: '33', name: 'Prancis' },
  'DE': { code: '49', name: 'Jerman' },
  'IT': { code: '39', name: 'Italia' },
  'ES': { code: '34', name: 'Spanyol' },
  'NL': { code: '31', name: 'Belanda' },
  'SE': { code: '46', name: 'Swedia' },
  'NO': { code: '47', name: 'Norwegia' },

  // Amerika
  'US': { code: '1', name: 'Amerika Serikat' },
  'CA': { code: '1', name: 'Kanada' },
  'MX': { code: '52', name: 'Meksiko' },
  'BR': { code: '55', name: 'Brasil' },
  'AR': { code: '54', name: 'Argentina' },

  // Oseania
  'AU': { code: '61', name: 'Australia' },
  'NZ': { code: '64', name: 'Selandia Baru' }
};

// Helper functions
function getCountryByCode(dialCode) {
  for (const [iso, data] of Object.entries(COUNTRY_DATA)) {
    if (data.code === dialCode) {
      return { iso, ...data };
    }
  }
  return null;
}

function getCountryByISO(isoCode) {
  const data = COUNTRY_DATA[isoCode];
  return data ? { iso: isoCode, ...data } : null;
}

// Export functions and data
module.exports = {
  COUNTRY_DATA,
  getCountryByCode,
  getCountryByISO
};
