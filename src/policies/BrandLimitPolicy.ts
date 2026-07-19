import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";
import Decimal from "decimal.js";

export class BrandLimitPolicy implements IPricingPolicy {
    readonly name = "BrandLimitPolicy";
    private brandMaxDiscounts: Record<string, Decimal>;

    constructor(brandMaxDiscounts: Record<string, Decimal> = {}) {
        this.brandMaxDiscounts = brandMaxDiscounts;
    }

    apply(context: IPricingContext): void {
        if (context.input.manufacturer && this.brandMaxDiscounts[context.input.manufacturer]) {
            const maxDiscount = this.brandMaxDiscounts[context.input.manufacturer];
            const limitPrice = context.input.basePrice.times(new Decimal(1).minus(maxDiscount));
            
            if (context.currentPrice.lessThan(limitPrice)) {
                context.currentPrice = limitPrice;
                context.addAppliedPolicy(`${this.name}:${context.input.manufacturer}`);
            }
        }
    }
}
