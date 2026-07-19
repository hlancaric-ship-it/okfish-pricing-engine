import { ReadonlyPricingContext } from '../core/interfaces.js';

export class ValidatorPolicy {
    validate(context: ReadonlyPricingContext): void {
        if (context.currentPrice.lessThan(0)) {
            throw new Error(`Price for ${context.input.sku} cannot be negative.`);
        }
    }
}
