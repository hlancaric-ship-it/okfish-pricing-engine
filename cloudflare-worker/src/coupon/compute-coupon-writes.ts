import Decimal from "decimal.js";
import { CouponPolicy } from "../../../src/coupon/CouponPolicy.js";
import { TIER_PRICELIST_MAP, GUEST_PRICELIST_ID } from "./tier-pricelist-map.js";

export interface ProductCouponInput {
    code: string;
    /** Base (standard) price. */
    basePrice: Decimal;
    /** Current action/sale price, if any — used to derive productDiscount. */
    actionPrice?: Decimal;
    /** Product's own max-discount limit (ratio 0-1), same source as PricingInput.productMaxDiscount. */
    productMaxDiscount?: Decimal;
}

export interface CouponWriteItem {
    code: string;
    tier: string;
    pricelistId: number;
    applyDiscountCoupon: boolean;
    /**
     * The Shoptet `sales.minPriceRatio` value to write for this pricelist item:
     * 1 - maxDiscount, i.e. the floor relative to THIS pricelist's own (already
     * tier-discounted) price — not relative to the global base price. Each tier's
     * pricelist item already bakes in that tier's discount as its own price, so
     * minPriceRatio here represents only the coupon's OWN remaining room on top
     * of that, not the combined tier+coupon total. When applyDiscountCoupon is
     * false, this is 1.0000 (coupon may not reduce the price at all).
     */
    minPriceRatio: Decimal;
}

/** Ratio of how much the action/sale price already discounts off the base price, clamped to [0, 1]. */
function computeProductDiscount(basePrice: Decimal, actionPrice: Decimal | undefined): Decimal {
    if (!actionPrice || basePrice.lessThanOrEqualTo(0) || actionPrice.greaterThanOrEqualTo(basePrice)) {
        return new Decimal(0);
    }
    const discount = new Decimal(1).minus(actionPrice.dividedBy(basePrice));
    return Decimal.max(discount, new Decimal(0));
}

function computeItem(
    policy: CouponPolicy,
    product: ProductCouponInput,
    productDiscount: Decimal,
    tier: string,
    pricelistId: number,
    rawTierDiscount: Decimal,
    /** undefined for guests — CouponPolicy's ZR20/ZR25 lock (Rule 4) must never apply to them. */
    customerTier: string | undefined
): CouponWriteItem {
    // The real (untouched) PricingEngine clamps both the action price and the
    // loyalty price to the product's own limit via DiscountLimitPolicy — so the
    // discount a customer can ACTUALLY receive on this product never exceeds
    // productMaxDiscount, even if their raw tier % is higher. Mirror that clamp
    // here so the coupon's price floor matches what the engine really produces,
    // not an unclamped/unreachable number.
    const clampedProductDiscount = product.productMaxDiscount !== undefined
        ? Decimal.min(productDiscount, product.productMaxDiscount)
        : productDiscount;
    const clampedTierDiscount = product.productMaxDiscount !== undefined
        ? Decimal.min(rawTierDiscount, product.productMaxDiscount)
        : rawTierDiscount;

    const decision = policy.decide({
        productDiscount: clampedProductDiscount,
        customerTierDiscount: clampedTierDiscount,
        productMaxDiscount: product.productMaxDiscount,
        customerTier
    });

    const minPriceRatio = new Decimal(1).minus(decision.maxDiscount);

    return {
        code: product.code,
        tier,
        pricelistId,
        applyDiscountCoupon: decision.applyDiscountCoupon === 1,
        minPriceRatio
    };
}

/**
 * Computes, for a single product, the coupon write payload for every loyalty
 * tier's pricelist PLUS the guest ("Hlavný cenník") pricelist for non-logged-in
 * customers — using the existing (untouched) CouponPolicy for the eligibility
 * decision. Pure function: no I/O, no API calls, easy to unit test.
 *
 * Guests have 0% loyalty discount and are never subject to the ZR20/ZR25 lock
 * (Rule 4) — they're simply capped by the same 20% ceiling (or the product's
 * own lower limit) as any other non-locked tier, same math as Rule 2/5.
 */
export function computeCouponWrites(
    product: ProductCouponInput,
    loyaltyTiers: Record<string, Decimal>
): CouponWriteItem[] {
    const policy = new CouponPolicy();
    const productDiscount = computeProductDiscount(product.basePrice, product.actionPrice);
    const items: CouponWriteItem[] = [];

    for (const [tier, pricelistId] of Object.entries(TIER_PRICELIST_MAP)) {
        const rawTierDiscount = loyaltyTiers[tier] ?? new Decimal(0);
        items.push(computeItem(policy, product, productDiscount, tier, pricelistId, rawTierDiscount, tier));
    }

    items.push(computeItem(policy, product, productDiscount, "GUEST", GUEST_PRICELIST_ID, new Decimal(0), undefined));

    return items;
}
