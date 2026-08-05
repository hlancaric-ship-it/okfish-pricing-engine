// Generates a Shoptet-import-ready CSV that CLEARS (leaves empty) the
// "Maximální povolená sleva" / max-discount fields on EVERY pricelist
// (GUEST + all 10 ZR tiers) for a hardcoded list of "flat action price,
// no cap at all" brands.
//
// WHY: these brands (Mikado 9%, Delphin 15%, Delphin BOMB 15%, Mivardi 10%)
// get their discount entirely from the product's own Akční cena (action
// price) — confirmed 2026-08-05 by the client ("ma 9% akcni cenu nema
// strop chapes!!!" — has a 9% action price, has NO cap, understand?).
// No coupon/loyalty-discount ceiling should apply on top at all; Shoptet's
// native (unrestricted) behavior should govern any additional coupon use.
//
// A prior CSV import had accidentally written 0% (checkbox CHECKED with
// value 0) instead of leaving the field truly empty/unchecked — checked-0
// blocks ALL additional discount, which is the opposite of "no cap".
// Writing an EMPTY cell via CSV import is the only way to produce the
// true "unchecked" state — the live API (PATCH) cannot express this, it
// only accepts a numeric minPriceRatio, so this MUST go through Shoptet's
// own import.
//
// Usage: npx tsx src/cli/export-clear-cap-for-brands-csv.ts
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

const NO_CAP_BRANDS = new Set(['DELPHIN', 'DELPHIN BOMB', 'MIKADO', 'MIVARDI']);

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../clear_cap_no_cap_brands.csv');
    const out = fs.createWriteStream(outPath);

    const tierOrder = Object.entries(ALL_PRICELISTS_MAP);
    const headerCols = ['code', 'pairCode'];
    for (const [tier, pricelistId] of tierOrder) {
        if (tier === 'GUEST') {
            headerCols.push('applyDiscountCoupon', 'maxDiscount');
        } else {
            // price column still required for the pricelist:X:* columns to be
            // accepted at all — Shoptet silently drops them otherwise.
            headerCols.push(`pricelist:${pricelistId}:price`, `pricelist:${pricelistId}:applyDiscountCoupon`, `pricelist:${pricelistId}:maxDiscount`);
        }
    }
    out.write(headerCols.join(';') + '\n');

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    let scanned = 0;
    let matched = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code) continue;
        scanned++;

        const manufacturer = (row['manufacturer'] || '').trim().toUpperCase();
        if (!NO_CAP_BRANDS.has(manufacturer)) continue;
        matched++;

        // action price if set, else standard price — same value already live,
        // included only to satisfy Shoptet's "price column required" import quirk.
        const price = row['actionPrice'] && row['actionPrice'].trim() !== ''
            ? row['actionPrice']
            : (row['price'] || row['standardPrice'] || '');

        const cols = [code, row['pairCode'] || ''];
        for (const [tier] of tierOrder) {
            if (tier === 'GUEST') {
                cols.push('', ''); // applyDiscountCoupon, maxDiscount — both empty
            } else {
                cols.push(price, '', ''); // price required, coupon fields empty
            }
        }
        out.write(cols.join(';') + '\n');
    }

    out.end();
    console.log(`Prohledáno ${scanned} produktů, značky bez stropu (${[...NO_CAP_BRANDS].join(', ')}): ${matched} produktů.`);
    console.log(`Soubor: ${outPath}`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
