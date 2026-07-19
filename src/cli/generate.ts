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
    
    const tiers = [4, 6, 8, 10, 12, 14, 16, 18, 20, 25];
    
    for (const tier of tiers) {
        console.log(`Generating ZR${tier}.csv...`);
        const loyaltyDiscount = new Decimal(tier).dividedBy(100);
        
        const results = baseProducts.map(baseProduct => {
            // Clone product and apply current tier discount
            const product = { ...baseProduct, loyaltyDiscount };
            return engine.calculatePrice(product);
        });
        
        await writeProductsCsv(`ZR${tier}.csv`, results);
    }
    
    console.log("All tiers generated successfully!");
}

main().catch(console.error);
