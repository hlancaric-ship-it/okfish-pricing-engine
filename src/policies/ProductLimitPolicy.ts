import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";
import Decimal from "decimal.js";

export class ProductLimitPolicy implements IPricingPolicy {
    readonly name = "ProductLimitPolicy";

    apply(context: IPricingContext): void {
        if (context.product.productLimitDiscount) {
            const limitPrice = context.product.basePrice.times(new Decimal(1).minus(context.product.productLimitDiscount));
            if (context.currentPrice.lessThan(limitPrice)) {
                context.currentPrice = limitPrice;
                context.addAppliedPolicy(this.name);
            }
        }
    }
}
