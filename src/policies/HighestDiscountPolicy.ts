import Decimal from "decimal.js";
import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';

export class HighestDiscountPolicy implements PricingPolicy {
    name = 'HighestDiscount';
    priority = 20;

    constructor(private loyaltyTiers: Record<string, Decimal>) {}

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        const salePrice = context.input.salePrice;
        let loyaltyPrice = undefined;

        if (context.input.customerTier && context.input.allowLoyaltyDiscount) {
            const discountPercent = this.loyaltyTiers[context.input.customerTier];
            if (discountPercent) {
                const one = new Decimal("1");
                loyaltyPrice = context.input.basePrice.mul(one.minus(discountPercent));
            }
        }

        if (salePrice && loyaltyPrice) {
            if (salePrice.lessThan(loyaltyPrice)) {
                return { type: "SET_PRICE", price: salePrice, rule: RuleType.SALE };
            } else {
                return { type: "SET_PRICE", price: loyaltyPrice, rule: RuleType.LOYALTY };
            }
        } else if (salePrice) {
            return { type: "SET_PRICE", price: salePrice, rule: RuleType.SALE };
        } else if (loyaltyPrice) {
            return { type: "SET_PRICE", price: loyaltyPrice, rule: RuleType.LOYALTY };
        }
    }
}
