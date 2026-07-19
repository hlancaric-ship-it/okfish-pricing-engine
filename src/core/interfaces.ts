import Decimal from "decimal.js";

export interface Product {
    sku: string;
    basePrice: Decimal;
    salePrice?: Decimal;
    loyaltyDiscount?: Decimal; // percentage as 0.X
    productLimitDiscount?: Decimal; // percentage as 0.X
}

export interface IPricingContext {
    product: Product;
    currentPrice: Decimal;
    appliedPolicies: string[];
    addAppliedPolicy(policyName: string): void;
}

export interface IPricingPolicy {
    readonly name: string;
    apply(context: IPricingContext): void;
}
