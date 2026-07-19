import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";

export class SalePolicy implements IPricingPolicy {
    readonly name = "SalePolicy";

    apply(context: IPricingContext): void {
        if (context.product.salePrice && context.product.salePrice.lessThan(context.currentPrice)) {
            context.currentPrice = context.product.salePrice;
            context.addAppliedPolicy(this.name);
        }
    }
}
