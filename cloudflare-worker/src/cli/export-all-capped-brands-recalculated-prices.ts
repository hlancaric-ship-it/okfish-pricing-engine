// Recalculates all 10 tier prices for EVERY product of EVERY brand listed in
// policy-v1.json's brandLimits (the full hard-cap group: Lowrance/Humminbird/
// Simrad/Navico at 4%, Mivardi + ~26 others at 10%, plus Apple/Samsung/VAGNER)
// -- so the whole group gets corrected at once instead of product-by-product.
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

function loadPolicyLimits(): { brandLimits: Record<string, number>; categoryLimits: Record<string, number> } {
    const policyPath = path.resolve(__dirname, '../../../src/config/policies/policy-v1.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
    return { brandLimits: policy.brandLimits || {}, categoryLimits: policy.categoryLimits || {} };
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const limits = loadPolicyLimits();
    const brandSet = new Set(Object.keys(limits.brandLimits));
    console.log(`Značky se stropem (${brandSet.size}): ${[...brandSet].join(', ')}`);

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

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
        const manufacturer = (row['manufacturer'] || '').trim();
        if (!brandSet.has(manufacturer)) continue;
        const tierPrices = calculateAllTierPrices(row, limits);
        const cells = [row['code'], row['pairCode'] || ''];
        for (const tier of tierNames) {
            cells.push(String(tierPrices[tier].price));
        }
        rows.push(cells.join(';'));
        matched++;
    }

    console.log(`Prohledáno ${scanned}, přepočteno ${matched} produktů z celé stropové skupiny.`);

    const outDir = path.resolve('./exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `all_capped_brands_recalculated_prices.csv`);
    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`Uloženo: ${outPath} (${matched} řádků)`);
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
