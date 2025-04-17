import { promises } from 'fs';
const fsPromises = promises;
import { join } from 'path';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);

const VcfConverter = require('./vcfConverter');
const vcfConverter = new VcfConverter();

const fileId = process.env.OWNER_ID
const userFolder = './userfiles/' + fileId
const inputPath = userFolder + '/650-13.txt'
const nameResponse = 'Contact'
const startNumberResponse = 1
const splitCountResponse = 100

const vcfFileName = 'exameple-filename'

const test = async () => {
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
        const outputPath = join(userFolder, `${vcfFileName}${suffix}.vcf`);
        await fsPromises.writeFile(outputPath, result.contents[i], 'utf8');
        outputPaths.push(outputPath);
    }
}

test()