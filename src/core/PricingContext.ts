import Decimal from 'decimal.js';
import { PricingInput, PricingCommand, RuleType, ReadonlyPricingContext } from './interfaces.js';

export class PricingContext implements ReadonlyPricingContext {
    private _currentPrice: Decimal;
    public readonly appliedRules: { rule: RuleType; metadata?: string }[] = [];
    public readonly warnings: string[] = [];
    public rejected: boolean = false;
    public rejectReason?: string;
    
    constructor(public readonly input: PricingInput) {
        this._currentPrice = input.basePrice;
    }
    
    get currentPrice(): Decimal {
        return this._currentPrice;
    }
    
    applyCommand(command: PricingCommand) {
        switch (command.type) {
            case "SET_PRICE":
                this._currentPrice = command.price;
                this.appliedRules.push({ rule: command.rule, metadata: command.metadata });
                break;
            case "WARNING":
                this.warnings.push(`[${command.rule}] ${command.message}`);
                break;
            case "REJECT":
                this.rejected = true;
                this.rejectReason = `[${command.rule}] ${command.reason}`;
                break;
        }
    }
}
