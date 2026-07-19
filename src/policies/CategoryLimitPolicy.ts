import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";
import Decimal from "decimal.js";

export class CategoryLimitPolicy implements IPricingPolicy {
    readonly name = "CategoryLimitPolicy";
    private categoryMaxDiscounts: Record<string, Decimal>;

    constructor(categoryMaxDiscounts: Record<string, Decimal> = {}) {
        this.categoryMaxDiscounts = categoryMaxDiscounts;
    }

    apply(context: IPricingContext): void {
        if (context.input.category && this.categoryMaxDiscounts[context.input.category]) {
            const maxDiscount = this.categoryMaxDiscounts[context.input.category];
            const limitPrice = context.input.basePrice.times(new Decimal(1).minus(maxDiscount));
            
            if (context.currentPrice.lessThan(limitPrice)) {
                context.currentPrice = limitPrice;
                context.addAppliedPolicy(`${this.name}:${context.input.category}`);
            }
        }
    }
}
