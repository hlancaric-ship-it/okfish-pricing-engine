import { PricingEngine } from './PricingEngine.js';
import { BasePricePolicy } from '../policies/BasePricePolicy.js';
import { HighestDiscountPolicy } from '../policies/HighestDiscountPolicy.js';
import { ProductMaxDiscountPolicy } from '../policies/ProductMaxDiscountPolicy.js';
import { BrandLimitPolicy } from '../policies/BrandLimitPolicy.js';
import { CategoryLimitPolicy } from '../policies/CategoryLimitPolicy.js';
import { RoundingPolicy } from '../policies/RoundingPolicy.js';
import Decimal from 'decimal.js';

export class EngineBuilder {
    private engine = new PricingEngine();

    static default(): EngineBuilder {
        const builder = new EngineBuilder();
        builder.engine.use(new BasePricePolicy());
        builder.engine.use(new HighestDiscountPolicy());
        builder.engine.use(new ProductMaxDiscountPolicy());
        builder.engine.use(new RoundingPolicy());
        return builder;
    }

    withBrandLimits(limits: Record<string, Decimal>): this {
        this.engine.use(new BrandLimitPolicy(limits));
        return this;
    }

    withCategoryLimits(limits: Record<string, Decimal>): this {
        this.engine.use(new CategoryLimitPolicy(limits));
        return this;
    }

    build(): PricingEngine {
        this.engine.freeze();
        return this.engine;
    }
}
