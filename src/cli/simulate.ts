import Decimal from "decimal.js";
import { PricingEngine } from "../core/PricingEngine.js";
import { PricingInput } from "../core/interfaces.js";
import { BasePricePolicy } from "../policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../policies/HighestDiscountPolicy.js";
import { ProductMaxDiscountPolicy } from "../policies/ProductMaxDiscountPolicy.js";
import { BrandLimitPolicy } from "../policies/BrandLimitPolicy.js";
import { CategoryLimitPolicy } from "../policies/CategoryLimitPolicy.js";
import { RoundingPolicy } from "../policies/RoundingPolicy.js";
import { ValidatorPolicy } from "../policies/ValidatorPolicy.js";

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

const input: PricingInput = {
    sku: "93682",
    basePrice: new Decimal("14.94"),
    salePrice: new Decimal("12.70"),
    customerTier: "ZR20",
    productMaxDiscount: new Decimal("0.15"),
    allowLoyaltyDiscount: true
};

const context = engine.calculatePrice(input);

console.log(`SKU: ${input.sku}`);
console.log(`Base price: ${input.basePrice.toFixed(2)}`);
console.log(`Sale price: ${input.salePrice?.toFixed(2)}`);
console.log(`Tier: ${input.customerTier}`);
console.log(`Final: ${context.currentPrice.toFixed(2)}`);
const applied = context.appliedPolicies[context.appliedPolicies.length - 1];
console.log(`Applied: ${applied}`);
