import Decimal from "decimal.js";
import { PricingInput } from "../core/interfaces.js";
import { EngineBuilder } from "../core/EngineBuilder.js";

import { ValidationEngine } from "../core/ValidationEngine.js";

const engine = EngineBuilder.fromConfig('src/config/policies/policy-v1.json').build();
const validationEngine = new ValidationEngine();

const input: PricingInput = {
    sku: "93682",
    basePrice: new Decimal("14.94"),
    salePrice: new Decimal("12.70"),
    customerTier: "ZR20",
    productMaxDiscount: new Decimal("0.15"),
    allowLoyaltyDiscount: true
};

const inputVal = validationEngine.validateInput(input);
if (!inputVal.valid) {
    console.error(`Input rejected: ${inputVal.reason}`);
    process.exit(1);
}

const result = engine.calculatePrice(input);

const resultVal = validationEngine.validateResult(result);
if (!resultVal.valid) {
    console.error(`Result rejected: ${resultVal.reason}`);
    process.exit(1);
}

console.log(`SKU: ${result.sku}`);
console.log(`Base price: ${result.originalPrice.toFixed(2)}`);
console.log(`Final: ${result.finalPrice.toFixed(2)}`);
console.log(`Applied rules: ${result.appliedRules.map(r => r.rule).join(' -> ')}`);
