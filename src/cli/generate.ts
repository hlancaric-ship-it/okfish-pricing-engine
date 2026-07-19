import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { PricingEngine } from "../core/PricingEngine.js";
import { BasePricePolicy } from "../policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../policies/HighestDiscountPolicy.js";
import { ProductMaxDiscountPolicy } from "../policies/ProductMaxDiscountPolicy.js";
import { BrandLimitPolicy } from "../policies/BrandLimitPolicy.js";
import { CategoryLimitPolicy } from "../policies/CategoryLimitPolicy.js";
import { RoundingPolicy } from "../policies/RoundingPolicy.js";
import { EngineBuilder } from "../core/EngineBuilder.js";
import { CustomerTier } from "../core/interfaces.js";
import { Transform } from "stream"; '../core/EngineBuilder.js';

async function main() {
    const engine = EngineBuilder.default()
        .withBrandLimits({ "Apple": new Decimal("0.05") })
        .withCategoryLimits({ "Elektronika": new Decimal("0.10") })
        .build();
    
    const exportsDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir);
    }
    
    let tiers: CustomerTier[] = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];
    
    const allArgIndex = process.argv.indexOf('--all');
    const tierArgIndex = process.argv.indexOf('--tier');
    
    if (tierArgIndex !== -1 && tierArgIndex + 1 < process.argv.length) {
        const specificTier = `ZR${process.argv[tierArgIndex + 1]}` as CustomerTier;
        tiers = [specificTier];
    } else if (allArgIndex === -1) {
        console.log("Running for all tiers by default. Use --tier <num> or --all.");
    }
    
    let totalProducts = 0;
    
    for (const tier of tiers) {
        console.log(`Generating exports/${tier}.csv...`);
        
        await new Promise((resolve, reject) => {
            const parser = parse({
                delimiter: ';',
                columns: true,
                skip_empty_lines: true
            });
            
            const stringifier = stringify({
                header: true,
                delimiter: ';',
                columns: [
                    { key: 'Code', header: 'Code' },
                    { key: 'Price', header: 'Price' }
                ]
            });

            const transform = new Transform({
                objectMode: true,
                transform(row: any, encoding: string, callback: any) {
                    if (tier === tiers[0]) totalProducts++;
                    
                    const applyLoyalty = row.applyLoyaltyDiscount === "1" || row.applyLoyaltyDiscount === "true" || row.applyLoyaltyDiscount === "yes" || row.applyLoyaltyDiscount === true;
                    
                    const input = {
                        sku: row.code,
                        basePrice: new Decimal(row.standardPrice || row.price || 0),
                        salePrice: row.actionPrice ? new Decimal(row.actionPrice) : undefined,
                        customerTier: tier,
                        allowLoyaltyDiscount: applyLoyalty,
                        productMaxDiscount: row.maxDiscount ? new Decimal(row.maxDiscount).dividedBy(100) : undefined,
                        manufacturer: row.manufacturer,
                        category: row.categoryText,
                        purchasePrice: row.purchasePrice ? new Decimal(row.purchasePrice) : undefined,
                        currency: row.currency
                    };
                    
                    try {
                        const result = engine.calculatePrice(input);
                        callback(null, { Code: result.sku, Price: result.finalPrice.toFixed(2) });
                    } catch (e: any) {
                        console.error(`Error processing SKU ${input.sku}: ${e.message}`);
                        callback();
                    }
                }
            });

            const readStream = fs.createReadStream('products.csv');
            const writeStream = fs.createWriteStream(path.join(exportsDir, `${tier}.csv`));

            readStream.pipe(parser).pipe(transform).pipe(stringifier).pipe(writeStream);
            
            writeStream.on('finish', () => resolve(true));
            writeStream.on('error', reject);
            readStream.on('error', reject);
        });
    }
    
    const report = {
        generatedAt: new Date().toISOString(),
        products: totalProducts,
        priceLists: tiers.length,
        warnings: 0,
        errors: 0
    };
    
    fs.writeFileSync(path.join(exportsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log("Report generated at exports/report.json");
    console.log("All tiers generated successfully!");
}

main().catch(console.error);
