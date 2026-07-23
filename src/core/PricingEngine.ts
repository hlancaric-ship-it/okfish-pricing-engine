import { PricingPolicy, PricingInput, PricingResult } from './interfaces.js';
import { PricingContext } from './PricingContext.js';

export class PricingEngine {
    private policies: PricingPolicy[] = [];
    private frozen = false;

    use(policy: PricingPolicy): this {
        if (this.frozen) throw new Error('Cannot add policies to a frozen PricingEngine');
        this.policies.push(policy);
        return this;
    }

    freeze(): void {
        this.policies.sort((a, b) => a.priority - b.priority);
        this.frozen = true;
    }

    calculatePrice(input: PricingInput): PricingResult {
        const context = new PricingContext(input);
        for (const policy of this.policies) {
            const command = policy.apply(context);
            if (command) context.applyCommand(command);
            if (context.rejected) break;
        }
        return {
            sku: input.sku,
            originalPrice: input.basePrice,
            finalPrice: context.currentPrice,
            appliedRules: context.appliedRules,
            warnings: context.warnings,
            rejected: context.rejected,
            rejectReason: context.rejectReason
        };
    }
}
