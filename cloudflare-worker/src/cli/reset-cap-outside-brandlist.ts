// Incident recovery (2026-08-05): sync-guest-coupon-cap-live.ts was run at
// full-catalog scale and overwrote pricelist-1 minPriceRatio ("Maximální
// povolená sleva") with ZR4's remaining-coupon-room value instead of the
// product's real intended cap — for ~14,600 products.
//
// Client provided the authoritative list of brands that SHOULD have a real
// cap (handled separately by set-brand-cap-live.ts, one run per brand).
// This script resets everything ELSE — every product whose manufacturer is
// NOT in that list — back to minPriceRatio 0.0000, the documented neutral
// "no cap" default (see INCIDENTS.md INC-005: unset/blank state reads back
// as "0.000", not "1.000" — confirmed via live API reads before any of
// today's writes touched this field).
//
// discountCoupon is read-and-preserved exactly as currently set, same
// pattern as set-brand-cap-live.ts — only minPriceRatio changes here.
//
// Usage:
//   npx tsx src/cli/reset-cap-outside-brandlist.ts            (dry run)
//   npx tsx src/cli/reset-cap-outside-brandlist.ts --live      (live write)
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

// Authoritative brand list from client (2026-08-05) — anything NOT here gets reset.
const PROTECTED_BRANDS = new Set([
    'delphin', 'delphin bomb', 'mikado', 'mivardi', 'vagner',
    'lowrance', 'humminbird', 'simrad', 'navico',
    'lucky', 'aquarius', 'bait-tech', "carp 'r' us", 'cp', 'crazy fish',
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

    console.log(`=== ${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'}: reset stropu na 0.0000 pro produkty MIMO seznam ${PROTECTED_BRANDS.size} chráněných značek ===`);

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const codesToReset: string[] = [];
    let scanned = 0;
    let protectedCount = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        const brand = (row['manufacturer'] || '').trim().toLowerCase();
        if (PROTECTED_BRANDS.has(brand)) {
            protectedCount++;
            continue;
        }
        if (row['code']) codesToReset.push(row['code']);
    }

    console.log(`Prohledáno ${scanned} produktů. Chráněno (na seznamu značek): ${protectedCount}. K resetu: ${codesToReset.length}.`);

    if (!isLive) {
        console.log('DRY RUN — žádný zápis neproběhl. Spusť s --live pro ostrý zápis.');
        console.log('Prvních 10 kódů k resetu:', codesToReset.slice(0, 10).join(', '));
        return;
    }

    // Read current GUEST state first so we only touch minPriceRatio, preserving discountCoupon.
    console.log('Načítám aktuální stav GUEST ceníku...');
    const guestItems = await client.getPricelistItems(GUEST_PRICELIST_ID);
    const guestByCode = new Map(guestItems.map(i => [i.code, i]));

    const toWrite: Array<{ code: string; discountCoupon: boolean; minPriceRatio: string }> = [];
    for (const code of codesToReset) {
        const current = guestByCode.get(code);
        if (!current) continue;
        if (Number(current.sales.minPriceRatio).toFixed(4) === '0.0000') continue; // already correct
        toWrite.push({ code, discountCoupon: current.sales.discountCoupon, minPriceRatio: '0.0000' });
    }

    console.log(`Liší se od cílové hodnoty 0.0000: ${toWrite.length}. Zapisuji...`);

    const snapshotDir = path.resolve('./.snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `reset_cap_rollback_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify({
        before: toWrite.map(i => ({ code: i.code, sales: guestByCode.get(i.code)?.sales })),
    }, null, 2), 'utf-8');
    console.log(`[SNAPSHOT] Uložen stav pro rollback: ${snapshotPath}`);

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
