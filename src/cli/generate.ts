import { readProductsCsv } from "../csv/reader.js";
import { writeProductsCsv } from "../csv/writer.js";
import { PricingEngine } from "../core/PricingEngine.js";
import { BasePricePolicy } from "../policies/BasePricePolicy.js";
import { SalePolicy } from "../policies/SalePolicy.js";
import { LoyaltyPolicy } from "../policies/LoyaltyPolicy.js";
import { ProductLimitPolicy } from "../policies/ProductLimitPolicy.js";
import { RoundingPolicy } from "../policies/RoundingPolicy.js";
import { ValidatorPolicy } from "../policies/ValidatorPolicy.js";
import Decimal from "decimal.js";
import * as fs from 'fs';
import * as path from 'path';

async function main() {
    const policies = [
        new BasePricePolicy(),
        new SalePolicy(),
        new LoyaltyPolicy(),
        new ProductLimitPolicy(),
        new RoundingPolicy(),
        new ValidatorPolicy()
    ];
    
    const engine = new PricingEngine(policies);
    
    console.log("Reading products.csv...");
    const baseProducts = await readProductsCsv("products.csv");
    
    const exportsDir = path.join(process.cwd(), 'exports');
    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir);
    }
    
    let tiers = [4, 6, 8, 10, 12, 14, 16, 18, 20, 25];
    const tierArgIndex = process.argv.indexOf('--tier');
    
    if (tierArgIndex !== -1 && tierArgIndex + 1 < process.argv.length) {
        const specificTier = parseInt(process.argv[tierArgIndex + 1], 10);
        if (!isNaN(specificTier)) {
            tiers = [specificTier];
        }
    }
    
    for (const tier of tiers) {
        console.log(`Generating exports/ZR${tier}.csv...`);
        const customerDiscount = new Decimal(tier).dividedBy(100);
        
        const results = baseProducts.map(baseProduct => {
            const input = { ...baseProduct, customerDiscount };
            return engine.calculatePrice(input);
        });
        
        await writeProductsCsv(path.join(exportsDir, `ZR${tier}.csv`), results);
    }
    
    console.log("All tiers generated successfully!");
}

main().catch(console.error);
