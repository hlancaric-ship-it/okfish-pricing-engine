import Decimal from "decimal.js";

export type CustomerTier = "ZR4" | "ZR6" | "ZR8" | "ZR10" | "ZR12" | "ZR14" | "ZR16" | "ZR18" | "ZR20" | "ZR25";

export interface PricingInput {
    sku: string;
    basePrice: Decimal;
    salePrice?: Decimal;
    customerTier?: CustomerTier; 
    productMaxDiscount?: Decimal; 
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
