// Ported from ../../src/cli/customers.ts — assigns loyalty tiers by turnover and
// produces a Shoptet-import-ready CSV plus an email->discount% map for Worker sync.
'use strict';

const fs = require('fs');
const { parse } = require('csv-parse');
const { stringify } = require('csv-stringify');
const { determineCustomerTier } = require('./policy');

/**
 * @param {string} inputPath
 * @param {string} outputPath
 * @param {(msg: string) => void} log
 * @returns {Promise<{ totalCustomers: number, upgradedCustomers: number, vipDiscountsMap: Record<string, number>, stats: Record<string, number> }>}
 */
async function processCustomersCsv(inputPath, outputPath, log) {
    if (!fs.existsSync(inputPath)) throw new Error(`Soubor nenalezen: ${inputPath}`);

    log('Zpracovávám zákaznický CSV soubor...');

    const records = [];
    const stats = {};
    let totalCustomers = 0;
    let upgradedCustomers = 0;
    const vipDiscountsMap = {};

    const parser = fs.createReadStream(inputPath).pipe(
        parse({ delimiter: ';', columns: true, skip_empty_lines: true })
    );

    for await (const row of parser) {
        totalCustomers++;

        const val = row.totalOrderValue;
        let total = 0;
        if (typeof val === 'string') {
            const clean = val.replace(',', '.').replace(/[^0-9.-]/g, '');
            total = clean ? parseFloat(clean) : 0;
        } else if (typeof val === 'number') {
            total = val;
        }

        const newTier = determineCustomerTier(total) || 'ZR4';
        const email = row.email || '';

        if (email) {
            const discount = parseInt(newTier.replace('ZR', ''), 10);
            if (!isNaN(discount)) vipDiscountsMap[email.toLowerCase()] = discount;
        }

        const originalValue = (row.pricelistName ?? '').toString().trim();
        if (originalValue.toUpperCase() !== newTier.toUpperCase()) upgradedCustomers++;

        row.pricelistName = newTier;
        row.customerGroup = newTier;
        stats[newTier] = (stats[newTier] || 0) + 1;
        records.push(row);

        if (totalCustomers % 5000 === 0) log(`...zpracováno ${totalCustomers} zákazníků`);
    }

    await new Promise((resolve, reject) => {
        const stringifier = stringify({ header: true, delimiter: ';' });
        const writableStream = fs.createWriteStream(outputPath);
        stringifier.on('error', reject);
        writableStream.on('error', reject);
        writableStream.on('finish', resolve);
        stringifier.pipe(writableStream);
        for (const record of records) stringifier.write(record);
        stringifier.end();
    });

    log(`HOTOVO. Celkem zákazníků: ${totalCustomers}, změněno: ${upgradedCustomers}`);
    const tiers = ['ZR4', 'ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14', 'ZR16', 'ZR18', 'ZR20', 'ZR25'];
    for (const tier of tiers) log(`  ${tier}: ${stats[tier] || 0} zákazníků`);

    return { totalCustomers, upgradedCustomers, vipDiscountsMap, stats };
}

module.exports = { processCustomersCsv };
