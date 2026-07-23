import { describe, it, expect } from 'vitest';
import { buildShopItemXml } from '../src/feed-generator';
import { calculateAllTierPrices, CsvRow } from '../src/engine/pricing';
import { TIER_NAMES } from '../src/engine/config';

// Regression coverage for the CRITICAL BUG: the source feed contains internal columns
// like "pricelist:29:price", "variant:Farba", "stock:Predvolený sklad",
// "filteringProperty:*Dĺžka" that must NEVER become XML element names — either because
// they'd be structurally invalid (>1 colon, e.g. "pricelist:29:price"), or simply because
// they aren't part of Shoptet's official schema at all (single-colon "namespace-looking"
// names with no declared namespace, spaces, or other characters invalid in an element
// name). The generator no longer echoes ANY raw CSV column as a tag — only the fixed,
// verified-against-exports/products.xml set of official elements is ever emitted.

function extractTagNames(xml: string): string[] {
    const names: string[] = [];
    const re = /<\/?([^\s/>]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
        if (m[1] !== '?xml') names.push(m[1]);
    }
    return names;
}

function countColons(name: string): number {
    return (name.match(/:/g) || []).length;
}

function sampleRow(extra: CsvRow = {}): CsvRow {
    return {
        code: '97062',
        name: 'nastraha KEITECH',
        price: '6,25',
        purchasePrice: '4,00',
        standardPrice: '6,25',
        priceRatio: '1',
        actionPrice: '5,50',
        maxDiscount: '20',
        percentVat: '23',
        'pricelist:29:price': '4,69',
        'pricelist:29:priceRatio': '1',
        'pricelist:2:standardPrice': '6,25',
        'variant:Farba': 'Ayu',
        'stock:Predvolený sklad': '28',
        'filteringProperty:*Dĺžka': '3,60',
        ...extra
    };
}

