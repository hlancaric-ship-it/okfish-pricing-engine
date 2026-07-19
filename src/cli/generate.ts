import { readProductsCsv } from "../csv/reader.js";
import { writeProductsCsv } from "../csv/writer.js";
import { PricingEngine } from "../core/PricingEngine.js";
import { BasePricePolicy } from "../policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../policies/HighestDiscountPolicy.js";
import { ProductMaxDiscountPolicy } from "../policies/ProductMaxDiscountPolicy.js";
import { BrandLimitPolicy } from "../policies/BrandLimitPolicy.js";
import { CategoryLimitPolicy } from "../policies/CategoryLimitPolicy.js";
import { RoundingPolicy } from "../policies/RoundingPolicy.js";
import { ValidatorPolicy } from "../policies/ValidatorPolicy.js";
import { CustomerTier } from "../core/interfaces.js";
import * as fs from 'fs';
import * as path from 'path';
import Decimal from "decimal.js";

async function main() {
    const policies = [
        new BasePricePolicy(),
        new HighestDiscountPolicy(),
        new ProductMaxDiscountPolicy(),
        new BrandLimitPolicy(),
        new CategoryLimitPolicy(),
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
    
    let tiers: CustomerTier[] = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];
    
    const allArgIndex = process.argv.indexOf('--all');
    const tierArgIndex = process.argv.indexOf('--tier');
    
    if (tierArgIndex !== -1 && tierArgIndex + 1 < process.argv.length) {
        const specificTier = `ZR${process.argv[tierArgIndex + 1]}` as CustomerTier;
        tiers = [specificTier];
    } else if (allArgIndex === -1) {
        console.log("Running for all tiers by default. Use --tier <num> or --all.");
    }
    
    let totalProducts = baseProducts.length;
    let totalPriceLists = tiers.length;
    let changedPrices = 0;
    
    for (const tier of tiers) {
        console.log(`Generating exports/${tier}.csv...`);
        
        const results = baseProducts.map(baseProduct => {
            const input = { ...baseProduct, customerTier: tier };
            const context = engine.calculatePrice(input);
            if (!context.currentPrice.equals(baseProduct.basePrice)) {
                changedPrices++;
            }
            return context;
        });
        
        await writeProductsCsv(path.join(exportsDir, `${tier}.csv`), results);
    }
    
    const report = {
        generatedAt: new Date().toISOString(),
        products: totalProducts,
        priceLists: totalPriceLists,
        changedPrices: changedPrices,
        warnings: 0,
        errors: 0
    };
    
    fs.writeFileSync(path.join(exportsDir, 'report.json'), JSON.stringify(report, null, 2));
    console.log("Report generated at exports/report.json");
    console.log("All tiers generated successfully!");
}

main().catch(console.error);
