import Decimal from "decimal.js";
import { PricingEngine } from "../core/PricingEngine.js";
import { PricingInput } from "../core/interfaces.js";
import { BasePricePolicy } from "../policies/BasePricePolicy.js";
import { HighestDiscountPolicy } from "../policies/HighestDiscountPolicy.js";
import { ProductMaxDiscountPolicy } from "../policies/ProductMaxDiscountPolicy.js";
import { BrandLimitPolicy } from "../policies/BrandLimitPolicy.js";
import { CategoryLimitPolicy } from "../policies/CategoryLimitPolicy.js";
import { RoundingPolicy } from "../policies/RoundingPolicy.js";

const engine = new PricingEngine();
engine.use(new BasePricePolicy());
engine.use(new HighestDiscountPolicy());
engine.use(new ProductMaxDiscountPolicy());
engine.use(new BrandLimitPolicy({}));
engine.use(new CategoryLimitPolicy({}));
engine.use(new RoundingPolicy());

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
console.log(`Applied rules: ${result.appliedRules.join(' -> ')}`);
