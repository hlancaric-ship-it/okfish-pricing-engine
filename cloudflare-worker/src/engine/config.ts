// Single source of truth for loyalty tiers: src/config/policies/policy-v1.json — the
// exact same file the main Pricing Engine loads via EngineBuilder.fromConfig(). The
// Worker must never define its own copy of the tier list (that's how it drifted out of
// sync with the main engine before: this file used to hardcode ZR4,5,6,7,8,9,10,15,20,25
// while the real policy is ZR4,6,8,10,12,14,16,18,20,25).
import policy from '../../../src/config/policies/policy-v1.json';
import productMaxDiscountOverrides from '../../../src/config/policies/product-max-discount-overrides.json';
import zeroDiscountProducts from '../../../src/config/policies/zero-discount-products.json';
import clearanceSaleProducts from '../../../src/config/policies/clearance-sale-products.json';

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

// Product-level overrides -- highest priority, always beat brand/category (see
// DiscountLimitPolicy.ts's Product -> Brand -> Category fallback, root pricing
// engine). Added 2026-08-06 after discovering this Worker's own badge/tier-price
// engine (engine/pricing.ts) had NO knowledge of these files at all -- it only
// read BRAND_LIMITS/CATEGORY_LIMITS, so a per-product cap set live in Shoptet
// (e.g. 101821 at 10%) was correctly written to Shoptet itself, but the
// /v1/product-discount badge kept recomputing its OWN (wrong, uncapped) tier
// price from scratch, showing stale/incorrect % to customers. These two maps
// close that gap: zeroDiscountProducts (0%) merged in as a ratio 0, then
// productMaxDiscountOverrides (percent -> ratio) on top.
// clearanceSaleProducts (22%/30% výpredaj codes) merged in too -- confirmed live
// 2026-08-06 that without this, engine/pricing.ts picks whichever is LOWER between
// the clearance actionPrice and the raw uncapped ZR25 loyalty price (25%), and since
// 25% > 22%/30% intended discount for most of these products, the engine silently
// showed the deeper loyalty % instead of the intended clearance price on ZR25. Adding
// them here as a real cap makes the `minAllowedPrice > 0 && actionPrice !== undefined`
// branch fire, which makes actionPrice authoritative regardless of loyalty tier depth.
// clearance-sale-products.json entries support an optional date window
// ({ pct, validFrom?, validTo?: "YYYY-MM-DD" }) alongside the plain-number shape
// (backwards compatible with entries that never had dates). Evaluated once at
// module load (this file is re-imported fresh by every CLI/cron run via `npx tsx`,
// so the CLI writers -- the actual source of truth for live prices, see
// clearance-sale-products.json's own header comment about the CSV-import-only
// lesson -- always see today's correct window; only the long-lived Worker isolate
// could see a stale window between deploys, a known, accepted limitation here).
type ClearanceEntry = number | { pct: number; validFrom?: string; validTo?: string };

function resolveClearancePct(entry: ClearanceEntry, now: Date): number | undefined {
    if (typeof entry === 'number') return entry;
    if (entry.validFrom && now < new Date(entry.validFrom)) return undefined;
    if (entry.validTo && now > new Date(entry.validTo + 'T23:59:59')) return undefined;
    return entry.pct;
}

const now = new Date();
const activeClearanceEntries = Object.entries(clearanceSaleProducts as Record<string, ClearanceEntry>)
    .map(([code, entry]) => [code, resolveClearancePct(entry, now)] as const)
    .filter((pair): pair is [string, number] => pair[1] !== undefined);

// --- STAGE 1 VALIDATION: config-load-time cross-file conflict check --------------
// This is the FIRST of three validation stages the sync pipeline relies on to keep
// a bad config from ever reaching a live price:
//   Stage 1 (here): fail the module load itself if two static policy sources
//     disagree about the same product code, before any price is ever computed.
//   Stage 2 (scripts/run-real-sync.ts / sync-coupon-fields-diff.ts): the
//     diff-aware live write refuses to apply itself if it would move more than
//     30% of catalog prices in one run (safety fuse against a bad feed/config).
//   Stage 3 (npm test, enforced by ci.yml on every push/PR): the 236-test vitest
//     suite regression-checks the actual pricing/coupon decision logic, including
//     the three-way tier+coupon+clearance interaction.
// A product silently landing in two of {zeroDiscountProducts, clearanceSaleProducts,
// productMaxDiscountOverrides} is exactly how INC-004-style bugs happen: whichever
// map is spread last in PRODUCT_LIMITS below wins with zero warning, and the price a
// customer actually sees quietly stops matching the price someone intended to set.
// Instead of guessing which source "should" win, refuse to build at all — whoever
// added the conflicting entry has to resolve it explicitly in the JSON files.
function assertNoCrossFileConflicts(sources: Record<string, string[]>): void {
    const entries = Object.entries(sources);
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [nameA, codesA] = entries[i];
            const [nameB, codesB] = entries[j];
            const setB = new Set(codesB);
            const conflicts = codesA.filter((code) => setB.has(code));
            if (conflicts.length > 0) {
                throw new Error(
                    `Product code(s) ${conflicts.join(', ')} appear in BOTH ${nameA} and ${nameB}. ` +
                        `This is ambiguous — the map spread later in PRODUCT_LIMITS would silently win with no ` +
                        `warning. Remove the code from one of the two files before deploying.`
                );
            }
        }
    }
}

assertNoCrossFileConflicts({
    'zero-discount-products.json': zeroDiscountProducts as string[],
    'clearance-sale-products.json': Object.keys(clearanceSaleProducts as Record<string, ClearanceEntry>),
    'product-max-discount-overrides.json': Object.keys(productMaxDiscountOverrides as Record<string, number>)
});

export const PRODUCT_LIMITS: Record<string, number> = {
    ...Object.fromEntries((zeroDiscountProducts as string[]).map((code) => [code, 0])),
    ...Object.fromEntries(activeClearanceEntries.map(([code, pct]) => [code, pct / 100])),
    ...Object.fromEntries(
        Object.entries(productMaxDiscountOverrides as Record<string, number>).map(([code, pct]) => [code, pct / 100])
    ),
};
