export class ValidatorPolicy {
    validate(context: any): void {
        if (context.currentPrice.lessThan(0)) {
            throw new Error(`Price for ${context.input.sku} cannot be negative.`);
        }
    }
}
