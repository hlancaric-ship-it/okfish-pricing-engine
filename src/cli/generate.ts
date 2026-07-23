import { spawn } from "child_process";
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import Decimal from 'decimal.js';
import { EngineBuilder } from "../core/EngineBuilder.js";
import { CustomerTier } from "../core/interfaces.js";
import { Transform } from "stream";

const CONFIG_PATH = 'src/config/policies/policy-v1.json';

// Pricelist IDs match src/core/config.ts's LOYALTY_TIERS.priceListId (same single
// source of truth for the tier -> Shoptet pricelist ID mapping).
const TIER_MAPPING = [
    { tier: "ZR4" as CustomerTier, id: 2 },
    { tier: "ZR6" as CustomerTier, id: 5 },
    { tier: "ZR8" as CustomerTier, id: 8 },
    { tier: "ZR10" as CustomerTier, id: 11 },
    { tier: "ZR12" as CustomerTier, id: 14 },
    { tier: "ZR14" as CustomerTier, id: 17 },
    { tier: "ZR16" as CustomerTier, id: 20 },
    { tier: "ZR18" as CustomerTier, id: 23 },
    { tier: "ZR20" as CustomerTier, id: 26 },
    { tier: "ZR25" as CustomerTier, id: 29 }
].map(m => ({ ...m, col: `pricelist:${m.id}:price`, includingVatCol: `pricelist:${m.id}:includingVat`, percentVatCol: `pricelist:${m.id}:percentVat` }));

export interface GenerateProductsImportResult {
    totalProducts: number;
    errorsCount: number;
    durationMs: number;
}

