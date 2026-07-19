import { IPricingContext, IPricingPolicy } from "../core/interfaces.js";
import Decimal from "decimal.js";

export class ValidatorPolicy implements IPricingPolicy {
    readonly name = "ValidatorPolicy";

    apply(context: IPricingContext): void {
        if (context.currentPrice.lessThan(new Decimal(0))) {
            throw new Error("Price cannot be negative");
        }
    }
}
