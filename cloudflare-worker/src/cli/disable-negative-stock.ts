// Reads the master feed, finds every product with negativeAmount=1 (backorder
// allowed), and disables it (negativeStockAllowed=false) via
// PATCH /api/products/code/{code}. Defaults to DRY RUN — pass --live to write
// for real.
//
// Usage:
//   npx tsx src/cli/disable-negative-stock.ts            (dry run, just counts)
//   npx tsx src/cli/disable-negative-stock.ts --live      (live write)
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

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    let client: ShoptetApiClient | null = null;
    if (isLive) {
        const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
        if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
        client = new ShoptetApiClient(token);
    }

    console.log(`=== ${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'}: vypínám negativeStockAllowed ===`);

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const codes: string[] = [];
    let scanned = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        if ((row['negativeAmount'] || '').trim() === '1') {
            codes.push(row['code']);
        }
        if (scanned % 2000 === 0) console.log(`...prohledáno ${scanned} produktů`);
    }

    console.log(`\nProhledáno ${scanned} produktů, nalezeno ${codes.length} s negativeAmount=1.`);

    if (!isLive) {
        console.log('DRY RUN — žádný zápis neproběhl. Spusť s --live pro ostrý zápis.');
        console.log('Prvních 10 kódů pro kontrolu:', codes.slice(0, 10).join(', '));
        return;
    }

    // Snapshot before writing, for potential rollback.
    const snapshotDir = path.resolve('./.snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `negative_stock_rollback_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify({ codes }, null, 2), 'utf-8');
    console.log(`[SNAPSHOT] Uložen seznam upravovaných kódů: ${snapshotPath}`);

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const code of codes) {
        try {
            await client!.updateNegativeStockAllowed(code, false);
            processed++;
        } catch (err: any) {
            failed++;
            errors.push(`${code}: ${err.message}`);
        }
        if ((processed + failed) % 200 === 0) {
            console.log(`...zpracováno ${processed + failed}/${codes.length} (chyby: ${failed})`);
        }
    }

    console.log(`\n=== HOTOVO === Zpracováno: ${processed}, Selhalo: ${failed}`);
    if (errors.length > 0) {
        console.log('Prvních 20 chyb:');
        errors.slice(0, 20).forEach(e => console.log('  ' + e));
    }
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