// Core CSV pricing pipeline: reads a partner products.csv, computes each loyalty tier's
// price via the shared PricingEngine (EngineBuilder.fromConfig(policy-v1.json) — the
// single source of truth also used by the Worker and generate-xml.ts), and writes a
// products_import.csv with one pricelist:<id>:price column per tier. Deliberately
// separate from customer-tier sync/upload (see the CLI entry point below) so this can
// be exercised in isolation (e.g. by tests) without ever triggering a real network call.
export async function generateProductsImportCsv(
    inputCsvPath: string,
    outputCsvPath: string,
    errorsCsvPath: string
): Promise<GenerateProductsImportResult> {
    const start = performance.now();
    const engine = EngineBuilder.fromConfig(CONFIG_PATH).build();
    const { ValidationEngine } = await import('../core/ValidationEngine.js');
    const validationEngine = new ValidationEngine();

    const outDir = path.dirname(outputCsvPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    let totalProducts = 0;
    let errorsCount = 0;

    const errorStream = stringify({ header: true, delimiter: ';', columns: ['SKU', 'Reason'] });
    const errorFile = fs.createWriteStream(errorsCsvPath);
    errorStream.pipe(errorFile);

    await new Promise<void>((resolve, reject) => {
        const parser = parse({ delimiter: ';', columns: true, skip_empty_lines: true, bom: true });
        const stringifier = stringify({ header: true, delimiter: ';' });

        const transform = new Transform({
            objectMode: true,
            transform(row: any, _encoding: string, callback: any) {
                totalProducts++;

                if ("" in row) delete row[""];

                const applyLoyalty = row.applyLoyaltyDiscount === "1" || row.applyLoyaltyDiscount === "true" || row.applyLoyaltyDiscount === "yes" || row.applyLoyaltyDiscount === true || row.applyLoyaltyDiscount === undefined;

                const parseNumber = (val: any) => {
                    if (!val) return undefined;
                    if (typeof val === 'string') return val.replace(',', '.');
                    return val;
                };

                const parsedBasePrice = parseNumber(row.standardPrice || row.price);
                const parsedSalePrice = parseNumber(row.actionPrice);
                const parsedMaxDiscount = parseNumber(row.maxDiscount);
                const parsedPurchasePrice = parseNumber(row.purchasePrice);

                // Same declarative logic as the confirmed-working manual CSV import test
                // (test_product_46585.csv): tell Shoptet this price already includes VAT
                // via pricelist:<id>:includingVat / pricelist:<id>:percentVat, per pricelist
                // if the source row has it, else falling back to the row's top-level
                // includingVat/percentVat. No VAT math anywhere — values are copied as-is.
                for (const m of TIER_MAPPING) {
                    row[m.includingVatCol] = row[m.includingVatCol] ?? row['includingVat'] ?? '';
                    row[m.percentVatCol] = row[m.percentVatCol] ?? row['percentVat'] ?? '';
                }

                for (const m of TIER_MAPPING) {
                    const input = {
                        sku: row.code,
                        basePrice: new Decimal(parsedBasePrice || 0),
                        salePrice: parsedSalePrice ? new Decimal(parsedSalePrice) : undefined,
                        customerTier: m.tier,
                        allowLoyaltyDiscount: applyLoyalty,
                        productMaxDiscount: parsedMaxDiscount ? new Decimal(parsedMaxDiscount).dividedBy(100) : undefined,
                        manufacturer: row.manufacturer,
                        category: row.categoryText,
                        purchasePrice: parsedPurchasePrice ? new Decimal(parsedPurchasePrice) : undefined,
                        currency: row.currency
                    };

                    try {
                        const inputValidation = validationEngine.validateInput(input);
                        if (!inputValidation.valid) {
                            errorsCount++;
                            errorStream.write({ SKU: input.sku, Reason: inputValidation.reason });
                            row[m.col] = "";
                            continue;
                        }

                        const result = engine.calculatePrice(input);

                        const resultValidation = validationEngine.validateResult(result);
                        if (!resultValidation.valid) {
                            errorsCount++;
                            errorStream.write({ SKU: result.sku, Reason: resultValidation.reason });
                            row[m.col] = "";
                            continue;
                        }

                        if (result.rejected) {
                            errorsCount++;
                            errorStream.write({ SKU: result.sku, Reason: result.rejectReason || 'Unknown error' });
                            row[m.col] = "";
                        } else {
                            row[m.col] = result.finalPrice.toFixed(2).replace('.', ',');
                        }
                    } catch (e: any) {
                        errorsCount++;
                        errorStream.write({ SKU: input.sku, Reason: e.message });
                        row[m.col] = "";
                    }
                }

                const minimalRow: any = { code: row.code };
                for (const m of TIER_MAPPING) {
                    minimalRow[m.col] = row[m.col];
                    minimalRow[m.includingVatCol] = row[m.includingVatCol];
                    minimalRow[m.percentVatCol] = row[m.percentVatCol];
                }

                callback(null, minimalRow);
            }
        });

        const readStream = fs.createReadStream(inputCsvPath);
        const writeStream = fs.createWriteStream(outputCsvPath);

        readStream.pipe(parser).pipe(transform).pipe(stringifier).pipe(writeStream);

        writeStream.on('finish', () => resolve());
        writeStream.on('error', reject);
        readStream.on('error', reject);
    });

    errorStream.end();

    return { totalProducts, errorsCount, durationMs: Math.round(performance.now() - start) };
}

// CLI entry point — only runs when this module is executed directly, never on import
// (so tests can call generateProductsImportCsv() in isolation without ever spawning the
// customers.ts step below, which performs a real uploadToWorker() network call).
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    (async () => {
        const configRaw = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), CONFIG_PATH), 'utf-8'));
        const policyVersion = configRaw.version || 'unknown';
        const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
        const engineVersion = packageJson.version || 'unknown';

        const exportsDir = path.join(process.cwd(), 'exports');
        console.log(`Generating exports/products_import.csv...`);

        const { totalProducts, errorsCount, durationMs } = await generateProductsImportCsv(
            'products.csv',
            path.join(exportsDir, 'products_import.csv'),
            path.join(exportsDir, 'errors.csv')
        );

        fs.writeFileSync(path.join(exportsDir, 'run.json'), JSON.stringify({
            engineVersion, policyVersion, products: totalProducts, generatedPriceLists: 10, errors: errorsCount, durationMs
        }, null, 2));

        console.log(`\nAll 10 price lists appended to exports/products_import.csv successfully!`);
        console.log(`Total products processed: ${totalProducts}`);
        console.log(`Duration: ${(durationMs / 1000).toFixed(2)} s`);

        console.log("\n==============================");
        console.log("Starting customer VIP generation...");
        console.log("==============================\n");

        await new Promise<void>((resolve, reject) => {
            const child = spawn("npx", ["tsx", "src/cli/customers.ts"], { stdio: "inherit", shell: true });
            child.on("close", (code) => {
                if (code === 0) resolve();
                else reject(new Error(`customers.ts failed with code ${code}`));
            });
        });
    })().catch(console.error);
}
