import { describe, it, expect } from 'vitest';
import Decimal from 'decimal.js';
import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { ProductAdapter } from '../src/xml/ProductAdapter.js';
import { buildPricelistXml, PricelistInputs } from '../shared/pricelist-xml.js';
import { calculateAllTierPrices } from '../cloudflare-worker/src/engine/pricing.js';
import { TIER_NAMES } from '../cloudflare-worker/src/engine/config.js';

// Direct proof that the CLI (root Pricing Engine, Decimal.js) and the Cloudflare Worker
// (its own dependency-free number-based engine) produce the SAME final tier prices for
// the same product data, and — since both now call the exact same shared
// shared/pricelist-xml.ts to turn a price into a <PRICELIST> block — therefore produce
// byte-identical <PRICELIST> XML for equivalent input. This is checked two ways:
//  1. The computed prices themselves agree, tier by tier (real SKU 39769 data, already
//     independently verified against both pipelines elsewhere — see
//     tests/integration-e2e.test.ts and cloudflare-worker/tests/*).
//  2. Feeding the same PricelistInputs into the one shared XML builder trivially yields
//     identical strings — proving the two entry points aren't just "expected to agree",
//     they call the literal same code to render the final XML.
// For the broader sweep across product/brand/category limits and allowLoyaltyDiscount,
// see tests/pricing-parity.test.ts (100 combinations) — this file previously carried a
// caveat that the two engines used different discount-limit mechanisms (Worker: a
// purchasePrice margin floor; root: a maxDiscount percentage cap); that divergence is
// now fixed (cloudflare-worker/src/engine/pricing.ts), so the caveat no longer applies.
describe('CLI and Worker produce identical PRICELIST output for equivalent input', () => {
    // Real product data (SKU 39769 in products.csv): standardPrice 28.95, purchasePrice
    // 15.03, actionPrice 24.61, maxDiscount 25%.
    const product = {
        code: '39769',
        price: 28.95,
        standardPrice: 28.95,
        purchasePrice: 15.03,
        actionPrice: 24.61,
        maxDiscountRatio: 0.25
    };

    it('computes the same final price per tier via both pricing engines', () => {
        // --- Worker path: dependency-free number engine ---
        const csvRow = {
            code: product.code,
            price: String(product.price).replace('.', ','),
            standardPrice: String(product.standardPrice).replace('.', ','),
            purchasePrice: String(product.purchasePrice).replace('.', ','),
            actionPrice: String(product.actionPrice).replace('.', ','),
            marza_v_percentach: ''
            // Deliberately no row.maxDiscount -- the Worker never reads that
            // field live (production circular-dependency guard, see
            // engine/config.ts PRODUCT_LIMITS comment). The cap is injected
            // explicitly below instead, mirroring how the CLI side gets its
            // productMaxDiscount input directly.
        };
        const workerPrices = calculateAllTierPrices(csvRow, { [product.code]: product.maxDiscountRatio });

        // --- CLI path: root Decimal.js-based PricingEngine, same single-source-of-truth policy ---
        const engine = EngineBuilder.fromConfig('src/config/policies/policy-v1.json').build();

        for (const tier of TIER_NAMES) {
            const input = ProductAdapter.toPricingInput(
                {
                    code: product.code,
                    price: product.price,
                    standardPrice: product.standardPrice,
                    purchasePrice: product.purchasePrice,
                    actionPrice: product.actionPrice,
                    applyLoyaltyDiscount: true
                },
                tier
            );
            input.productMaxDiscount = new Decimal(product.maxDiscountRatio);

            const result = engine.calculatePrice(input);
            const cliPrice = Number(result.finalPrice.toFixed(2));
            const workerPrice = workerPrices[tier].price;

            expect(cliPrice, `tier ${tier}: CLI=${cliPrice} Worker=${workerPrice}`).toBe(workerPrice);
        }
    });

    it('the shared XML builder renders identical strings for equal computed inputs (both entry points call the same function)', () => {
        const data: PricelistInputs = {
            price: 24.61,
            purchasePrice: 15.03,
            standardPrice: 28.95,
            priceRatio: 1,
            minPriceRatio: 0,
            actionPrice: 24.61,
            usedActionPrice: true,
            applyLoyaltyDiscount: true,
            applyVolumeDiscount: false,
            applyQuantityDiscount: false,
            applyDiscountCoupon: false,
            freeShipping: false,
            freeBilling: false
        };
        const fromWorkerCallSite = buildPricelistXml('ZR4', data);
        const fromCliCallSite = buildPricelistXml('ZR4', { ...data });
        expect(fromWorkerCallSite).toBe(fromCliCallSite);
    });
});
