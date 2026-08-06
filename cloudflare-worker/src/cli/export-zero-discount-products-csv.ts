// Generates a Shoptet-import-ready CSV that blocks ALL discount (action
// price stacking aside, coupon + loyalty tiers) on a fixed, client-supplied
// list of product codes (src/config/policies/zero-discount-products.json --
// 140 codes, incl. gift-voucher product "100P" itself, from client Excel
// "Produkty ktoré maju mat ziadnu zlavu zlava 0% bez výnimky.xlsx", 2026-08-06).
//
// Unlike export-coupon-fields-csv.ts (which writes an empty cell for "no
// cap"), this script deliberately writes literal "0" for applyDiscountCoupon
// AND maxDiscount on every pricelist including GUEST -- here that IS the
// intended state (hard block), not the field-overload trap from the
// 2026-08-05 incident (that trap was writing 0 by ACCIDENT while MEANING
// "no cap"; here we mean 0 and write 0). See memory: shoptet-field-overload-law.
//
// Gift-voucher REDEMPTION (paying with a voucher at checkout) is a separate
// Shoptet mechanism entirely, untouched by these fields -- confirmed via
// codebase audit 2026-08-06 (RUNBOOK.md, compute-coupon-writes.ts docblock).
// So this file does NOT need to special-case "100P": blocking its own
// discount fields does not block using OTHER vouchers to pay for THIS or
// any other product.
//
// Only rows for the listed codes are written -- every other product is left
// completely untouched (not present in the output CSV at all).
//
// Usage: npx tsx src/cli/export-zero-discount-products-csv.ts
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

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const listPath = path.resolve(__dirname, '../../../src/config/policies/zero-discount-products.json');
    const codes: string[] = JSON.parse(fs.readFileSync(listPath, 'utf-8'));
    const codeSet = new Set(codes);
    console.log(`Načteno ${codes.length} kódů ze zero-discount seznamu.`);

    console.log('Stahuji master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../zero_discount_products_import.csv');
    const out = fs.createWriteStream(outPath);

    const tierOrder = Object.entries(ALL_PRICELISTS_MAP);
    const headerCols = ['code', 'pairCode'];
    for (const [tier, pricelistId] of tierOrder) {
        if (tier === 'GUEST') {
            headerCols.push('applyDiscountCoupon', 'maxDiscount');
        } else {
            // Shoptet import requires pricelist:<id>:price present for any other
            // per-pricelist column on that pricelist to be accepted at all --
            // include the product's own unchanged price purely to satisfy this.
            headerCols.push(`pricelist:${pricelistId}:price`, `pricelist:${pricelistId}:applyDiscountCoupon`, `pricelist:${pricelistId}:maxDiscount`);
        }
    }
    out.write(headerCols.join(';') + '\n');

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const found = new Set<string>();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code || !codeSet.has(code)) continue;
        found.add(code);

        // Klient výslovně chce, aby na těchto produktech nebyla vidět ani ŽÁDNÁ
        // jiná cena pro tiery -- nestačí jen zablokovat kupón/strop, musí se
        // resetovat i samotná cena na každém ceníku zpátky na plnou (standardní)
        // cenu. Bez tohohle by tam zůstala stará zlevněná tierová cena z doby
        // před zavedením zero-discount seznamu.
        const basePrice = row['price'] || '';
        const cols = [code, row['pairCode'] || ''];
        for (const [tier] of tierOrder) {
            if (tier === 'GUEST') {
                cols.push('0', '0'); // applyDiscountCoupon=0 (blocked), maxDiscount=0 (hard cap)
            } else {
                cols.push(basePrice, '0', '0');
            }
        }
        out.write(cols.join(';') + '\n');
    }

    out.end();

    const missing = codes.filter(c => !found.has(c));
    console.log(`\nHOTOVO. Zapsáno ${found.size}/${codes.length} kódů. Soubor: ${outPath}`);
    if (missing.length > 0) {
        console.log(`\nPOZOR — ${missing.length} kódů ze seznamu se ve feedu vůbec nenašlo (překlep? smazaný produkt?):`);
        console.log(missing.join(', '));
    }
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
