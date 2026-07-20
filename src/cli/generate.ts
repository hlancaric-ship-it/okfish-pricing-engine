import { spawn } from "child_process";
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { EngineBuilder } from "../core/EngineBuilder.js";
import { CustomerTier } from "../core/interfaces.js";
import { Transform } from "stream";
import { readFileSync } from 'fs';

import { ValidationEngine } from "../core/ValidationEngine.js";

const TIER_MAPPING = [
    { tier: "ZR4" as CustomerTier, col: "pricelist:2:price" },
    { tier: "ZR6" as CustomerTier, col: "pricelist:5:price" },
    { tier: "ZR8" as CustomerTier, col: "pricelist:8:price" },
    { tier: "ZR10" as CustomerTier, col: "pricelist:11:price" },
    { tier: "ZR12" as CustomerTier, col: "pricelist:14:price" },
    { tier: "ZR14" as CustomerTier, col: "pricelist:17:price" },
    { tier: "ZR16" as CustomerTier, col: "pricelist:20:price" },
    { tier: "ZR18" as CustomerTier, col: "pricelist:23:price" },
    { tier: "ZR20" as CustomerTier, col: "pricelist:26:price" },
    { tier: "ZR25" as CustomerTier, col: "pricelist:29:price" }
];

async function main() {
    const start = performance.now();
    const configPath = 'src/config/policies/policy-v1.json';
    const configRaw = JSON.parse(readFileSync(path.resolve(process.cwd(), configPath), 'utf-8'));
    const policyVersion = configRaw.version || 'unknown';
    
    const packageJson = JSON.parse(readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf-8'));
    const engineVersion = packageJson.version || 'unknown';

    const engine = EngineBuilder.fromConfig(configPath).build();
    const validationEngine = new ValidationEngine();
    
    const exportsDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
    }
    
    let totalProducts = 0;
    let errorsCount = 0;

    const errorStream = stringify({
        header: true,
        delimiter: ';',
        columns: ['SKU', 'Reason']
    });
    
    const errorFile = fs.createWriteStream(path.join(exportsDir, 'errors.csv'));
    errorStream.pipe(errorFile);

    console.log(`Generating exports/products_import.csv...`);
    
    await new Promise((resolve, reject) => {
        const parser = parse({
            delimiter: ';',
            columns: true,
            skip_empty_lines: true,
            bom: true
        });
        
        // No explicit columns - infer from the objects passing through
        const stringifier = stringify({
            header: true,
            delimiter: ';'
        });

        const transform = new Transform({
            objectMode: true,
            transform(row: any, encoding: string, callback: any) {
                totalProducts++;
                
                // Remove empty column caused by trailing semicolon in export
                if ("" in row) {
                    delete row[""];
                }
                
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
                            row[m.col] = ""; // Clear or leave empty on error
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
                
                const minimalRow: any = {
                    code: row.code
                };
                for (const m of TIER_MAPPING) {
                    minimalRow[m.col] = row[m.col];
                }
                
                callback(null, minimalRow);
            }
        });

        const readStream = fs.createReadStream('products.csv');
        const writeStream = fs.createWriteStream(path.join(exportsDir, 'products_import.csv'));
        
        readStream.pipe(parser).pipe(transform).pipe(stringifier).pipe(writeStream);
        
        writeStream.on('finish', () => resolve(true));
        writeStream.on('error', reject);
        readStream.on('error', reject);
    });
    
    errorStream.end();

    const end = performance.now();
    const durationMs = Math.round(end - start);

    const auditLog = {
        engineVersion,
        policyVersion,
        products: totalProducts,
        generatedPriceLists: 10,
        errors: errorsCount,
        durationMs
    };
    fs.writeFileSync(path.join(exportsDir, 'run.json'), JSON.stringify(auditLog, null, 2));
    
    console.log(`\nAll 10 price lists appended to exports/products_import.csv successfully!`);
    console.log(`Total products processed: ${totalProducts}`);
    console.log(`Duration: ${(durationMs / 1000).toFixed(2)} s`);

    console.log("\n==============================");
    console.log("Starting customer VIP generation...");
    console.log("==============================\n");

    await new Promise((resolve, reject) => {
        const child = spawn(
            "npx",
            [
                "tsx",
                "src/cli/customers.ts"
            ],
            {
                stdio: "inherit",
                shell: true
            }
        );

        child.on("close", (code) => {
            if (code === 0) {
                resolve(true);
            } else {
                reject(new Error(`customers.ts failed with code ${code}`));
            }
        });
    });
}

main().catch(console.error);
