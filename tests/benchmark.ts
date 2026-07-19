import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { PricingInput } from '../src/core/interfaces.js';
import Decimal from 'decimal.js';

const engine = EngineBuilder.default().build();

const products: PricingInput[] = [];
console.log("Generating 100,000 products...");
for (let i = 0; i < 100000; i++) {
    products.push({
        sku: `SKU-${i}`,
        basePrice: new Decimal(Math.random() * 100 + 10),
        salePrice: Math.random() > 0.5 ? new Decimal(Math.random() * 80 + 5) : undefined,
        customerTier: "ZR20",
        allowLoyaltyDiscount: true,
        productMaxDiscount: new Decimal("0.15")
    });
}

console.log("Starting benchmark...");
const start = performance.now();
for (const product of products) {
    engine.calculatePrice(product);
}
const end = performance.now();

console.log(`Calculated 100,000 prices in ${(end - start).toFixed(2)} ms`);
console.log(`Average: ${((end - start) / 100000).toFixed(4)} ms per product`);