describe('XML element name safety', () => {
    it('never emits an element name with more than one colon', () => {
        const row = sampleRow();
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        for (const tag of extractTagNames(xml)) {
            expect(countColons(tag)).toBeLessThanOrEqual(1);
        }
    });

    it('never emits ANY colon in an element name (no raw CSV column ever becomes a tag)', () => {
        const row = sampleRow();
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        for (const tag of extractTagNames(xml)) {
            expect(tag).not.toContain(':');
        }
    });

    it('drops all known internal CSV column shapes entirely (regression for the reported bug)', () => {
        const row = sampleRow();
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        expect(xml).not.toContain('pricelist:29:price');
        expect(xml).not.toContain('variant:Farba');
        expect(xml).not.toContain('stock:Predvolený sklad');
        expect(xml).not.toContain('filteringProperty');
        expect(xml).not.toMatch(/<[a-zA-Z]+:[^>]*>/); // no namespace-looking tag at all
    });

    it('emits only the official Shoptet elements verified against exports/products.xml', () => {
        const row = sampleRow();
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        const allowedTags = new Set([
            'SHOPITEM', 'CODE', 'PRICELISTS', 'PRICELIST', 'TITLE', 'PRICE',
            'PURCHASE_PRICE', 'STANDARD_PRICE', 'PRICE_RATIO', 'MIN_PRICE_RATIO', 'ACTION_PRICE',
            'APPLY_LOYALTY_DISCOUNT', 'APPLY_VOLUME_DISCOUNT', 'APPLY_QUANTITY_DISCOUNT',
            'APPLY_DISCOUNT_COUPON', 'FREE_SHIPPING', 'FREE_BILLING', 'MINIMAL_AMOUNT',
            'MAXIMAL_AMOUNT'
        ]);
        for (const tag of extractTagNames(xml)) {
            expect(allowedTags.has(tag)).toBe(true);
        }
    });

    it('every PRICELIST includes all required elements, for every tier', () => {
        const row = sampleRow();
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        const pricelistBlocks = xml.match(/<PRICELIST>.*?<\/PRICELIST>/gs) ?? [];
        expect(pricelistBlocks.length).toBe(TIER_NAMES.length);
        const required = [
            'TITLE', 'PRICE', 'PURCHASE_PRICE', 'STANDARD_PRICE', 'PRICE_RATIO',
            'MIN_PRICE_RATIO', 'ACTION_PRICE', 'APPLY_LOYALTY_DISCOUNT',
            'APPLY_VOLUME_DISCOUNT', 'APPLY_QUANTITY_DISCOUNT', 'APPLY_DISCOUNT_COUPON',
            'FREE_SHIPPING', 'FREE_BILLING', 'MINIMAL_AMOUNT', 'MAXIMAL_AMOUNT'
        ];
        for (const block of pricelistBlocks) {
            for (const tag of required) {
                expect(block, `missing <${tag}> in ${block}`).toMatch(new RegExp(`<${tag}(/>|>)`));
            }
        }
    });

    // Regression test for a real Shoptet RNG validation failure: an empty/self-closed
    // <PRICE_VAT/> is rejected ("character content of element PRICE_VAT invalid; must be
    // a decimal number"), unlike ACTION_PRICE/MINIMAL_AMOUNT/MAXIMAL_AMOUNT which validate
    // fine self-closed. Since we never populate PRICE_VAT (see note below), it must never
    // appear in the output at all — not even self-closed.
    it('never emits <PRICE_VAT> at all (would fail Shoptet RNG validation if empty)', () => {
        const row = sampleRow();
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        expect(xml).not.toContain('PRICE_VAT');
    });

    it('carries the computed VIP tier price GROSS, unconverted, in <PRICE> (not dropped)', () => {
        const row = sampleRow();
        const tierPrices = calculateAllTierPrices(row);
        const xml = buildShopItemXml(row, tierPrices);
        for (const tier of TIER_NAMES) {
            const expectedGross = tierPrices[tier].price.toFixed(2);
            expect(xml).toContain(`<PRICE>${expectedGross}</PRICE>`);
        }
    });

    // VAT handling: CONFIRMED via direct inspection of Shoptet's own reference export
    // (exports/products.xml) — none of its 166,330 real <PRICELIST> blocks contain a
    // <VAT> or <PRICE_VAT> element (those live only once, at <SHOPITEM> level, outside
    // <PRICELISTS>), and per-tier PRICE/STANDARD_PRICE values are on the SAME (gross)
    // scale as the SHOPITEM-level <PRICE_VAT> — e.g. a real item's <PRICE_VAT>61.45</PRICE_VAT>
    // exactly matches its own top <PRICELIST>'s <STANDARD_PRICE>61.45</STANDARD_PRICE>.
    // So <PRICELIST> prices must be emitted gross/unconverted, with no <VAT> element.
    it('emits the computed VIP tier price gross (unconverted) in <PRICE>, with no <VAT> or <PRICE_VAT> in the block', () => {
        const row = sampleRow({ price: '6,25', percentVat: '23', applyLoyaltyDiscount: '1' });
        const tierPrices = calculateAllTierPrices(row);
        const xml = buildShopItemXml(row, tierPrices);
        const zr4Block = xml.match(/<PRICELIST><TITLE>ZR4<\/TITLE>.*?<\/PRICELIST>/)![0];

        const grossPrice = tierPrices['ZR4'].price; // e.g. 6.00

        expect(zr4Block).not.toContain('<VAT>');
        expect(zr4Block).not.toContain('PRICE_VAT');
        expect(zr4Block).toContain(`<PRICE>${grossPrice.toFixed(2)}</PRICE>`);
    });

    it('identifies the product via the <CODE> element (matches Shoptet\'s official VariantItem.xml sample and RNG schema — not an import-code attribute)', () => {
        const row = sampleRow({ code: 'ABC-123' });
        const xml = buildShopItemXml(row, calculateAllTierPrices(row));
        expect(xml).toMatch(/<SHOPITEM><CODE>ABC-123<\/CODE>/);
        expect(xml).not.toContain('import-code');
    });
});
