import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";

export class RoundingPolicy implements IPricingPolicy {
    readonly name = "RoundingPolicy";

    apply(context: IPricingContext): void {
        context.currentPrice = context.currentPrice.toDecimalPlaces(2);
    }
}
