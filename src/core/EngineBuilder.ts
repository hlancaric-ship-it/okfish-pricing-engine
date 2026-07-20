import { PricingEngine } from './PricingEngine.js';
import { BasePricePolicy } from '../policies/BasePricePolicy.js';
import { HighestDiscountPolicy } from '../policies/HighestDiscountPolicy.js';
import { DiscountLimitPolicy } from '../policies/DiscountLimitPolicy.js';
import { RoundingPolicy } from '../policies/RoundingPolicy.js';
import { EngineConfig } from './interfaces.js';
import Decimal from 'decimal.js';
import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

const PolicySchema = z.object({
    version: z.string(),
    description: z.string().optional(),
    loyaltyTiers: z.record(z.string(), z.number().min(0).max(1)),
    brandLimits: z.record(z.string(), z.number().min(0).max(1)).optional(),
    categoryLimits: z.record(z.string(), z.number().min(0).max(1)).optional(),
});

export class EngineBuilder {
    private engine = new PricingEngine();

    static default(): EngineBuilder {
        const builder = new EngineBuilder();
        builder.engine.use(new BasePricePolicy());
        // Default static fallback map if no config provided
        const defaultTiers: Record<string, Decimal> = {
            "ZR4": new Decimal("0.04"),
            "ZR6": new Decimal("0.06"),
            "ZR8": new Decimal("0.08"),
            "ZR10": new Decimal("0.10"),
            "ZR12": new Decimal("0.12"),
            "ZR14": new Decimal("0.14"),
            "ZR16": new Decimal("0.16"),
            "ZR18": new Decimal("0.18"),
            "ZR20": new Decimal("0.20"),
            "ZR25": new Decimal("0.25")
        };
        builder.engine.use(new HighestDiscountPolicy(defaultTiers));
        builder.engine.use(new DiscountLimitPolicy());
        builder.engine.use(new RoundingPolicy());
        return builder;
    }

    static fromConfig(configPath: string): EngineBuilder {
        const fullPath = path.resolve(process.cwd(), configPath);
        const configRaw = fs.readFileSync(fullPath, 'utf-8');
        
        // Validate JSON via Zod
        const parsedJson = JSON.parse(configRaw);
        const config = PolicySchema.parse(parsedJson) as EngineConfig;

        const builder = new EngineBuilder();
        builder.engine.use(new BasePricePolicy());
        
        const tiers: Record<string, Decimal> = {};
        for (const [tier, val] of Object.entries(config.loyaltyTiers)) {
            tiers[tier] = new Decimal(val);
        }
        builder.engine.use(new HighestDiscountPolicy(tiers));
        
        const brands: Record<string, Decimal> = {};
        if (config.brandLimits) {
            for (const [brand, val] of Object.entries(config.brandLimits)) {
                brands[brand] = new Decimal(val);
            }
        }

        const categories: Record<string, Decimal> = {};
        if (config.categoryLimits) {
            for (const [cat, val] of Object.entries(config.categoryLimits)) {
                categories[cat] = new Decimal(val);
            }
        }
        
        builder.engine.use(new DiscountLimitPolicy(brands, categories));
        builder.engine.use(new RoundingPolicy());

        return builder;
    }

    withDiscountLimits(brandLimits: Record<string, Decimal> = {}, categoryLimits: Record<string, Decimal> = {}): this {
        this.engine.use(new DiscountLimitPolicy(brandLimits, categoryLimits));
        return this;
    }

    build(): PricingEngine {
        this.engine.freeze();
        return this.engine;
    }
}
