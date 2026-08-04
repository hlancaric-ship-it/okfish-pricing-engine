import Decimal from "decimal.js";
import { PricingPolicy, PricingCommand, RuleType, ReadonlyPricingContext } from '../core/interfaces.js';

export class DiscountLimitPolicy implements PricingPolicy {
    name = 'DiscountLimit';
    priority = 30;

    private brandLimits: Record<string, Decimal>;
    private categoryLimits: Record<string, Decimal>;

    constructor(
        brandLimits: Record<string, Decimal> = {},
        categoryLimits: Record<string, Decimal> = {}
    ) {
        this.brandLimits = brandLimits;
        this.categoryLimits = categoryLimits;
    }

    apply(context: ReadonlyPricingContext): PricingCommand | void {
        let activeLimit: Decimal | undefined;
        let activeRuleType: RuleType | undefined;

        // Hierarchical fallback: Product -> Brand -> Category -> None
        if (context.input.productMaxDiscount !== undefined) {
            activeLimit = context.input.productMaxDiscount;
            activeRuleType = RuleType.PRODUCT_LIMIT;
        } else if (context.input.manufacturer && this.brandLimits[context.input.manufacturer] !== undefined) {
            activeLimit = this.brandLimits[context.input.manufacturer];
            activeRuleType = RuleType.BRAND_LIMIT;
        } else if (context.input.category && this.categoryLimits[context.input.category] !== undefined) {
            activeLimit = this.categoryLimits[context.input.category];
            activeRuleType = RuleType.CATEGORY_LIMIT;
        }

        if (activeLimit === undefined || activeRuleType === undefined) {
            return;
        }

        // When a cap is active AND the product has its own sale/action price, that
        // sale price is authoritative: it is neither raised by the cap-floor below,
        // nor overridden by a steeper loyalty-tier discount HighestDiscountPolicy
        // might otherwise have picked. Explicit client requirement — see
        // INCIDENTS.md ("2026-08-04 VAGNER" entry).
        if (context.input.salePrice !== undefined) {
            return { type: "SET_PRICE", price: context.input.salePrice, rule: RuleType.SALE };
        }

        const one = new Decimal("1");
        const minAllowedPrice = context.input.basePrice.mul(one.minus(activeLimit));

        if (context.currentPrice.lessThan(minAllowedPrice)) {
            return {
                type: "SET_PRICE",
                price: minAllowedPrice,
                rule: activeRuleType
            };
        }
    }
}
