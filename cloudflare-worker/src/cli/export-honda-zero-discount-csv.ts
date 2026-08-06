// Generates a Shoptet-import-ready CSV that blocks ALL discount for the
// ENTIRE "HONDA Motor Europe Limited Slovensko" brand (not just the 10 codes
// from the client's zero-discount Excel) -- added 2026-08-06 after discovering
// the rest of the Honda/Honwave catalog (BF10, BF8, BF6, BF5, BF4AH, BF15,
// BF30, BF20, minikultivátory, krovinorez...) had NO brand cap at all, so
// ZR25 customers got the full uncapped 25% loyalty discount on motors worth
// thousands of euros.
//
// Same write pattern as export-zero-discount-products-csv.ts: literal "0"
// (not empty cell) for applyDiscountCoupon AND maxDiscount on every pricelist
// incl. GUEST -- intentional hard block, not the field-overload "no cap" trap.
// Price on every pricelist is reset to the base price (no leftover discounted
// tier price).
//
// Usage: npx tsx src/cli/export-honda-zero-discount-csv.ts
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const BRAND = 'HONDA Motor Europe Limited Slovensko';

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    console.log('Stahuji master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../honda_zero_discount_import.csv');
    const tierOrder = Object.entries(ALL_PRICELISTS_MAP);
    const headerCols = ['code', 'pairCode'];
    for (const [tier, pricelistId] of tierOrder) {
        if (tier === 'GUEST') {
            headerCols.push('applyDiscountCoupon', 'maxDiscount');
        } else {
            headerCols.push(`pricelist:${pricelistId}:price`, `pricelist:${pricelistId}:applyDiscountCoupon`, `pricelist:${pricelistId}:maxDiscount`);
        }
    }
    const rows: string[] = [headerCols.join(';')];

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    let found = 0;
    const foundNames: string[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        if ((row['manufacturer'] || '').trim() !== BRAND) continue;
        const code = row['code'];
        if (!code) continue;
        found++;
        foundNames.push(`${code} — ${row['name']}`);

        const basePrice = row['price'] || '';
        const cols = [code, row['pairCode'] || ''];
        for (const [tier] of tierOrder) {
            if (tier === 'GUEST') {
                cols.push('0', '0');
            } else {
                cols.push(basePrice, '0', '0');
            }
        }
        rows.push(cols.join(';'));
    }

    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`\nHOTOVO. Nalezeno a zapsáno ${found} produktů značky "${BRAND}". Soubor: ${outPath}`);
    console.log('\nSeznam:');
    for (const n of foundNames) console.log(' -', n);
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
