import { PricingPolicy, PricingInput, PricingResult } from './interfaces.js';
import { PricingContext } from './PricingContext.js';
import { ValidatorPolicy } from '../policies/ValidatorPolicy.js';

export class PricingEngine {
    private policies: PricingPolicy[] = [];
    private validator: ValidatorPolicy;

    constructor() {
        this.validator = new ValidatorPolicy();
    }

    use(policy: PricingPolicy) {
        this.policies.push(policy);
        this.policies.sort((a, b) => a.priority - b.priority);
    }

    calculatePrice(input: PricingInput): PricingResult {
        const context = new PricingContext(input);

        for (const policy of this.policies) {
            const command = policy.apply(context);
            if (command) {
                context.applyCommand(command);
            }
        }
        
        this.validator.validate(context);

        return {
            sku: input.sku,
            originalPrice: input.basePrice,
            finalPrice: context.currentPrice,
            appliedRules: context.appliedPolicies
        };
    }
}
