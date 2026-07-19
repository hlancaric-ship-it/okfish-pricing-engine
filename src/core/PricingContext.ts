import Decimal from "decimal.js";
import { IPricingContext, PricingInput } from "./interfaces.js";

export class PricingContext implements IPricingContext {
    input: PricingInput;
    currentPrice: Decimal;
    appliedPolicies: string[];

    constructor(input: PricingInput) {
        this.input = input;
        this.currentPrice = new Decimal(0);
        this.appliedPolicies = [];
    }

    addAppliedPolicy(policyName: string): void {
        this.appliedPolicies.push(policyName);
    }
}
