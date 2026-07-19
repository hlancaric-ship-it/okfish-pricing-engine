import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";
import Decimal from "decimal.js";

export class ProductMaxDiscountPolicy implements IPricingPolicy {
    readonly name = "ProductMaxDiscountPolicy";

    apply(context: IPricingContext): void {
        if (context.input.productMaxDiscount) {
            const limitPrice = context.input.basePrice.times(new Decimal(1).minus(context.input.productMaxDiscount));
            if (context.currentPrice.lessThan(limitPrice)) {
                context.currentPrice = limitPrice;
                context.addAppliedPolicy(this.name);
            }
        }
    }
}
