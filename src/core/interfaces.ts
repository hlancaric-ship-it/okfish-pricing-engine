import Decimal from "decimal.js";

export interface PricingInput {
    sku: string;
    basePrice: Decimal;
    salePrice?: Decimal;
    customerDiscount?: Decimal; // percentage as 0.X
    productMaxDiscount?: Decimal; // percentage as 0.X
    manufacturer?: string;
    category?: string;
    purchasePrice?: Decimal;
    currency?: string;
    vatRate?: Decimal;
    allowLoyaltyDiscount: boolean;
}

export interface IPricingContext {
    input: PricingInput;
    currentPrice: Decimal;
    appliedPolicies: string[];
    addAppliedPolicy(policyName: string): void;
}

export interface IPricingPolicy {
    readonly name: string;
    apply(context: IPricingContext): void;
}
