const fs = require('fs').promises;
const path = require('path');
const os = require('os');
const assert = require('assert');
const VcfConverter = require('./vcfConverter');

async function run() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'txt2vcf-'));
  const inputPath = path.join(tmpDir, 'contacts.txt');

  await fs.writeFile(inputPath, ['081234567890', '+6281234567891', '6281234567892'].join('\n'), 'utf8');

  const converter = new VcfConverter();
  const result = await converter.convertTxtToVcf(inputPath, {
    name: 'Contact',
    startNumber: 1,
    splitCount: 2
  });

  assert.strictEqual(result.count, 3, 'jumlah kontak harus 3');
  assert.strictEqual(result.fileCount, 2, 'splitCount 2 harus menghasilkan 2 file');
  assert.strictEqual(result.countrySummary.ID, 3, 'semua nomor harus terdeteksi Indonesia');
  assert.ok(result.contents[0].includes('FN:Contact 1'), 'file pertama harus berisi kontak pertama');
  assert.ok(result.contents[1].includes('FN:Contact 3'), 'file kedua harus berisi kontak ketiga');

  const validation = converter.validatePhoneNumbers('081234567890\n123');
  assert.strictEqual(validation.valid, false, 'nomor pendek harus invalid');
  assert.strictEqual(validation.invalidNumbers.length, 1, 'harus ada 1 nomor invalid');

  console.log('✅ Semua test VCF converter berhasil.');
}

run().catch(error => {
  console.error(error);
  process.exit(1);
});
