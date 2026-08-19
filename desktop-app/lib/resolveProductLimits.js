// Ported 1:1 from ../../cloudflare-worker/src/engine/config.ts's PRODUCT_LIMITS
// construction -- the single source of truth for how zero-discount-products.json,
// clearance-sale-products.json (with optional validFrom/validTo date windows), and
// product-max-discount-overrides.json combine into one per-product discount cap.
// Kept as a separate module (not folded into pricingEngine.js) so it can take
// policyManager.loadAll()'s already-parsed JSON directly, same as the live pipeline.
'use strict';

/**
 * @param {number | {pct: number, validFrom?: string, validTo?: string}} entry
 * @param {Date} now
 * @returns {number | undefined}
 */
function resolveClearancePct(entry, now) {
    if (typeof entry === 'number') return entry;
    if (entry.validFrom && now < new Date(entry.validFrom)) return undefined;
    if (entry.validTo && now > new Date(entry.validTo + 'T23:59:59')) return undefined;
    return entry.pct;
}

// Same Stage-1 config-load-time conflict check as config.ts's assertNoCrossFileConflicts
// -- a product code silently present in two of these three files is exactly how an
// INC-004-style bug happens (whichever source is merged last silently wins). Throws
// instead of guessing, same as the live pipeline.
function assertNoCrossFileConflicts(sources) {
    const entries = Object.entries(sources);
    for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
            const [nameA, codesA] = entries[i];
            const [nameB, codesB] = entries[j];
            const setB = new Set(codesB);
            const conflicts = codesA.filter((code) => setB.has(code));
            if (conflicts.length > 0) {
                throw new Error(
                    `Kód(y) produktu ${conflicts.join(', ')} jsou zároveň v ${nameA} i ${nameB}. ` +
                    `To je nejednoznačné -- odeber kód z jednoho ze dvou souborů, než appka spočítá ceny.`
                );
            }
        }
    }
}

/**
 * @param {{zeroDiscount: string[], clearance: Record<string, number | {pct:number,validFrom?:string,validTo?:string}>, productOverrides: Record<string, number>}} policyData
 * @param {Date} [now]
 * @returns {Record<string, number>} code -> ratio (0-1), Product-level discount cap
 */
function resolveProductLimits(policyData, now = new Date()) {
    const zeroDiscount = policyData.zeroDiscount || [];
    const clearance = policyData.clearance || {};
    const productOverrides = policyData.productOverrides || {};

    const activeClearanceEntries = Object.entries(clearance)
        .map(([code, entry]) => [code, resolveClearancePct(entry, now)])
        .filter(([, pct]) => pct !== undefined);

    assertNoCrossFileConflicts({
        'zero-discount-products.json': zeroDiscount,
        'clearance-sale-products.json': Object.keys(clearance),
        'product-max-discount-overrides.json': Object.keys(productOverrides),
    });

    return {
        ...Object.fromEntries(zeroDiscount.map((code) => [code, 0])),
        ...Object.fromEntries(activeClearanceEntries.map(([code, pct]) => [code, pct / 100])),
        ...Object.fromEntries(Object.entries(productOverrides).map(([code, pct]) => [code, pct / 100])),
    };
}

module.exports = { resolveProductLimits };
