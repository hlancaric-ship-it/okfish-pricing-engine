import Decimal from "decimal.js";

/**
 * Input for CouponPolicy — deliberately independent of PricingInput/PricingContext.
 * All discount/limit values are ratios (0.20 = 20%), matching the convention used
 * by DiscountLimitPolicy and HighestDiscountPolicy elsewhere in the engine.
 */
export interface CouponPolicyInput {
    /** The product's own current discount (e.g. from an active sale/action price), as a ratio. */
    productDiscount: Decimal;
    /** The customer's loyalty tier discount, as a ratio (0 if the customer has no tier / isn't logged in). */
    customerTierDiscount: Decimal;
    /**
     * The product's individual max-discount limit (ratio), if one is configured.
     * Same source/shape as PricingInput.productMaxDiscount. Undefined = no per-product limit.
     */
    productMaxDiscount?: Decimal;
    /** Customer's loyalty tier name, e.g. "ZR20". Only used to check the ZR20/ZR25 hard block (Rule 4). */
    customerTier?: string;
}

export interface CouponPolicyResult {
    applyDiscountCoupon: 0 | 1;
    /** Remaining discount room available to a coupon, as a ratio (0.05 = 5%). Always 0 when applyDiscountCoupon is 0. */
    maxDiscount: Decimal;
}
