import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";

export class SalePolicy implements IPricingPolicy {
    readonly name = "SalePolicy";

    apply(context: IPricingContext): void {
        if (context.input.salePrice && context.input.salePrice.lessThan(context.currentPrice)) {
            context.currentPrice = context.input.salePrice;
            context.addAppliedPolicy(this.name);
        }
    }
}
