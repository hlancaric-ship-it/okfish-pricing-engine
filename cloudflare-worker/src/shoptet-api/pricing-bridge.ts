import { EngineBuilder } from '../../../src/core/EngineBuilder.js';
import { ValidationEngine } from '../../../src/core/ValidationEngine.js';
import { CustomerTier, PricingInput } from '../../../src/core/interfaces.js';
import Decimal from 'decimal.js';
import * as path from 'path';

export interface PricingFailure {
    code: string;
    tier: string;
    reason: string;
}

export function calculateProductsPricing(products: Array<any>, pricelists: Array<{name: string, id: number}>): { results: Array<{code: string, prices: Record<string, string>}>; failures: PricingFailure[] } {
    // Používáme stávající v1.json konfiguraci
    const configPath = path.join(process.cwd(), 'src/config/policies/policy-v1.json');
    const engine = EngineBuilder.fromConfig(configPath).build();
    const validationEngine = new ValidationEngine();

    const results: Array<{code: string, prices: Record<string, string>}> = [];
    // Dřív se sem sbíralo NIC -- selhání validace/výpočtu se prostě zahodilo (viz
    // INCIDENT 2026-08-12: 99459 a 103525 skončily bez ceny na několika tierech a
    // run přesto doběhl jako "SUCCESS", protože žádný chybějící tier se nikde
    // nepočítal jako failure). Teď se každé tiché selhání jmenovitě loguje a hlásí
    // nahoru orchestrátoru, který podle toho běh označí jako neúspěšný.
    const failures: PricingFailure[] = [];

    for (const p of products) {
        const itemResult: {code: string, prices: Record<string, string>} = {
            code: p.code,
            prices: {}
        };

        const basePriceNum = p.basePrice || 0;
        // An "action price" that isn't actually lower than the base price is a
        // no-op leftover from an ended promotion whose field wasn't cleared --
        // must be treated as no sale, or DiscountLimitPolicy's "sale price always
        // wins" rule blocks all tier/cap pricing outright. Same fix applied to
        // the other two pricing engines on 2026-08-05/06 (confirmed live on
        // ~7247 catalog products, e.g. LOWRANCE code 111139).
        const salePriceNum = p.actionPrice && Number(p.actionPrice) < basePriceNum ? p.actionPrice : undefined;

        for (const pl of pricelists) {
            // "Hlavný cenník" a "Maloobchodný" přeskočíme, tam nemají být slevy
            // Ceníky se ve starém systému jmenovaly ZR4, ZR6...
            // My budeme posílat název ceníku jako customerTier do engine
            const input: PricingInput = {
                sku: p.code,
                basePrice: new Decimal(basePriceNum),
                salePrice: salePriceNum !== undefined ? new Decimal(salePriceNum) : undefined,
                // Deliberately NOT passing p.productMaxDiscount here anymore. It comes
                // straight from Shoptet's live sales.minPriceRatio on the base
                // pricelist -- the SAME field the coupon-fields export writes GUEST's
                // computed coupon room into (e.g. 5% for Delphin, ~20% for ordinary
                // products). DiscountLimitPolicy's Product->Brand->Category hierarchy
                // treats a defined productMaxDiscount as authoritative and overrides
                // the correct brandLimits/categoryLimits from policy-v1.json, so this
                // would silently reintroduce the exact field-overload bug fixed
                // elsewhere on 2026-08-06 (e.g. capping Delphin at 5% instead of its
                // real flat 15% action price). Confirmed live 2026-08-06 -- brand
                // caps must come ONLY from policy-v1.json's brandLimits now.
                customerTier: pl.name as CustomerTier,
                allowLoyaltyDiscount: true,
                // Required for DiscountLimitPolicy's brand fallback (brandLimits in
                // policy-v1.json) to ever trigger -- without it, hard-cap brands get
                // NO cap applied at all. Confirmed live 2026-08-06 (LOWRANCE showed
                // 6% off on ZR6 despite its 4% cap before this was wired through).
                manufacturer: p.manufacturer
            };

            try {
                const inputValidation = validationEngine.validateInput(input);
                if (!inputValidation.valid) {
                    const reason = `input invalid: ${inputValidation.reason}`;
                    console.warn(`[pricing-bridge] ${p.code} / ${pl.name}: ${reason}`);
                    failures.push({ code: p.code, tier: pl.name, reason });
                    continue;
                }
                const res = engine.calculatePrice(input);
                const resultValidation = validationEngine.validateResult(res);
                if (!resultValidation.valid) {
                    const reason = `result invalid: ${resultValidation.reason}`;
                    console.warn(`[pricing-bridge] ${p.code} / ${pl.name}: ${reason}`);
                    failures.push({ code: p.code, tier: pl.name, reason });
                    continue;
                }
                if (res.rejected) {
                    const reason = `rejected by engine: ${res.rejectReason}`;
                    console.warn(`[pricing-bridge] ${p.code} / ${pl.name}: ${reason}`);
                    failures.push({ code: p.code, tier: pl.name, reason });
                    continue;
                }
                itemResult.prices[pl.name] = res.finalPrice.toFixed(4);
            } catch (e) {
                const reason = `exception: ${(e as Error).message}`;
                console.warn(`[pricing-bridge] ${p.code} / ${pl.name}: ${reason}`);
                failures.push({ code: p.code, tier: pl.name, reason });
            }
        }
        results.push(itemResult);
    }

    return { results, failures };
}
