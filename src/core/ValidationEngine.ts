import { PricingInput, PricingResult } from './interfaces.js';

export class ValidationEngine {
    validateInput(input: PricingInput): { valid: boolean; reason?: string } {
        if (input.basePrice.lessThan(0)) {
            return { valid: false, reason: "Base price cannot be negative" };
        }
        if (input.productMaxDiscount && (input.productMaxDiscount.lessThan(0) || input.productMaxDiscount.greaterThan(1))) {
            return { valid: false, reason: "Invalid max discount" };
        }
        return { valid: true };
    }

    validateResult(result: PricingResult): { valid: boolean; reason?: string } {
        if (result.finalPrice.lessThan(0)) {
            return { valid: false, reason: "Final price cannot be negative" };
        }
        return { valid: true };
    }
}
