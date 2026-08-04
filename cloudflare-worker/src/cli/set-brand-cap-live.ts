// Sets the real "Maximální povolená sleva" cap for every product of a given
// brand DIRECTLY via the Private API (PATCH /pricelists/{id}/batch on
// pricelist 1 — confirmed correct by Shoptet support 2026-08-04), instead of
// the manual desktop-app XLSX export/import round-trip.
//
// Deliberately separate from coupon-sales-writer.ts, which hard-refuses to
// write to GUEST_PRICELIST_ID (pricelist 1) as a safety guard against BUG #3
// (the twice-daily coupon cron accidentally corrupting this same field). That
// guard stays untouched — this is a one-off, manually-triggered script, never
// run by any cron, so it can't reintroduce that bug.
//
// Reads each matching product's CURRENT pricelist-1 item first and only
// changes minPriceRatio — discountCoupon (and anything else on that record)
// is preserved exactly as-is, so nothing else about the product's current
// state is disturbed.
//
// Usage:
//   BRAND="VAGNER" PERCENT=10 npx tsx src/cli/set-brand-cap-live.ts            (dry run)
//   BRAND="VAGNER" PERCENT=10 npx tsx src/cli/set-brand-cap-live.ts --live      (live write)
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

async function main() {
    const brand = process.env.BRAND;
    const percentStr = process.env.PERCENT;
    if (!brand) throw new Error('BRAND env var not set (e.g. BRAND=VAGNER)');
    if (!percentStr) throw new Error('PERCENT env var not set (e.g. PERCENT=10)');
    const percent = Number(percentStr);
    if (Number.isNaN(percent) || percent < 0 || percent > 100) throw new Error('PERCENT must be a number 0-100');

    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const brandLower = brand.trim().toLowerCase();
    const codes: string[] = [];
    let scanned = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        if ((row['manufacturer'] || '').trim().toLowerCase() === brandLower) {
            codes.push(row['code']);
        }
    }

    console.log(`Prohledáno ${scanned} produktů, značka "${brand}": nalezeno ${codes.length}.`);
    if (codes.length === 0) {
        console.log('⚠️  Nic nenalezeno — zkontroluj přesný název značky.');
        return;
    }

    const minPriceRatio = (1 - percent / 100).toFixed(4);
    console.log(`Cíl: pricelist ${GUEST_PRICELIST_ID} (Hlavný cenník), minPriceRatio=${minPriceRatio} (strop ${percent}%).`);

    if (!isLive) {
        console.log('DRY RUN — žádný zápis neproběhl. Spusť s --live pro ostrý zápis.');
        console.log('Prvních 10 kódů:', codes.slice(0, 10).join(', '));
        return;
    }

    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
    const client = new ShoptetApiClient(token);

    // Read current pricelist-1 items for these codes first, so we only ever
    // change minPriceRatio and preserve whatever discountCoupon currently is.
    console.log('Načítám aktuální stav pricelistu 1 pro dotčené produkty...');
    const allItems = await client.getPricelistItems(GUEST_PRICELIST_ID);
    const currentByCode = new Map(allItems.map(i => [i.code, i]));

    const snapshotDir = path.resolve('./.snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `brand_cap_rollback_${brand.replace(/[^a-zA-Z0-9]/g, '_')}_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify({
        brand, percent, codes,
        before: codes.map(code => ({ code, sales: currentByCode.get(code)?.sales })),
    }, null, 2), 'utf-8');
    console.log(`[SNAPSHOT] Uložen stav pro rollback: ${snapshotPath}`);

    const items = codes.map(code => {
        const current = currentByCode.get(code);
        return {
            code,
            discountCoupon: current?.sales.discountCoupon ?? false, // preserve, don't touch
            minPriceRatio,
        };
    });

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];
    const BATCH_SIZE = 100;

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        try {
            await client.updatePricelistSalesBatch(GUEST_PRICELIST_ID, batch);
            processed += batch.length;
        } catch (err: any) {
            failed += batch.length;
            errors.push(`batch ${i}-${i + batch.length}: ${err.message}`);
        }
        console.log(`...zpracováno ${processed + failed}/${items.length} (chyby: ${failed})`);
    }

    console.log(`\n=== HOTOVO === Zpracováno: ${processed}, Selhalo: ${failed}`);
    if (errors.length > 0) {
        console.log('Chyby:');
        errors.forEach(e => console.log('  ' + e));
    }
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
