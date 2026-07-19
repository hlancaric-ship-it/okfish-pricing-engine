import Decimal from 'decimal.js';
import { PricingInput, PricingCommand } from './interfaces.js';

export class PricingContext {
    private _currentPrice: Decimal;
    public readonly appliedPolicies: string[] = [];
    
    constructor(public readonly input: PricingInput) {
        this._currentPrice = input.basePrice;
    }
    
    get currentPrice(): Decimal {
        return this._currentPrice;
    }
    
    applyCommand(command: PricingCommand) {
        if (command.type === "SET_PRICE") {
            this._currentPrice = command.price;
            this.appliedPolicies.push(command.reason);
        }
    }
}
