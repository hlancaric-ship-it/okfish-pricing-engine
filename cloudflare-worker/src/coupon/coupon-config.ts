import Decimal from "decimal.js";
import couponPolicyRaw from "../../../src/config/policies/coupon-policy.json";

// Same single-source-of-truth pattern as engine/config.ts's BRAND_LIMITS/PRODUCT_LIMITS
// -- coupon-policy.json is edited by the L-Code Pricing Engine desktop app (Pravidla ->
// Kupóny) and committed straight to this path, so this is the only place that reads it.
// Entries in disabledBrands/disabledProducts can be a plain string (disabled with no
// end date) or { code/brand, validFrom?, validTo? } for a time-boxed coupon-off window
// -- same date-window shape and re-evaluate-on-each-fresh-import reasoning as
// engine/config.ts's ClearanceEntry (see that file's comment for the staleness caveat).
type DisabledEntry = string | { value: string; validFrom?: string; validTo?: string };

interface CouponPolicyFile {
    defaultMaxDiscount: number;
    lockedTiers: string[];
    disabledBrands: DisabledEntry[];
    disabledProducts: DisabledEntry[];
}

const raw = couponPolicyRaw as CouponPolicyFile;

function resolveActiveValues(entries: DisabledEntry[], now: Date): string[] {
    const active: string[] = [];
    for (const entry of entries) {
        if (typeof entry === 'string') {
            active.push(entry);
            continue;
        }
        if (entry.validFrom && now < new Date(entry.validFrom)) continue;
        if (entry.validTo && now > new Date(entry.validTo + 'T23:59:59')) continue;
        active.push(entry.value);
    }
    return active;
}

const now = new Date();

export const COUPON_STANDARD_LIMIT = new Decimal(raw.defaultMaxDiscount).dividedBy(100);
export const COUPON_LOCKED_TIERS = new Set(raw.lockedTiers);
export const COUPON_DISABLED_BRANDS = new Set(resolveActiveValues(raw.disabledBrands, now).map((b) => b.toUpperCase()));
export const COUPON_DISABLED_PRODUCTS = new Set(resolveActiveValues(raw.disabledProducts, now));
