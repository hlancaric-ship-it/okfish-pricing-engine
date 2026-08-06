// Generates a Shoptet-import-ready CSV for product-level max-discount CAP
// overrides (src/config/policies/product-max-discount-overrides.json --
// {code: percent}), distinct from zero-discount-products (hard 0% block) and
// clearance-sale-products (forced action price). Here we only write
// maxDiscount=<percent> on every pricelist incl. GUEST -- a genuine cap, not
// a forced price and not a coupon block. Product-level cap always wins over
// brand cap in DiscountLimitPolicy (Product -> Brand -> Category priority).
//
// Does NOT touch applyDiscountCoupon or price -- only the cap value changes,
// coupon eligibility and current prices stay whatever they already are.
//
// Confirmed live 2026-08-06 on 101821 (cap 10%): tiers whose natural loyalty
// price is ABOVE the cap floor (base*(1-cap%)) keep their normal price with
// coupon room filled up to the cap (e.g. ZR4 at 4% natural discount got 6%
// coupon room); tiers whose natural price would go BELOW the floor get
// floored to exactly base*(1-cap%) with coupon fully off. This CSV only
// writes the cap value -- the floor/room math above happens automatically in
// DiscountLimitPolicy.ts, no separate logic needed here or in the engine.
//
// Usage: npx tsx src/cli/export-product-max-discount-overrides-csv.ts
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

    const listPath = path.resolve(__dirname, '../../../src/config/policies/product-max-discount-overrides.json');
    const overrides: Record<string, number> = JSON.parse(fs.readFileSync(listPath, 'utf-8'));
    const codes = Object.keys(overrides);
    console.log(`Načteno ${codes.length} kódů z product-max-discount-overrides seznamu.`);

    console.log('Stahuji master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../product_max_discount_overrides_import.csv');
    const tierOrder = Object.entries(ALL_PRICELISTS_MAP);
    const headerCols = ['code', 'pairCode'];
    for (const [tier, pricelistId] of tierOrder) {
        if (tier === 'GUEST') {
            headerCols.push('maxDiscount');
        } else {
            // Shoptet import requires pricelist:<id>:price present for any other
            // per-pricelist column on that pricelist to be accepted at all --
            // include the product's own unchanged current tier price purely to
            // satisfy this (we're not touching price here, only the cap).
            headerCols.push(`pricelist:${pricelistId}:price`, `pricelist:${pricelistId}:maxDiscount`);
        }
    }
    const rows: string[] = [headerCols.join(';')];

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const found = new Set<string>();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code || overrides[code] === undefined) continue;
        found.add(code);

        const pct = overrides[code];
        const cols = [code, row['pairCode'] || ''];
        for (const [tier, pricelistId] of tierOrder) {
            if (tier === 'GUEST') {
                cols.push(String(pct));
            } else {
                const existingTierPrice = row[`pricelist:${pricelistId}:price`] || row['price'] || '';
                cols.push(existingTierPrice, String(pct));
            }
        }
        rows.push(cols.join(';'));
    }

    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');

    const missing = codes.filter(c => !found.has(c));
    console.log(`\nHOTOVO. Zapsáno ${found.size}/${codes.length} kódů. Soubor: ${outPath}`);
    if (missing.length > 0) {
        console.log(`\nPOZOR — ${missing.length} kódů ze seznamu se ve feedu vůbec nenašlo:`);
        console.log(missing.join(', '));
    }
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
