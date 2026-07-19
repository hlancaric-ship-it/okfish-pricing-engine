import Decimal from "decimal.js";
import { PricingEngine } from "../core/PricingEngine.js";
import { PricingInput } from "../core/interfaces.js";
import { BasePricePolicy } from "../policies/BasePricePolicy.js";
import { SalePolicy } from "../policies/SalePolicy.js";
import { LoyaltyPolicy } from "../policies/LoyaltyPolicy.js";
import { ProductLimitPolicy } from "../policies/ProductLimitPolicy.js";
import { RoundingPolicy } from "../policies/RoundingPolicy.js";
import { ValidatorPolicy } from "../policies/ValidatorPolicy.js";

const policies = [
    new BasePricePolicy(),
    new SalePolicy(),
    new LoyaltyPolicy(),
    new ProductLimitPolicy(),
    new RoundingPolicy(),
    new ValidatorPolicy()
];

const engine = new PricingEngine(policies);

const input: PricingInput = {
    sku: "93682",
    basePrice: new Decimal("14.94"),
    salePrice: new Decimal("12.70"),
    customerDiscount: new Decimal("0.20"),
    productMaxDiscount: new Decimal("0.15"),
    allowLoyaltyDiscount: true
};

const context = engine.calculatePrice(input);

console.log(`SKU: ${input.sku}`);
console.log(`Base price: ${input.basePrice.toFixed(2)}`);
console.log(`Sale price: ${input.salePrice?.toFixed(2)}`);
console.log(`Loyalty: ${input.customerDiscount?.times(100).toNumber()} %`);
console.log(`Product limit: ${input.productMaxDiscount?.times(100).toNumber()} %`);
console.log(`Final: ${context.currentPrice.toFixed(2)}`);
const applied = context.appliedPolicies[context.appliedPolicies.length - 1];
console.log(`Applied: ${applied}`);
