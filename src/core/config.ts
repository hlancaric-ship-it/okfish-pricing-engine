export interface LoyaltyTier {
    minTurnover: number;
    maxTurnover: number | null;
    tier: string;
    discount: number;
    customerGroup: string;
    pricelistName: string;
    pricelistPrefix: string;
    groupId: number;
    priceListId: number;
}

export const LOYALTY_TIERS: LoyaltyTier[] = [
    { minTurnover: 10000, maxTurnover: null,    tier: "ZR25", discount: 25, customerGroup: "ZR25", pricelistName: "ZR25", pricelistPrefix: "pricelist:29", groupId: 32, priceListId: 29 },
    { minTurnover: 7000,  maxTurnover: 9999.99, tier: "ZR20", discount: 20, customerGroup: "ZR20", pricelistName: "ZR20", pricelistPrefix: "pricelist:26", groupId: 29, priceListId: 26 },
    { minTurnover: 5000,  maxTurnover: 6999.99, tier: "ZR18", discount: 18, customerGroup: "ZR18", pricelistName: "ZR18", pricelistPrefix: "pricelist:23", groupId: 26, priceListId: 23 },
    { minTurnover: 2000,  maxTurnover: 4999.99, tier: "ZR16", discount: 16, customerGroup: "ZR16", pricelistName: "ZR16", pricelistPrefix: "pricelist:20", groupId: 23, priceListId: 20 },
    { minTurnover: 1000,  maxTurnover: 1999.99, tier: "ZR14", discount: 14, customerGroup: "ZR14", pricelistName: "ZR14", pricelistPrefix: "pricelist:17", groupId: 20, priceListId: 17 },
    { minTurnover: 700,   maxTurnover: 999.99,  tier: "ZR12", discount: 12, customerGroup: "ZR12", pricelistName: "ZR12", pricelistPrefix: "pricelist:14", groupId: 17, priceListId: 14 },
    { minTurnover: 500,   maxTurnover: 699.99,  tier: "ZR10", discount: 10, customerGroup: "ZR10", pricelistName: "ZR10", pricelistPrefix: "pricelist:11", groupId: 14, priceListId: 11 },
    { minTurnover: 300,   maxTurnover: 499.99,  tier: "ZR8",  discount: 8,  customerGroup: "ZR8",  pricelistName: "ZR8",  pricelistPrefix: "pricelist:8",  groupId: 11, priceListId: 8 },
    { minTurnover: 100,   maxTurnover: 299.99,  tier: "ZR6",  discount: 6,  customerGroup: "ZR6",  pricelistName: "ZR6",  pricelistPrefix: "pricelist:5",  groupId: 8,  priceListId: 5 },
    { minTurnover: 0,     maxTurnover: 99.99,   tier: "ZR4",  discount: 4,  customerGroup: "ZR4",  pricelistName: "ZR4",  pricelistPrefix: "pricelist:2",  groupId: 5,  priceListId: 2 }
];

export function getLoyaltyTier(totalOrderValue: number): LoyaltyTier {
    for (const config of LOYALTY_TIERS) {
        if (totalOrderValue >= config.minTurnover) {
            return config;
        }
    }
    // Fallback if somehow negative
    return LOYALTY_TIERS[LOYALTY_TIERS.length - 1];
}
