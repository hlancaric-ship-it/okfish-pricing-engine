// Generates products_import.csv (Shoptet native CSV import format, all 10
// pricelist:<id>:price columns) for ONLY products whose name contains one of
// DELPHIN BOMB / DELPHIN / MIVARDI / MIKADO -- not the full catalog.
//
// Why this exists (2026-08-15): force-recalc-brands-live.ts (cloudflare-worker/
// src/cli/) hit Shoptet's PATCH /pricelists/{id} endpoint returning HTTP 200 while
// silently not creating a record for products that never had one on a given
// pricelist -- confirmed against Shoptet's own OpenAPI spec (shoptet_openapi.json),
// which describes that endpoint as "Update pricelist", not create. The CSV import
// path (this script's output, uploaded manually via Shoptet admin -> Produkty ->
// Import) is the confirmed-working mechanism for FIRST-TIME pricelist creation
// (see generate.ts's own comment referencing test_product_46585.csv). Over 5000
// of the ~5613 brand-matched products hit this gap, so this generates the subset
// CSV for all of them, not a hand-picked list.
//
// Deliberately does NOT touch the full-catalog exports/products_import.csv, and
// does NOT spawn customers.ts (unlike npm run generate) -- this is scoped purely
// to the pricelist-creation gap for these four brands.
//
// Usage: npx tsx src/cli/generate-brands-subset.ts
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { generateProductsImportCsv } from './generate.js';

// Longest/most specific first -- "DELPHIN BOMB" must be checked before the plain
// "DELPHIN" substring, same convention as force-recalc-brands-live.ts.
const BRAND_NAME_MATCHERS = ['DELPHIN BOMB', 'DELPHIN', 'MIVARDI', 'MIKADO'];

function matchBrand(productName: string): string | undefined {
    const upper = (productName || '').toUpperCase();
    return BRAND_NAME_MATCHERS.find((b) => upper.includes(b));
}

async function filterProductsCsv(inputPath: string, outputPath: string): Promise<{ total: number; matched: number; byBrand: Record<string, number> }> {
    const content = fs.readFileSync(inputPath);
    const records: Record<string, string>[] = await new Promise((resolve, reject) => {
        parse(content, { delimiter: ';', columns: true, skip_empty_lines: true, bom: true }, (err, out) => {
            if (err) reject(err);
            else resolve(out);
        });
    });

    const byBrand: Record<string, number> = {};
    const matched = records.filter((row) => {
        const brand = matchBrand(row.name);
        if (!brand) return false;
        byBrand[brand] = (byBrand[brand] || 0) + 1;
        return true;
    });

    const columns = Object.keys(records[0] || {});
    const csv: string = await new Promise((resolve, reject) => {
        stringify(matched, { delimiter: ';', header: true, columns, bom: true }, (err, out) => {
            if (err) reject(err);
            else resolve(out);
        });
    });
    fs.writeFileSync(outputPath, csv);

    return { total: records.length, matched: matched.length, byBrand };
}

async function main() {
    const exportsDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportsDir)) fs.mkdirSync(exportsDir, { recursive: true });

    const filteredInputPath = path.join(exportsDir, 'products_brands_subset_input.csv');
    console.log(`Filtering products.csv for brands: ${BRAND_NAME_MATCHERS.join(', ')} (match by product NAME)...`);
    const { total, matched, byBrand } = await filterProductsCsv('products.csv', filteredInputPath);

    console.log(`\nCelkem v products.csv: ${total} produktů.`);
    console.log(`Odpovídá vybraným značkám: ${matched}`);
    for (const [brand, count] of Object.entries(byBrand)) console.log(`  ${brand}: ${count}`);

    if (matched === 0) {
        console.log('\nŽádné produkty neodpovídají -- nic ke generování.');
        return;
    }

    console.log(`\nGenerating exports/products_import_brands_subset.csv (only these ${matched} produktů)...`);
    const { totalProducts, errorsCount, durationMs } = await generateProductsImportCsv(
        filteredInputPath,
        path.join(exportsDir, 'products_import_brands_subset.csv'),
        path.join(exportsDir, 'errors_brands_subset.csv')
    );

    console.log(`\nHotovo. Zpracováno: ${totalProducts}, chyby: ${errorsCount}, trvání: ${(durationMs / 1000).toFixed(2)}s`);
    console.log(`Výstup: exports/products_import_brands_subset.csv -- nahraj ručně přes Shoptet admin -> Produkty -> Import.`);
    if (errorsCount > 0) {
        console.log(`Pozor: ${errorsCount} produktů skončilo s chybou -- viz exports/errors_brands_subset.csv, tyhle NEBUDOU v importním CSV.`);
    }
}

main().catch((e) => {
    console.error('CHYBA:', e);
    process.exit(1);
});
