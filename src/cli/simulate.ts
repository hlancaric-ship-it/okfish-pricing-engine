import Decimal from "decimal.js";
import { PricingEngine } from "../core/PricingEngine.js";
import { Product } from "../core/interfaces.js";
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

const product: Product = {
    sku: "93682",
    basePrice: new Decimal("14.94"),
    salePrice: new Decimal("12.70"),
    loyaltyDiscount: new Decimal("0.20"),
    productLimitDiscount: new Decimal("0.15")
};

const context = engine.calculatePrice(product);

console.log(`SKU: ${product.sku}`);
console.log(`Base price: ${product.basePrice.toFixed(2)}`);
console.log(`Sale price: ${product.salePrice?.toFixed(2)}`);
console.log(`Loyalty: ${product.loyaltyDiscount?.times(100).toNumber()} %`);
console.log(`Product limit: ${product.productLimitDiscount?.times(100).toNumber()} %`);
console.log(`Final: ${context.currentPrice.toFixed(2)}`);
const applied = context.appliedPolicies[context.appliedPolicies.length - 1];
console.log(`Applied: ${applied}`);
