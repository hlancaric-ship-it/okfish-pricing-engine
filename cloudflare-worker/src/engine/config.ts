// Single source of truth for loyalty tiers: src/config/policies/policy-v1.json — the
// exact same file the main Pricing Engine loads via EngineBuilder.fromConfig(). The
// Worker must never define its own copy of the tier list (that's how it drifted out of
// sync with the main engine before: this file used to hardcode ZR4,5,6,7,8,9,10,15,20,25
// while the real policy is ZR4,6,8,10,12,14,16,18,20,25).
import policy from '../../../src/config/policies/policy-v1.json';

// policy-v1.json stores discounts as ratios (0.04 = 4%); this Worker's pricing math
// (engine/pricing.ts) expects plain percentages (4), matching its pre-existing
// `basePrice * (1 - discountPct / 100)` formula — converting the representation here,
// not the actual discount values themselves.
export const LOYALTY_TIERS: Record<string, number> = Object.fromEntries(
    Object.entries(policy.loyaltyTiers).map(([tier, ratio]) => [tier, Math.round(ratio * 1e8) / 1e6])
);

export const TIER_NAMES = Object.keys(LOYALTY_TIERS);

// Same single source of truth for the discount-limit policy — kept as ratios (0.05 =
// 5%) here, matching how engine/pricing.ts's limit math (basePrice * (1 - activeLimit))
// is written, and matching root's DiscountLimitPolicy which consumes these as Decimal
// ratios directly from this same JSON.
export const BRAND_LIMITS: Record<string, number> = policy.brandLimits ?? {};
export const CATEGORY_LIMITS: Record<string, number> = policy.categoryLimits ?? {};
