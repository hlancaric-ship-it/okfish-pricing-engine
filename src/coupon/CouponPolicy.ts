import Decimal from "decimal.js";
import { CouponPolicyInput, CouponPolicyResult } from "./types.js";

/**
 * Standalone coupon-eligibility layer. NOT part of the PricingEngine pipeline —
 * it computes applyDiscountCoupon/maxDiscount as a separate decision, alongside
 * (not inside) the existing price/tier/discount calculations. Wiring this into
 * EngineBuilder/Worker is a deliberate later step, kept out of this class on purpose.
 */
export class CouponPolicy {
    // Defaults match the values this class hardcoded before coupon-policy.json existed
    // (src/config/policies/coupon-policy.json) -- callers that don't pass config get
    // byte-identical behavior, so this stayed a safe, backwards-compatible change.
    private readonly standardLimit: Decimal;
    private readonly lockedTiers: Set<string>;

    constructor(standardLimit: Decimal = new Decimal("0.20"), lockedTiers: Set<string> = new Set(["ZR20", "ZR25"])) {
        this.standardLimit = standardLimit;
        this.lockedTiers = lockedTiers;
    }

    decide(input: CouponPolicyInput): CouponPolicyResult {
        const zero = new Decimal(0);

        // Rule 4 (checked first, absolute precedence) — locked-tier customers never get
        // a coupon, no exceptions, regardless of what any product-level rule would compute.
        if (input.customerTier !== undefined && this.lockedTiers.has(input.customerTier)) {
            return { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 1 — product disallows discounts entirely.
        if (input.productMaxDiscount !== undefined && input.productMaxDiscount.equals(zero)) {
            return { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 2 — product has an individual max-discount limit below the standard ceiling.
        if (input.productMaxDiscount !== undefined && input.productMaxDiscount.lessThan(this.standardLimit)) {
            const currentDiscount = Decimal.max(input.productDiscount, input.customerTierDiscount);
            const remaining = input.productMaxDiscount.minus(currentDiscount);
            return remaining.greaterThan(zero)
                ? { applyDiscountCoupon: 1, maxDiscount: remaining }
                : { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 3 — product's own discount (sale/action price) already at/above the ceiling.
        if (input.productDiscount.greaterThanOrEqualTo(this.standardLimit)) {
            return { applyDiscountCoupon: 0, maxDiscount: zero };
        }

        // Rule 5 — standard case: ceiling minus whichever discount is higher.
        const currentDiscount = Decimal.max(input.productDiscount, input.customerTierDiscount);
        const remaining = this.standardLimit.minus(currentDiscount);
        return remaining.greaterThan(zero)
            ? { applyDiscountCoupon: 1, maxDiscount: remaining }
            : { applyDiscountCoupon: 0, maxDiscount: zero };
    }
}
