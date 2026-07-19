import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";
import Decimal from "decimal.js";

export class LoyaltyPolicy implements IPricingPolicy {
    readonly name = "LoyaltyPolicy";

    apply(context: IPricingContext): void {
        if (!context.input.allowLoyaltyDiscount) {
            return;
        }

        if (context.input.customerDiscount) {
            const multiplier = new Decimal(1).minus(context.input.customerDiscount);
            const loyaltyPrice = context.input.basePrice.times(multiplier);
            if (loyaltyPrice.lessThan(context.currentPrice)) {
                context.currentPrice = loyaltyPrice;
                context.addAppliedPolicy(this.name);
            }
        }
    }
}
