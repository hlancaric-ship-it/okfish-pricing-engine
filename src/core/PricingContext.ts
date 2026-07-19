import Decimal from "decimal.js";
import { IPricingContext, Product } from "./interfaces.js";

export class PricingContext implements IPricingContext {
    product: Product;
    currentPrice: Decimal;
    appliedPolicies: string[];

    constructor(product: Product) {
        this.product = product;
        this.currentPrice = new Decimal(0);
        this.appliedPolicies = [];
    }

    addAppliedPolicy(policyName: string): void {
        this.appliedPolicies.push(policyName);
    }
}
