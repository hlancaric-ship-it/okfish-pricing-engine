import Decimal from "decimal.js";
import { CouponPolicy } from "../../../src/coupon/CouponPolicy.js";
import { TIER_PRICELIST_MAP, GUEST_PRICELIST_ID } from "./tier-pricelist-map.js";
import {
    COUPON_STANDARD_LIMIT,
    COUPON_LOCKED_TIERS,
    COUPON_DISABLED_BRANDS,
    COUPON_DISABLED_PRODUCTS
} from "./coupon-config.js";

export interface ProductCouponInput {
    code: string;
    /** Base (standard) price. */
    basePrice: Decimal;
    /** Current action/sale price, if any — used to derive productDiscount. */
    actionPrice?: Decimal;
    /** Product's own max-discount limit (ratio 0-1), same source as PricingInput.productMaxDiscount. */
    productMaxDiscount?: Decimal;
    /** Manufacturer/brand name, for brandLimits fallback — same field DiscountLimitPolicy reads. */
    manufacturer?: string;
    /** Category name, for categoryLimits fallback — same field DiscountLimitPolicy reads. */
    category?: string;
    /**
     * Same semantics as PricingInput.allowLoyaltyDiscount elsewhere in the engine:
     * explicit `false` means this product (e.g. a gift card) must never receive a
     * loyalty-tier discount. Missing/undefined defaults to allowed — same
     * "absent = allowed, only explicit falsy turns it off" convention used by
     * src/cli/generate.ts's applyLoyalty and engine/pricing.ts's
     * resolveAllowLoyaltyDiscount(), so a product with no opinion on this field
     * isn't wrongly treated as loyalty-ineligible.
     */
    allowLoyaltyDiscount?: boolean;
}

/**
 * Mirrors src/policies/DiscountLimitPolicy.ts's hierarchical fallback EXACTLY:
 * Product -> Brand -> Category -> None. That policy is the real, live price-clamping
 * logic — if the coupon layer used a different (or missing) hierarchy here, it could
 * grant coupon room the pricing engine would never actually allow (e.g. an Apple
 * product with no per-item override falling through to the default 20% ceiling
 * instead of the real 5% brand cap).
 */
function resolveEffectiveLimit(
    product: ProductCouponInput,
    brandLimits: Record<string, Decimal>,
    categoryLimits: Record<string, Decimal>
): Decimal | undefined {
    if (product.productMaxDiscount !== undefined) return product.productMaxDiscount;
    if (product.manufacturer && brandLimits[product.manufacturer] !== undefined) return brandLimits[product.manufacturer];
    if (product.category && categoryLimits[product.category] !== undefined) return categoryLimits[product.category];
    return undefined;
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
    effectiveLimit: Decimal | undefined,
    productDiscount: Decimal,
    tier: string,
    pricelistId: number,
    rawTierDiscount: Decimal,
    /** undefined for guests — CouponPolicy's ZR20/ZR25 lock (Rule 4) must never apply to them. */
    customerTier: string | undefined,
    /** True when this product's brand or code is on the manual coupon-off list
     * (coupon-policy.json, editable from the admin app) -- short-circuits straight
     * to "no coupon" before CouponPolicy.decide() even runs, same end result as
     * Rule 1 (productMaxDiscount === 0) but driven by a separate on/off switch
     * rather than a discount ceiling. */
    couponDisabled: boolean
): CouponWriteItem {
    if (couponDisabled) {
        return { code: product.code, tier, pricelistId, applyDiscountCoupon: false, minPriceRatio: new Decimal(1) };
    }

    // The real (untouched) PricingEngine clamps both the action price and the
    // loyalty price to the effective limit (product -> brand -> category, same
    // hierarchy as DiscountLimitPolicy) via DiscountLimitPolicy — so the discount a
    // customer can ACTUALLY receive on this product never exceeds that limit, even
    // if their raw tier % is higher. Mirror that clamp here so the coupon's price
    // floor matches what the engine really produces, not an unclamped/unreachable
    // number.
    const clampedProductDiscount = effectiveLimit !== undefined
        ? Decimal.min(productDiscount, effectiveLimit)
        : productDiscount;
    const clampedTierDiscount = effectiveLimit !== undefined
        ? Decimal.min(rawTierDiscount, effectiveLimit)
        : rawTierDiscount;

    const decision = policy.decide({
        productDiscount: clampedProductDiscount,
        customerTierDiscount: clampedTierDiscount,
        productMaxDiscount: effectiveLimit,
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
    loyaltyTiers: Record<string, Decimal>,
    brandLimits: Record<string, Decimal> = {},
    categoryLimits: Record<string, Decimal> = {},
    // Defaults read straight from coupon-policy.json (the file the admin app edits) --
    // omitting these params gives every existing call site the current, live-configured
    // behavior automatically, not the pre-coupon-policy.json hardcoded values.
    standardLimit: Decimal = COUPON_STANDARD_LIMIT,
    lockedTiers: Set<string> = COUPON_LOCKED_TIERS,
    disabledBrands: Set<string> = COUPON_DISABLED_BRANDS,
    disabledProducts: Set<string> = COUPON_DISABLED_PRODUCTS
): CouponWriteItem[] {
    const policy = new CouponPolicy(standardLimit, lockedTiers);
    const productDiscount = computeProductDiscount(product.basePrice, product.actionPrice);
    const effectiveLimit = resolveEffectiveLimit(product, brandLimits, categoryLimits);
    const couponDisabled =
        disabledProducts.has(product.code) ||
        (!!product.manufacturer && disabledBrands.has(product.manufacturer.toUpperCase()));
    const items: CouponWriteItem[] = [];

    // Same "absent = allowed" convention as engine/pricing.ts's resolveAllowLoyaltyDiscount().
    const loyaltyDiscountAllowed = product.allowLoyaltyDiscount !== false;

    for (const [tier, pricelistId] of Object.entries(TIER_PRICELIST_MAP)) {
        const rawTierDiscount = loyaltyDiscountAllowed ? (loyaltyTiers[tier] ?? new Decimal(0)) : new Decimal(0);
        items.push(computeItem(policy, product, effectiveLimit, productDiscount, tier, pricelistId, rawTierDiscount, tier, couponDisabled));
    }

    items.push(computeItem(policy, product, effectiveLimit, productDiscount, "GUEST", GUEST_PRICELIST_ID, new Decimal(0), undefined, couponDisabled));

    return items;
}
