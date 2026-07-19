import { IPricingContext, IPricingPolicy, PricingInput } from "./interfaces.js";
import { PricingContext } from "./PricingContext.js";

export class PricingEngine {
    private policies: IPricingPolicy[];

    constructor(policies: IPricingPolicy[]) {
        this.policies = policies;
    }

    calculatePrice(input: PricingInput): IPricingContext {
        const context = new PricingContext(input);
        for (const policy of this.policies) {
            policy.apply(context);
        }
        return context;
    }
}
