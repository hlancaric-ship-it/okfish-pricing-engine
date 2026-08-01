// ONE-OFF, MANUAL TEST SCRIPT. Sends live writes for ONE product across ALL 10 tier
// pricelists, using the real (corrected) computeCouponWrites formula. Not part of
// any scheduled job — for manual verification only.
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { ShoptetApiClient } from '../shoptet-api/client';
import { computeCouponWrites } from '../coupon/compute-coupon-writes';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const TARGET_CODE = '103988';
// Known from the master feed (fetched earlier this session): price 179,95, no
// actionPrice discount, no individual maxDiscount limit.
const BASE_PRICE = new Decimal('179.95');

const LOYALTY_TIER_RATIOS: Record<string, Decimal> = (() => {
    const policyPath = path.resolve(__dirname, '../../../src/config/policies/policy-v1.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
    const ratios: Record<string, Decimal> = {};
    for (const [tier, ratio] of Object.entries(policy.loyaltyTiers as Record<string, number>)) {
        ratios[tier] = new Decimal(ratio);
    }
    return ratios;
})();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
    const client = new ShoptetApiClient(token);

    const items = computeCouponWrites({ code: TARGET_CODE, basePrice: BASE_PRICE }, LOYALTY_TIER_RATIOS);

    console.log(`=== Zápis pro produkt ${TARGET_CODE} na všech ${items.length} tierech ===`);
    for (const item of items) {
        const payload = { code: item.code, discountCoupon: item.applyDiscountCoupon, minPriceRatio: item.minPriceRatio.toFixed(4) };
        console.log(`-> ${item.tier} (pricelist ${item.pricelistId}): discountCoupon=${payload.discountCoupon} minPriceRatio=${payload.minPriceRatio}`);
        const result = await client.updatePricelistSalesBatch(item.pricelistId, [payload]);
        console.log(`   OK status=${result.status} requestId=${result.requestId}`);
    }
    console.log('=== HOTOVO ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
