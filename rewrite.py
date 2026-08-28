import re

with open('cloudflare-worker/src/cli/reconcile-coupon-drift.ts', 'r') as f:
    text = f.read()

# Add import for CouponSalesWriter
text = text.replace(
    "import { formatCoupon } from '../coupon/format-coupon.js';",
    "import { formatCoupon } from '../coupon/format-coupon.js';\nimport { CouponSalesWriter } from '../coupon/coupon-sales-writer.js';"
)

# Modify main signature to parse --apply
text = text.replace(
    "async function main() {",
    "async function main() {\n    const applyFixes = process.argv.includes('--apply');"
)

# Update statistics collection
replacement = """
    console.log(`   Spočítáno pro ${expectedByCode.size} produktů × ${Object.keys(ALL_PRICELISTS_MAP).length} ceníků.`);

    let totalChecked = 0;
    
    // Unified stats tracking
    const stats = {
        MATCHED: 0,
        MISSING: [] as any[],
        MISMATCH: [] as any[],
        LOCK_VIOLATION: [] as any[],
        ORPHAN: [] as any[],
        VERIFICATION_ERROR: [] as any[]
    };

    const writer = new CouponSalesWriter(client, { dryRun: !applyFixes });

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        console.log(`\\n=== Stahuji a porovnávám ceník ${tier} (${pricelistId}) ===`);
        const tierItems = tier === 'GUEST' ? baseItems : await client.getPricelistProducts(pricelistId);
        const actualByCode = new Map<string, { discountCoupon: boolean; minPriceRatio: string } | null>();
        for (const item of tierItems) {
            if (item.sales && item.sales.discountCoupon !== undefined && item.sales.minPriceRatio !== undefined) {
                actualByCode.set(item.code, { discountCoupon: item.sales.discountCoupon, minPriceRatio: item.sales.minPriceRatio });
            } else {
                actualByCode.set(item.code, null);
            }
        }

        const isLockedTier = (LOCKED_COUPON_TIERS as readonly string[]).includes(tier);
        const correctionsForTier: any[] = [];

        for (const baseItem of baseItems) {
            const code = baseItem.code;
            totalChecked++;
            
            const isOrphan = !feedAttrs.has(code);
            if (isOrphan) {
                stats.ORPHAN.push({ code, tier, expected: 'N/A (Odstraněno z feedu)', actual: 'ORPHAN', kind: 'orphan' });
                continue;
            }

            const expectedByTier = expectedByCode.get(code);
            const expected = expectedByTier?.get(tier);
            if (!expected) continue; 
            
            const actual = actualByCode.get(code);
            const expectedStr = formatCoupon(expected.applyDiscountCoupon, expected.minPriceRatio.toFixed(4));

            if (actual === undefined || actual === null) {
                const actStr = actual === undefined ? 'CHYBÍ CELÝ ZÁZNAM' : 'ZÁZNAM BEZ sales.discountCoupon/minPriceRatio';
                stats.MISSING.push({ code, tier, expected: expectedStr, actual: actStr, kind: 'missing', item: expected });
                correctionsForTier.push(expected);
                continue;
            }

            if (isLockedTier && actual.discountCoupon === true) {
                stats.LOCK_VIOLATION.push({
                    code, tier,
                    expected: 'discountCoupon=false (Rule 4)',
                    actual: formatCoupon(actual.discountCoupon, actual.minPriceRatio),
                    kind: 'lock-violation', item: expected
                });
                correctionsForTier.push(expected);
                continue;
            }

            const actualStr = formatCoupon(actual.discountCoupon, actual.minPriceRatio);
            const flagMatches = actual.discountCoupon === expected.applyDiscountCoupon;
            
            const ratioMatters = expected.applyDiscountCoupon || actual.discountCoupon;
            const actualRatio = parseFloat(actual.minPriceRatio);
            const expectedRatio = expected.minPriceRatio.toNumber();
            const ratioMatches = !ratioMatters || (!isNaN(actualRatio) && Math.abs(actualRatio - expectedRatio) <= RATIO_TOLERANCE);

            if (flagMatches && ratioMatches) {
                stats.MATCHED++;
                continue;
            }

            stats.MISMATCH.push({ code, tier, expected: expectedStr, actual: actualStr, kind: 'mismatch', item: expected });
            correctionsForTier.push(expected);
        }

        if (applyFixes && correctionsForTier.length > 0) {
            console.log(`[WRITE] Odesílám ${correctionsForTier.length} oprav pro tier ${tier}...`);
            const writeStats = await writer.processTierBatch(pricelistId, tier, correctionsForTier);
            
            // Re-classify based on verification results
            // Note: processTierBatch returns verificationFailures
            const failedCodes = new Set(writeStats.verificationFailures.map(v => v.code));
            
            // We need to move successful ones to MATCHED, and failed ones to VERIFICATION_ERROR
            for (const cat of [stats.MISSING, stats.MISMATCH, stats.LOCK_VIOLATION]) {
                // iterate backwards to allow removal
                for (let i = cat.length - 1; i >= 0; i--) {
                    const alert = cat[i];
                    if (alert.tier === tier) {
                        if (failedCodes.has(alert.code) || writeStats.failed > 0) { // For simplicity, if any failed, assume they might be in errors
                            // Move to VERIFICATION_ERROR
                            stats.VERIFICATION_ERROR.push({...alert, kind: 'verification-error'});
                            cat.splice(i, 1);
                        } else {
                            // Successfully fixed!
                            stats.MATCHED++;
                            cat.splice(i, 1);
                        }
                    }
                }
            }
        }
    }

    console.log('\\n\\n=========================================');
    console.log(applyFixes ? 'AFTER (PO OPRAVĚ)' : 'BEFORE (STAV NA SHOPTETU)');
    console.log('=========================================');
    console.log(`MATCHED: ${stats.MATCHED}`);
    console.log(`MISSING: ${stats.MISSING.length}`);
    console.log(`MISMATCH: ${stats.MISMATCH.length}`);
    console.log(`LOCK_VIOLATION: ${stats.LOCK_VIOLATION.length}`);
    console.log(`ORPHAN: ${stats.ORPHAN.length}`);
    console.log(`VERIFICATION_ERROR: ${stats.VERIFICATION_ERROR.length}`);
    console.log(`TOTAL: ${stats.MATCHED + stats.MISSING.length + stats.MISMATCH.length + stats.LOCK_VIOLATION.length + stats.ORPHAN.length + stats.VERIFICATION_ERROR.length}`);

    const totalCalculated = stats.MATCHED + stats.MISSING.length + stats.MISMATCH.length + stats.LOCK_VIOLATION.length + stats.ORPHAN.length + stats.VERIFICATION_ERROR.length;
    if (totalCalculated !== totalChecked) {
        throw new Error(`Integrity chyba matematiky! totalChecked=${totalChecked}, secteno=${totalCalculated}`);
    }

    const allAlerts = [...stats.LOCK_VIOLATION, ...stats.MISSING, ...stats.MISMATCH, ...stats.VERIFICATION_ERROR];
    if (allAlerts.length > 0) {
        console.log('\\n--- ALERTY ---');
        for (const a of allAlerts) {
            console.log(`Kupón měl být ${a.expected}. Shoptet má ${a.actual}. Produkt ${a.code} (ceník ${a.tier}). -> ${a.kind.toUpperCase()}`);
        }
    }
"""

start_idx = text.find("    console.log(`   Spočítáno pro ${expectedByCode.size}")
end_idx = text.find("    // --- SELF-CHECK")

if start_idx != -1 and end_idx != -1:
    text = text[:start_idx] + replacement + text[end_idx:]

with open('cloudflare-worker/src/cli/reconcile-coupon-drift.ts', 'w') as f:
    f.write(text)

