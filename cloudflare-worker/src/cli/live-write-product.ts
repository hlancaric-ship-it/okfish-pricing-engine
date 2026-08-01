// ONE-OFF, MANUAL TEST SCRIPT. Sends live writes for ONE product across ALL 10 tier
// pricelists, using explicit product data passed on the command line (basePrice,
// actionPrice, productMaxDiscount). Not part of any scheduled job.
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

const code = process.argv[2];
const basePrice = new Decimal(process.argv[3]);
const actionPrice = process.argv[4] ? new Decimal(process.argv[4]) : undefined;
const productMaxDiscount = process.argv[5] ? new Decimal(process.argv[5]) : undefined;

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

    const items = computeCouponWrites({ code, basePrice, actionPrice, productMaxDiscount }, LOYALTY_TIER_RATIOS);

    console.log(`=== Zápis pro produkt ${code} na všech ${items.length} tierech ===`);
    for (const item of items) {
        const payload = { code: item.code, discountCoupon: item.applyDiscountCoupon, minPriceRatio: item.minPriceRatio.toFixed(4) };
        console.log(`-> ${item.tier} (pricelist ${item.pricelistId}): discountCoupon=${payload.discountCoupon} minPriceRatio=${payload.minPriceRatio}`);
        const result = await client.updatePricelistSalesBatch(item.pricelistId, [payload]);
        console.log(`   OK status=${result.status} requestId=${result.requestId}`);
    }
    console.log('=== HOTOVO ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
