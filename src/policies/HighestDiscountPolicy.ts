import { IPricingContext, IPricingPolicy, CustomerTier } from "../core/interfaces.js";
import Decimal from "decimal.js";

export const DISCOUNT_MAP: Record<CustomerTier, Decimal> = {
    ZR4: new Decimal("0.04"),
    ZR6: new Decimal("0.06"),
    ZR8: new Decimal("0.08"),
    ZR10: new Decimal("0.10"),
    ZR12: new Decimal("0.12"),
    ZR14: new Decimal("0.14"),
    ZR16: new Decimal("0.16"),
    ZR18: new Decimal("0.18"),
    ZR20: new Decimal("0.20"),
    ZR25: new Decimal("0.25"),
};

export class HighestDiscountPolicy implements IPricingPolicy {
    readonly name = "HighestDiscountPolicy";

    apply(context: IPricingContext): void {
        let bestPrice = context.currentPrice;
        let appliedReason = "";
        let priceChanged = false;

        // 1. Check sale price
        if (context.input.salePrice && context.input.salePrice.lessThan(bestPrice)) {
            bestPrice = context.input.salePrice;
            appliedReason = "SalePrice";
            priceChanged = true;
        }

        // 2. Check loyalty price
        if (context.input.allowLoyaltyDiscount && context.input.customerTier) {
            const discountPercentage = DISCOUNT_MAP[context.input.customerTier];
            if (discountPercentage) {
                const loyaltyPrice = context.input.basePrice.times(new Decimal(1).minus(discountPercentage));
                if (loyaltyPrice.lessThan(bestPrice)) {
                    bestPrice = loyaltyPrice;
                    appliedReason = `LoyaltyDiscount(${context.input.customerTier})`;
                    priceChanged = true;
                }
            }
        }

        if (priceChanged && bestPrice.lessThan(context.currentPrice)) {
            context.currentPrice = bestPrice;
            context.addAppliedPolicy(`${this.name}:${appliedReason}`);
        }
    }
}
