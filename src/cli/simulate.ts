import Decimal from "decimal.js";
import { PricingInput } from "../core/interfaces.js";
import { EngineBuilder } from "../core/EngineBuilder.js";

const engine = EngineBuilder.default()
    .withBrandLimits({})
    .withCategoryLimits({})
    .build();

const input: PricingInput = {
    sku: "93682",
    basePrice: new Decimal("14.94"),
    salePrice: new Decimal("12.70"),
    customerTier: "ZR20",
    productMaxDiscount: new Decimal("0.15"),
    allowLoyaltyDiscount: true
};

const result = engine.calculatePrice(input);

console.log(`SKU: ${result.sku}`);
console.log(`Base price: ${result.originalPrice.toFixed(2)}`);
console.log(`Final: ${result.finalPrice.toFixed(2)}`);
console.log(`Applied rules: ${result.appliedRules.map(r => r.rule).join(' -> ')}`);
