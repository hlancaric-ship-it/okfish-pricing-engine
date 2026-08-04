// Recalculates all 10 tier prices for every product of a given brand using the
// SAME engine as the desktop-app ("calculateAllTierPrices", ported 1:1 from
// cloudflare-worker/src/engine/pricing.ts) and exports a small CSV
// (code;pairCode;pricelist:<id>:price × 10) ready to import back into Shoptet —
// touches only that brand's products, not the full catalog.
//
// Usage: BRAND="VAGNER" npx tsx src/cli/export-brand-recalculated-prices-csv.ts
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { calculateAllTierPrices } = require('../../../desktop-app/lib/pricingEngine.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TIER_TO_PRICELIST_ID } = require('../../../desktop-app/lib/policy.js');

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
    const brand = process.env.BRAND;
    if (!brand) throw new Error('BRAND env var not set (e.g. BRAND=VAGNER)');

    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const brandLower = brand.trim().toLowerCase();
    const tierNames = Object.keys(TIER_TO_PRICELIST_ID);
    const header = ['code', 'pairCode', ...tierNames.map((t: string) => `pricelist:${TIER_TO_PRICELIST_ID[t]}:price`)];
    const rows: string[] = [header.join(';')];
    let matched = 0;
    let scanned = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        if ((row['manufacturer'] || '').trim().toLowerCase() === brandLower) {
            const tierPrices = calculateAllTierPrices(row);
            const cells = [row['code'], row['pairCode'] || ''];
            for (const tier of tierNames) {
                cells.push(String(tierPrices[tier].price));
            }
            rows.push(cells.join(';'));
            matched++;
        }
    }

    console.log(`Prohledáno ${scanned} produktů, značka "${brand}": nalezeno ${matched}, přepočteno enginem.`);

    const outDir = path.resolve('./exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${brand.replace(/[^a-zA-Z0-9]/g, '_')}_recalculated_prices.csv`);
    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`Uloženo: ${outPath} (${matched} řádků)`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
