import { IPricingContext, IPricingPolicy, Product } from "./interfaces.js";
import { PricingContext } from "./PricingContext.js";

export class PricingEngine {
    private policies: IPricingPolicy[];

    constructor(policies: IPricingPolicy[]) {
        this.policies = policies;
    }

    calculatePrice(product: Product): IPricingContext {
        const context = new PricingContext(product);
        for (const policy of this.policies) {
            policy.apply(context);
        }
        return context;
    }
}
