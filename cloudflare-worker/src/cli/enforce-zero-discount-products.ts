// Self-healing enforcement for the client's "0% zľava bez výnimky" product
// list (src/config/policies/zero-discount-products.json, 140 codes -- see
// client Excel "Produkty ktoré maju mat ziadnu zlavu zlava 0% bez výnimky.xlsx",
// 2026-08-06). Runs on EVERY sync (cron + webhook), so it's continuously
// re-enforced -- important because the client ALSO does manual bulk brand-level
// discount edits directly in Shoptet admin, and "Maximálna povolená zľava" is
// literally the SAME field for brand and product overrides: whichever write
// happens last wins. A one-off manual CSV import (what we did first) can get
// silently clobbered by the client's next brand edit. This script writes the
// authoritative 0%/no-coupon/full-price state live via API on every pipeline
// run, so it self-heals within one sync cycle regardless of what the client
// does manually in between.
//
// Live API write of a literal 0% (checked, not "unchecked") is safe per the
// field-overload law (see memory: shoptet-field-overload-law) -- that law's
// warning is specifically about the live API's inability to produce
// "unchecked/no cap" (it always sends SOME numeric value). Here 0% IS the
// intended state, so writing 1.0000 minPriceRatio via API is correct, not a
// trap.
//
// Usage: npx tsx src/cli/enforce-zero-discount-products.ts
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';
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
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set');

    const listPath = path.resolve(__dirname, '../../../src/config/policies/zero-discount-products.json');
    const codes: string[] = JSON.parse(fs.readFileSync(listPath, 'utf-8'));
    const codeSet = new Set(codes);
    console.log(`Vynucuji 0% slevu na ${codes.length} produktech...`);

    console.log('Stahuji master feed pro aktuální plné ceny...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Feed fetch failed: HTTP ${res.status}`);
    const priceByCode: Record<string, string> = {};
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (code && codeSet.has(code) && row['price']) priceByCode[code] = row['price'];
    }

    const found = codes.filter(c => priceByCode[c] !== undefined);
    const missing = codes.filter(c => priceByCode[c] === undefined);
    console.log(`Nalezeno ${found.length}/${codes.length} kódů ve feedu.`);
    if (missing.length > 0) console.log(`Chybí ve feedu (přeskočeno): ${missing.join(', ')}`);

    const client = new ShoptetApiClient(token);
    const priceItems = found.map(code => ({ code, price: priceByCode[code] }));
    const salesItems = found.map(code => ({ code, discountCoupon: false, minPriceRatio: '1.0000' }));

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        console.log(`\n-- Ceník ${tier} (id ${pricelistId}) --`);
        const priceRes = await client.updatePricelistBatch(pricelistId, priceItems);
        console.log(`  Cena -> status ${priceRes.status}`);
        const salesRes = await client.updatePricelistSalesBatch(pricelistId, salesItems);
        console.log(`  Sales (0%/kupón vypnut) -> status ${salesRes.status}`);
    }

    console.log('\n=== HOTOVO — 0% zľava vynucena na všech ceníkách ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
