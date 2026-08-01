// Preview-only: computes coupon writes for one hardcoded product/tier set without
// calling any API. Used to sanity-check numbers before a live batch.
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { computeCouponWrites } from '../coupon/compute-coupon-writes';

const code = process.argv[2];
const basePrice = new Decimal(process.argv[3]);
const actionPrice = process.argv[4] ? new Decimal(process.argv[4]) : undefined;
const productMaxDiscount = process.argv[5] ? new Decimal(process.argv[5]) : undefined;

const policyPath = path.resolve(__dirname, '../../../src/config/policies/policy-v1.json');
const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
const ratios: Record<string, Decimal> = {};
for (const [tier, r] of Object.entries(policy.loyaltyTiers as Record<string, number>)) ratios[tier] = new Decimal(r);

const items = computeCouponWrites({ code, basePrice, actionPrice, productMaxDiscount }, ratios);
for (const i of items) {
    console.log(`${i.tier} (pricelist ${i.pricelistId}): discountCoupon=${i.applyDiscountCoupon} minPriceRatio=${i.minPriceRatio.toFixed(4)}`);
}
