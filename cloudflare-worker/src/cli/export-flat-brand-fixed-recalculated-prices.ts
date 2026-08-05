// Recalculates all 10 tier prices for the 17 Delphin products whose no-op
// (missing) action price was just fixed via CSV import -- their "Cena"
// column in the "Jiné ceníky" table was stale (still reflecting the old,
// tier-only pricing) even after the Akční cena field itself was corrected.
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

    const codesPath = path.resolve(__dirname, 'data/flat-brand-fixed-codes.json');
    const codes: string[] = JSON.parse(fs.readFileSync(codesPath, 'utf-8'));
    const codeSet = new Set(codes);

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    const limits = loadPolicyLimits();

    const tierNames = Object.keys(TIER_TO_PRICELIST_ID);
    const header = ['code', 'pairCode', ...tierNames.map((t: string) => `pricelist:${TIER_TO_PRICELIST_ID[t]}:price`)];
    const rows: string[] = [header.join(';')];
    let matched = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        if (!codeSet.has(row['code'])) continue;
        const tierPrices = calculateAllTierPrices(row, limits);
        const cells = [row['code'], row['pairCode'] || ''];
        for (const tier of tierNames) cells.push(String(tierPrices[tier].price));
        rows.push(cells.join(';'));
        matched++;
    }

    console.log(`Přepočteno ${matched} z ${codeSet.size}.`);
    const outDir = path.resolve('./exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `flat_brand_fixed_recalculated_prices.csv`);
    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`Uloženo: ${outPath}`);
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
