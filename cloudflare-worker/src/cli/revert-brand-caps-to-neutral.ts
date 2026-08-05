// Incident recovery (2026-08-05), part 2: today's earlier brand-cap writes
// (set-brand-cap-live.ts, 36 brands) were a MISUNDERSTANDING — client wants
// a real brand-wide DISCOUNT for these brands, not a "Maximální povolená
// sleva" CAP. Reverts every one of those 36 brands back to the neutral
// "no cap" state (minPriceRatio 0.0000, confirmed default per INC-005),
// same target value/mechanism as reset-cap-outside-brandlist.ts.
//
// Usage:
//   npx tsx src/cli/revert-brand-caps-to-neutral.ts            (dry run)
//   npx tsx src/cli/revert-brand-caps-to-neutral.ts --live      (live write)
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';
import { ShoptetApiClient } from '../shoptet-api/client';
import { GUEST_PRICELIST_ID } from '../coupon/tier-pricelist-map';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const isLive = process.argv.includes('--live');

const BRANDS_TO_REVERT = new Set([
    'delphin', 'delphin bomb', 'mikado', 'mivardi', 'vagner',
    'lowrance', 'humminbird', 'simrad', 'navico',
    'lucky', 'aquarius', 'bait-tech', "carp u rs", "carp 'r' u", "carp 'r' us", 'cp', 'crazy fish',
    'fishdream', 'for', 'garland', 'haswing', 'kolibri', 'legendfossil',
    'meva', 'mikbaits', 'mondial f', 'nitecore', 'rebelcell', 'starkboat',
    'stronger', 'tb baits', 'trakker', 'ulow', 'nn baits', 'karma baits',
].map(s => s.toLowerCase()));

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
    const client = new ShoptetApiClient(token);

    console.log(`=== ${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'}: revert ${BRANDS_TO_REVERT.size} značek zpět na 0.0000 (bez stropu) ===`);

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const codesToRevert: string[] = [];
    let scanned = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        const brand = (row['manufacturer'] || '').trim().toLowerCase();
        if (BRANDS_TO_REVERT.has(brand) && row['code']) codesToRevert.push(row['code']);
    }

    console.log(`Prohledáno ${scanned} produktů. K revertu: ${codesToRevert.length}.`);

    if (!isLive) {
        console.log('DRY RUN — žádný zápis neproběhl. Spusť s --live pro ostrý zápis.');
        return;
    }

    console.log('Načítám aktuální stav GUEST ceníku...');
    const guestItems = await client.getPricelistItems(GUEST_PRICELIST_ID);
    const guestByCode = new Map(guestItems.map(i => [i.code, i]));

    const toWrite: Array<{ code: string; discountCoupon: boolean; minPriceRatio: string }> = [];
    for (const code of codesToRevert) {
        const current = guestByCode.get(code);
        if (!current) continue;
        if (Number(current.sales.minPriceRatio).toFixed(4) === '0.0000') continue;
        toWrite.push({ code, discountCoupon: current.sales.discountCoupon, minPriceRatio: '0.0000' });
    }

    console.log(`Liší se od cílové hodnoty 0.0000: ${toWrite.length}. Zapisuji...`);

    let processed = 0;
    let failed = 0;
    const BATCH_SIZE = 100;
    for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
        const batch = toWrite.slice(i, i + BATCH_SIZE);
        try {
            await client.updatePricelistSalesBatch(GUEST_PRICELIST_ID, batch);
            processed += batch.length;
        } catch (err: any) {
            failed += batch.length;
            console.error(`Chyba v dávce ${i}-${i + batch.length}: ${err.message}`);
        }
        console.log(`...zpracováno ${processed + failed}/${toWrite.length} (chyby: ${failed})`);
    }

    console.log(`\n=== HOTOVO === Zpracováno: ${processed}, Selhalo: ${failed}`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
