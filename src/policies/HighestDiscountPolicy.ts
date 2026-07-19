import { PricingPolicy, PricingCommand } from '../core/interfaces.js';
import { DISCOUNT_MAP } from '../config/discounts.js';

export class HighestDiscountPolicy implements PricingPolicy {
    name = 'HighestDiscount';
    priority = 20;

    apply(context: any): PricingCommand | void {
        const salePrice = context.input.salePrice;
        let loyaltyPrice = undefined;

        if (context.input.customerTier && context.input.allowLoyaltyDiscount) {
            const discountPercent = DISCOUNT_MAP[context.input.customerTier];
            if (discountPercent) {
                const one = new (context.input.basePrice.constructor)("1");
                loyaltyPrice = context.input.basePrice.mul(one.minus(discountPercent));
            }
        }

        if (salePrice && loyaltyPrice) {
            if (salePrice.lessThan(loyaltyPrice)) {
                return { type: "SET_PRICE", price: salePrice, reason: `${this.name} (Sale)` };
            } else {
                return { type: "SET_PRICE", price: loyaltyPrice, reason: `${this.name} (Loyalty)` };
            }
        } else if (salePrice) {
            return { type: "SET_PRICE", price: salePrice, reason: `${this.name} (Sale)` };
        } else if (loyaltyPrice) {
            return { type: "SET_PRICE", price: loyaltyPrice, reason: `${this.name} (Loyalty)` };
        }
    }
}
