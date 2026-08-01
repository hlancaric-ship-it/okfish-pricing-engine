/**
 * Loyalty tier -> Shoptet pricelist ID. Sourced from the same mapping already used
 * elsewhere in the project (src/cli/benchmark.ts), duplicated here (not imported)
 * because cloudflare-worker has its own build/deploy boundary from the root package.
 */
export const TIER_PRICELIST_MAP: Record<string, number> = {
    ZR4: 2,
    ZR6: 5,
    ZR8: 8,
    ZR10: 11,
    ZR12: 14,
    ZR14: 17,
    ZR16: 20,
    ZR18: 23,
    ZR20: 26,
    ZR25: 29
};

export const LOCKED_COUPON_TIERS = ["ZR20", "ZR25"] as const;

/**
 * "Hlavný cenník" — the default pricelist used for non-logged-in (guest)
 * customers, confirmed via GET /api/pricelists (id=1, name="Hlavný cenník").
 * Kept separate from TIER_PRICELIST_MAP: it has no ZR-tier name, so it must
 * never trip CouponPolicy's ZR20/ZR25 lock (Rule 4) — a guest is not a tier,
 * just a customer with 0% loyalty discount, capped by the same 20% ceiling
 * (or the product's own lower limit) as any other non-locked tier.
 */
export const GUEST_PRICELIST_ID = 1;

/** All pricelists computeCouponWrites produces items for: the 10 ZR tiers plus GUEST. */
export const ALL_PRICELISTS_MAP: Record<string, number> = {
    ...TIER_PRICELIST_MAP,
    GUEST: GUEST_PRICELIST_ID
};
