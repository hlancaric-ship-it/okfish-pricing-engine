import { EngineBuilder } from '../../../src/core/EngineBuilder.js';
import { ValidationEngine } from '../../../src/core/ValidationEngine.js';
import { CustomerTier, PricingInput } from '../../../src/core/interfaces.js';
import Decimal from 'decimal.js';
import * as path from 'path';

export function calculateProductsPricing(products: Array<any>, pricelists: Array<{name: string, id: number}>) {
    // Používáme stávající v1.json konfiguraci
    const configPath = path.join(process.cwd(), 'src/config/policies/policy-v1.json');
    const engine = EngineBuilder.fromConfig(configPath).build();
    const validationEngine = new ValidationEngine();

    const results: Array<{code: string, prices: Record<string, string>}> = [];

    for (const p of products) {
        const itemResult: {code: string, prices: Record<string, string>} = {
            code: p.code,
            prices: {}
        };

        for (const pl of pricelists) {
            // "Hlavný cenník" a "Maloobchodný" přeskočíme, tam nemají být slevy
            // Ceníky se ve starém systému jmenovaly ZR4, ZR6... 
            // My budeme posílat název ceníku jako customerTier do engine
            const input: PricingInput = {
                sku: p.code,
                basePrice: new Decimal(p.basePrice || 0),
                salePrice: p.actionPrice ? new Decimal(p.actionPrice) : undefined,
                productMaxDiscount: p.productMaxDiscount ? new Decimal(p.productMaxDiscount) : undefined,
                customerTier: pl.name as CustomerTier,
                allowLoyaltyDiscount: true
            };

            try {
                const inputValidation = validationEngine.validateInput(input);
                if (inputValidation.valid) {
                    const res = engine.calculatePrice(input);
                    const resultValidation = validationEngine.validateResult(res);
                    if (resultValidation.valid && !res.rejected) {
                        itemResult.prices[pl.name] = res.finalPrice.toFixed(4);
                    }
                }
            } catch (e) {
                // Ignore calculation errors for specific products
            }
        }
        results.push(itemResult);
    }

    return results;
}
