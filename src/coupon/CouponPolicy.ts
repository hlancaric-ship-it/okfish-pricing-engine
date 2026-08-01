import Decimal from "decimal.js";
import { CouponPolicyInput, CouponPolicyResult } from "./types.js";

/**
 * Standalone coupon-eligibility layer. NOT part of the PricingEngine pipeline —
 * it computes applyDiscountCoupon/maxDiscount as a separate decision, alongside
 * (not inside) the existing price/tier/discount calculations. Wiring this into
 * EngineBuilder/Worker is a deliberate later step, kept out of this class on purpose.
 */
export class CouponPolicy {
    private static readonly STANDARD_LIMIT = new Decimal("0.20");
    private static readonly LOCKED_TIERS = new Set(["ZR20", "ZR25"]);

    decide(input: CouponPolicyInput): CouponPolicyResult {
        const zero = new Decimal(0);

        // Rule 4 (checked first, absolute precedence) — ZR20/ZR25 customers never get a
        // coupon, no exceptions, regardless of what any product-level rule would compute.
        if (input.customerTier !== undefined && CouponPolicy.LOCKED_TIERS.has(input.customerTier)) {
            return { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 1 — product disallows discounts entirely.
        if (input.productMaxDiscount !== undefined && input.productMaxDiscount.equals(zero)) {
            return { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 2 — product has an individual max-discount limit below the standard 20%.
        if (input.productMaxDiscount !== undefined && input.productMaxDiscount.lessThan(CouponPolicy.STANDARD_LIMIT)) {
            const currentDiscount = Decimal.max(input.productDiscount, input.customerTierDiscount);
            const remaining = input.productMaxDiscount.minus(currentDiscount);
            return remaining.greaterThan(zero)
                ? { applyDiscountCoupon: 1, maxDiscount: remaining }
                : { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 3 — product's own discount (sale/action price) already at/above 20%.
        if (input.productDiscount.greaterThanOrEqualTo(CouponPolicy.STANDARD_LIMIT)) {
            return { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 5 — standard case: 20% ceiling minus whichever discount is higher.
        const currentDiscount = Decimal.max(input.productDiscount, input.customerTierDiscount);
        const remaining = CouponPolicy.STANDARD_LIMIT.minus(currentDiscount);
        return remaining.greaterThan(zero)
            ? { applyDiscountCoupon: 1, maxDiscount: remaining }
            : { applyDiscountCoupon: 0, maxDiscount: zero };
    }
}
