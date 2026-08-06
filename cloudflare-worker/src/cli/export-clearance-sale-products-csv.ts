// Generates a Shoptet-import-ready CSV that sets an "akční cena" (výpredaj)
// for a fixed, client-supplied list of product codes with their own specific
// % discount each (src/config/policies/clearance-sale-products.json -- 36
// codes, two groups: 22% and 30%, from client Excel
// "Produkty na ktoré sa nabije zlava.xlsx", 2026-08-06).
//
// Writes the plain `actionPrice` column (not per-pricelist sales fields) --
// same mechanism as fix-flat-brand-missing-action.ts. actionPrice is
// authoritative in DiscountLimitPolicy (wins over any brand/product cap, see
// INCIDENTS.md "2026-08-04 VAGNER"), so this naturally propagates to every
// tier via HighestDiscountPolicy without touching pricelist-level fields.
//
// Does NOT yet implement "auto-disable discount when stock hits 0, keep
// listed in clearance" -- that's a separate ongoing automation to be built
// once this initial batch is confirmed live and working.
//
// Client requirement (2026-08-06): no coupon may stack on top of these --
// 22%/30% action price already exceeds the standard 20% coupon ceiling, so
// coupon eligibility is explicitly turned off (applyDiscountCoupon=0) on
// every pricelist incl. GUEST. maxDiscount/minPriceRatio is deliberately
// left UNTOUCHED here (unlike zero-discount-products) -- actionPrice already
// wins outright in DiscountLimitPolicy regardless of any cap, so writing a
// cap value isn't needed and would risk fighting a differently-set brand cap
// for no benefit.
//
// Usage: npx tsx src/cli/export-clearance-sale-products-csv.ts
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

function round2(n: number): string {
    return (Math.round(n * 100) / 100).toFixed(2);
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const listPath = path.resolve(__dirname, '../../../src/config/policies/clearance-sale-products.json');
    const discounts: Record<string, number> = JSON.parse(fs.readFileSync(listPath, 'utf-8'));
    const codes = Object.keys(discounts);
    console.log(`Načteno ${codes.length} kódů z clearance-sale seznamu.`);

    console.log('Stahuji master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../clearance_sale_products_import.csv');
    const tierOrder = Object.entries(ALL_PRICELISTS_MAP);
    const headerCols = ['code', 'pairCode', 'actionPrice'];
    for (const [tier, pricelistId] of tierOrder) {
        if (tier === 'GUEST') {
            headerCols.push('applyDiscountCoupon');
        } else {
            // Shoptet import requires pricelist:<id>:price present for any other
            // per-pricelist column on that pricelist to be accepted at all --
            // include the product's own UNCHANGED current tier price purely to
            // satisfy this (we're not resetting tier prices here, only coupon).
            headerCols.push(`pricelist:${pricelistId}:price`, `pricelist:${pricelistId}:applyDiscountCoupon`);
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
        if (!code || discounts[code] === undefined) continue;
        found.add(code);

        const basePrice = parseFloat((row['price'] || '0').replace(',', '.'));
        if (!basePrice) {
            console.warn(`Přeskakuji ${code} -- chybí nebo je nulová základní cena ve feedu.`);
            continue;
        }
        const pct = discounts[code];
        const actionPrice = round2(basePrice * (1 - pct / 100));
        // ZR25 = stejná jako akční cena, BEZ výjimky -- klient výslovně zrušil
        // dřívější pravidlo "ZR25 smí jít až na 25%" (2026-08-06, po importu):
        // "neni povoleno zvednout slevu na 25". Akční cena platí napříč
        // VŠEMI ceníky stejně, žádná loajalitní přirážka navíc.
        const zr25Price = actionPrice;

        // Klient výslovně chce, aby na ZR4-ZR25 byla VIDĚT stejná akční cena
        // jako v akci/GUEST -- ne stará tierová cena z doby před výpredajem.
        const cols = [code, row['pairCode'] || '', actionPrice];
        for (const [tier] of tierOrder) {
            if (tier === 'GUEST') {
                cols.push('0'); // applyDiscountCoupon=0 -- žádný kupón navíc, action price už přesahuje 20% strop
            } else if (tier === 'ZR25') {
                cols.push(zr25Price, '0');
            } else {
                cols.push(actionPrice, '0');
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
