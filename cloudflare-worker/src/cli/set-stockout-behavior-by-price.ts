// Reads the master feed, finds every product with negativeAmount=1 (out of
// stock) and, depending on price, sets:
//   price >= PRICE_THRESHOLD (100 €): orderable ("Na dotaz")
//   price <  PRICE_THRESHOLD:         blocked ("Nedostupné")
// Replaces the earlier blanket disable-negative-stock.ts behavior, which
// disabled ordering for ALL out-of-stock products regardless of price.
//
// Usage:
//   npx tsx src/cli/set-stockout-behavior-by-price.ts            (dry run, just counts)
//   npx tsx src/cli/set-stockout-behavior-by-price.ts --live      (live write)
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';
import { ShoptetApiClient } from '../shoptet-api/client';

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
const PRICE_THRESHOLD = 100; // EUR — nad tuto cenu se produktu vyplatí u dodavatele doobjednat

function parsePrice(val: string | undefined): number | undefined {
    if (!val || val.trim() === '') return undefined;
    const n = Number(val.replace(',', '.').replace(/\s/g, ''));
    return Number.isNaN(n) ? undefined : n;
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    let client: ShoptetApiClient | null = null;
    let onRequestId: number | null = null;
    let unavailableId: number | null = null;

    if (isLive) {
        const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
        if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
        client = new ShoptetApiClient(token);

        const availabilities = await client.getAvailabilities();
        const onRequest = availabilities.find(a => a.name.trim().toLowerCase() === 'na dotaz');
        const unavailable = availabilities.find(a => a.name.trim().toLowerCase() === 'nedostupné');
        if (!onRequest) throw new Error('Dostupnost "Na dotaz" nebyla v Shoptetu nalezena.');
        if (!unavailable) throw new Error('Dostupnost "Nedostupné" nebyla v Shoptetu nalezena.');
        onRequestId = onRequest.id;
        unavailableId = unavailable.id;
        console.log(`Dostupnosti: "Na dotaz" = ${onRequestId}, "Nedostupné" = ${unavailableId}`);
    }

    console.log(`=== ${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'}: nastavuji stockout chování podle ceny (práh ${PRICE_THRESHOLD} €) ===`);

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const onRequestCodes: string[] = [];
    const unavailableCodes: string[] = [];
    let scanned = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        if (scanned === 1 && process.env.DEBUG_FIELDS === '1') {
            console.log('DEBUG feed columns:', Object.keys(row).join(', '));
            console.log('DEBUG first row:', JSON.stringify(row));
        }
        if ((row['negativeAmount'] || '').trim() === '1') {
            const price = parsePrice(row['price'] || row['standardPrice']);
            if (price !== undefined && price >= PRICE_THRESHOLD) {
                onRequestCodes.push(row['code']);
            } else {
                unavailableCodes.push(row['code']);
            }
        }
        if (scanned % 2000 === 0) console.log(`...prohledáno ${scanned} produktů`);
    }

    console.log(`\nProhledáno ${scanned} produktů.`);
    console.log(`  >= ${PRICE_THRESHOLD} € (Na dotaz, objednatelné): ${onRequestCodes.length}`);
    console.log(`  <  ${PRICE_THRESHOLD} € (Nedostupné, blokované): ${unavailableCodes.length}`);

    if (!isLive) {
        console.log('DRY RUN — žádný zápis neproběhl. Spusť s --live pro ostrý zápis.');
        console.log('Prvních 10 "Na dotaz" kódů:', onRequestCodes.slice(0, 10).join(', '));
        console.log('Prvních 10 "Nedostupné" kódů:', unavailableCodes.slice(0, 10).join(', '));
        return;
    }

    const snapshotDir = path.resolve('./.snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `stockout_behavior_rollback_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify({ onRequestCodes, unavailableCodes }, null, 2), 'utf-8');
    console.log(`[SNAPSHOT] Uložen seznam upravovaných kódů: ${snapshotPath}`);

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    const jobs: { code: string; allowed: boolean; availabilityWhenSoldOutId: number }[] = [
        ...onRequestCodes.map(code => ({ code, allowed: true, availabilityWhenSoldOutId: onRequestId! })),
        ...unavailableCodes.map(code => ({ code, allowed: false, availabilityWhenSoldOutId: unavailableId! }))
    ];

    for (const job of jobs) {
        try {
            await client!.updateStockoutBehavior(job.code, job.allowed, job.availabilityWhenSoldOutId);
            processed++;
        } catch (err: any) {
            failed++;
            errors.push(`${job.code}: ${err.message}`);
        }
        if ((processed + failed) % 200 === 0) {
            console.log(`...zpracováno ${processed + failed}/${jobs.length} (chyby: ${failed})`);
        }
    }

    console.log(`\n=== HOTOVO === Zpracováno: ${processed}, Selhalo: ${failed}`);
    if (errors.length > 0) {
        console.log('Prvních 20 chyb:');
        errors.slice(0, 20).forEach(e => console.log('  ' + e));
    }
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
