import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { CouponPolicy } from '../src/coupon/CouponPolicy.js';
import { CouponPolicyInput } from '../src/coupon/types.js';

const d = (n: number) => new Decimal(n);

describe('CouponPolicy', () => {
    const policy = new CouponPolicy();

    describe('Worked examples confirmed with the user (action vs. tier never summed)', () => {
        it('Example 1 — action 10%, tier ZR4 (4%): action wins, coupon gets the remaining 10%', () => {
            const result = policy.decide({
                productDiscount: d(0.10),
                customerTierDiscount: d(0.04),
                customerTier: 'ZR4'
            });
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.10);
        });

        it('Example 2 — action 10%, tier ZR16 (16%): tier wins, coupon gets the remaining 4% (NOT 10+16)', () => {
            const result = policy.decide({
                productDiscount: d(0.10),
                customerTierDiscount: d(0.16),
                customerTier: 'ZR16'
            });
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.04);
        });

        it('Example 3 — action 22%, tier ZR4 (4%): action alone already >= 20%, coupon OFF', () => {
            const result = policy.decide({
                productDiscount: d(0.22),
                customerTierDiscount: d(0.04),
                customerTier: 'ZR4'
            });
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('Example 4 — product limit 6%, tier ZR4 (4%): coupon gets only the remaining 2%', () => {
            const result = policy.decide({
                productDiscount: d(0),
                customerTierDiscount: d(0.04),
                customerTier: 'ZR4',
                productMaxDiscount: d(0.06)
            });
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.02);
        });

        it('Example 5 — product limit 4%, tier ZR4 (4%): limit already fully used by the tier, coupon OFF', () => {
            const result = policy.decide({
                productDiscount: d(0),
                customerTierDiscount: d(0.04),
                customerTier: 'ZR4',
                productMaxDiscount: d(0.04)
            });
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });
    });

    describe('Never stacks discounts, never exceeds the ceiling (shop can never lose margin)', () => {
        const cases: { name: string; input: CouponPolicyInput; ceiling: number }[] = [
            {
                name: 'default 20% ceiling, product discount higher than tier',
                input: { productDiscount: d(0.15), customerTierDiscount: d(0.06), customerTier: 'ZR6' },
                ceiling: 0.20
            },
            {
                name: 'default 20% ceiling, tier discount higher than product',
                input: { productDiscount: d(0.02), customerTierDiscount: d(0.14), customerTier: 'ZR14' },
                ceiling: 0.20
            },
            {
                name: 'individual product limit (10%), tier discount higher than product',
                input: { productDiscount: d(0), customerTierDiscount: d(0.06), customerTier: 'ZR6', productMaxDiscount: d(0.10) },
                ceiling: 0.10
            },
            {
                name: 'individual product limit (15%), product discount higher than tier',
                input: { productDiscount: d(0.08), customerTierDiscount: d(0.04), customerTier: 'ZR4', productMaxDiscount: d(0.15) },
                ceiling: 0.15
            }
        ];

        for (const { name, input, ceiling } of cases) {
            it(`${name} — currentDiscount + maxDiscount never exceeds ${ceiling * 100}%`, () => {
                const result = policy.decide(input);
                const currentDiscount = Decimal.max(input.productDiscount, input.customerTierDiscount);
                const totalIfCouponUsed = currentDiscount.plus(result.maxDiscount);
                expect(totalIfCouponUsed.toNumber()).toBeLessThanOrEqual(ceiling);
                // and it should use the FULL remaining room, not leave money on the table either
                if (result.applyDiscountCoupon === 1) {
                    expect(totalIfCouponUsed.toNumber()).toBeCloseTo(ceiling);
                }
            });
        }
    });

    describe('Rule 1 — product disallows discounts entirely', () => {
        it('blocks the coupon when productMaxDiscount is 0', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.1),
                productMaxDiscount: d(0)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });
    });

    describe('Rule 2 — individual product limit below 20%', () => {
        it('allows the coupon for the remaining room under the limit', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.06),
                productMaxDiscount: d(0.10)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.04);
        });

        it('uses productDiscount when it is higher than the tier discount', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.08),
                customerTierDiscount: d(0.04),
                productMaxDiscount: d(0.15)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.07);
        });

        it('blocks the coupon when current discount already meets the limit', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.04),
                customerTierDiscount: d(0.04),
                productMaxDiscount: d(0.04)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('blocks the coupon when current discount exceeds the limit', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.12),
                customerTierDiscount: d(0),
                productMaxDiscount: d(0.10)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('does NOT get overridden by the ZR20/ZR25 tier block — the tier block wins regardless', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.20),
                productMaxDiscount: d(0.10),
                customerTier: 'ZR20'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });
    });

    describe('Rule 3 — product discount already >= 20%', () => {
        it('blocks the coupon regardless of customer tier', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.25),
                customerTierDiscount: d(0),
                customerTier: 'ZR4'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('blocks exactly at the 20% boundary', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.20),
                customerTierDiscount: d(0)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('ignores customer tier entirely for this rule (only product discount matters)', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.22),
                customerTierDiscount: d(0.04),
                customerTier: 'ZR4'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
        });
    });

    describe('Rule 4 — ZR20/ZR25 tier hard block', () => {
        it('blocks ZR20 customers even with low product discount and no product limit', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.20),
                customerTier: 'ZR20'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('blocks ZR25 customers', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.25),
                customerTier: 'ZR25'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('does not block other tiers (e.g. ZR18)', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.18),
                customerTier: 'ZR18'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.02);
        });

        it('blocks ZR20 even when Rule 2 math alone would allow a positive remainder', () => {
            // Proves the tier block is unconditional, not a coincidence of Rule 2's math:
            // productMaxDiscount=0.15, currentDiscount would be max(0, 0.05)=0.05, so Rule 2
            // alone would compute remaining=0.10>0 and allow the coupon — but ZR20 wins first.
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.05),
                productMaxDiscount: d(0.15),
                customerTier: 'ZR20'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });
    });

    describe('Rule 5 — standard case (20% ceiling)', () => {
        it('allows the coupon for the remaining room to 20%', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.08),
                customerTier: 'ZR8'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.12);
        });

        it('uses whichever discount (product vs tier) is higher', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0.15),
                customerTierDiscount: d(0.06),
                customerTier: 'ZR6'
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.05);
        });

        it('blocks when current discount already meets 20%', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0.20),
                customerTier: 'ZR18' // hypothetical: exactly 20% via tier but not a locked tier name
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(0);
            expect(result.maxDiscount.toNumber()).toBe(0);
        });

        it('handles a customer with no tier at all (0% tier discount, 0% product discount)', () => {
            const input: CouponPolicyInput = {
                productDiscount: d(0),
                customerTierDiscount: d(0)
            };
            const result = policy.decide(input);
            expect(result.applyDiscountCoupon).toBe(1);
            expect(result.maxDiscount.toNumber()).toBeCloseTo(0.20);
        });
    });
});
