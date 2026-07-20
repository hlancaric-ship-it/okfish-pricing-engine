import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';
import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { writeProductsCsv } from '../src/csv/writer.js';
import { PricingInput } from '../src/core/interfaces.js';
import Decimal from 'decimal.js';
import { ValidationEngine } from '../src/core/ValidationEngine.js';

describe('Golden Dataset Integration', () => {
    const engine = EngineBuilder.fromConfig('src/config/policies/policy-v1.json').build();
    const validationEngine = new ValidationEngine();
    const tiers = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"] as const;
    const fixturesDir = path.resolve('fixtures');
    const expectedDir = path.join(fixturesDir, 'expected');
    
    const files = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.csv'));

    for (const file of files) {
        const fixtureName = path.basename(file, '.csv');
        
        it(`Should match expected output for ${fixtureName}`, async () => {
            const tempDir = fs.mkdtempSync(path.join(process.cwd(), `temp-${fixtureName}-`));
            const products: PricingInput[] = [];

            const parser = fs.createReadStream(path.join(fixturesDir, file)).pipe(parse({
                delimiter: ';',
                columns: true,
                skip_empty_lines: true
            }));

            for await (const row of parser) {
                products.push({
                    sku: row.code,
                    basePrice: new Decimal(row.price),
                    salePrice: row.actionPrice ? new Decimal(row.actionPrice) : undefined,
                    productMaxDiscount: row.maxDiscount ? new Decimal(row.maxDiscount) : undefined,
                    manufacturer: row.manufacturer,
                    category: row.categoryText,
                    allowLoyaltyDiscount: true
                });
            }

            for (const tier of tiers) {
                const results = [];
                for (const product of products) {
                    try {
                        const p = { ...product, customerTier: tier };
                        if (!validationEngine.validateInput(p).valid) continue;
                        const res = engine.calculatePrice(p);
                        if (!validationEngine.validateResult(res).valid) continue;
                        if (!res.rejected) {
                            results.push(res);
                        }
                    } catch (err) {
                        // Ignore throws
                    }
                }
                
                const tempFile = path.join(tempDir, `${tier}.csv`);
                await writeProductsCsv(tempFile, results);
                
                const expectedFile = path.join(expectedDir, fixtureName, `${tier}.csv`);
                const tempContent = fs.readFileSync(tempFile, 'utf8');
                const expectedContent = fs.readFileSync(expectedFile, 'utf8');
                
                expect(tempContent).toBe(expectedContent);
            }

            // Cleanup
            fs.rmSync(tempDir, { recursive: true, force: true });
        });
    }
});
