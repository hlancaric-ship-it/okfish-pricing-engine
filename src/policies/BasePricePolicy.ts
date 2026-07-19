import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";

export class BasePricePolicy implements IPricingPolicy {
    readonly name = "BasePricePolicy";

    apply(context: IPricingContext): void {
        context.currentPrice = context.product.basePrice;
        context.addAppliedPolicy(this.name);
    }
}
