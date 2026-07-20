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
    vatRate?: Decimal;
}

export enum RuleType {
    BASE_PRICE = "BASE_PRICE",
    SALE = "SALE",
    LOYALTY = "LOYALTY",
    PRODUCT_LIMIT = "PRODUCT_LIMIT",
    BRAND_LIMIT = "BRAND_LIMIT",
    CATEGORY_LIMIT = "CATEGORY_LIMIT",
    ROUNDING = "ROUNDING",
    VALIDATION = "VALIDATION"
}

export interface SetPriceCommand {
    type: "SET_PRICE";
    price: Decimal;
    rule: RuleType;
    metadata?: string;
}

export interface WarningCommand {
    type: "WARNING";
    message: string;
    rule: RuleType;
}

export interface RejectCommand {
    type: "REJECT";
    reason: string;
    rule: RuleType;
}

export type PricingCommand = SetPriceCommand | WarningCommand | RejectCommand;

// Forward declaration for context
export interface ReadonlyPricingContext {
    readonly input: PricingInput;
    readonly currentPrice: Decimal;
    readonly appliedRules: { rule: RuleType; metadata?: string }[];
}

export interface PricingPolicy {
    readonly name: string;
    readonly priority: number;
    apply(context: ReadonlyPricingContext): PricingCommand | void;
}

export interface PricingResult {
    sku: string;
    originalPrice: Decimal;
    finalPrice: Decimal;
    appliedRules: { rule: RuleType; metadata?: string }[];
    warnings: string[];
    rejected: boolean;
    rejectReason?: string;
}

export interface EngineConfig {
    version: string;
    description?: string;
    loyaltyTiers: Record<string, number>;
    brandLimits?: Record<string, number>;
    categoryLimits?: Record<string, number>;
}
