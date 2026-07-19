import Decimal from "decimal.js";

export type CustomerTier = "ZR4" | "ZR6" | "ZR8" | "ZR10" | "ZR12" | "ZR14" | "ZR16" | "ZR18" | "ZR20" | "ZR25";

export interface PricingInput {
    sku: string;
    basePrice: Decimal;
    salePrice?: Decimal;
    customerTier?: CustomerTier;
    allowLoyaltyDiscount?: boolean;
    productMaxDiscount?: Decimal;
    manufacturer?: string;
    category?: string;
    purchasePrice?: Decimal;
    currency?: string;
}

export type CommandType = "SET_PRICE";

export interface PricingCommand {
    type: CommandType;
    price: Decimal;
    reason: string;
}

export interface PricingPolicy {
    readonly name: string;
    readonly priority: number;
    apply(context: any): PricingCommand | void;
}

export interface PricingResult {
    sku: string;
    originalPrice: Decimal;
    finalPrice: Decimal;
    appliedRules: string[];
}
