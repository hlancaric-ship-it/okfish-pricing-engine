// The single, canonical <PRICELIST> XML generator — used by BOTH the Cloudflare Worker
// (cloudflare-worker/src/feed-generator.ts) and the local CLI (src/cli/generate-xml.ts).
// Deliberately dependency-free (no Decimal.js, no Node APIs) so it works unmodified in
// both a Workers isolate and plain Node.
//
// Structure verified directly against Shoptet's own real reference export
// (exports/products.xml in this repo) and official RELAX NG schema
// (https://www.shoptet.cz/export/schema/products-complete-v10.rng): TITLE is the only
// required element; PRICE, PURCHASE_PRICE, STANDARD_PRICE, PRICE_RATIO, MIN_PRICE_RATIO,
// ACTION_PRICE, APPLY_LOYALTY_DISCOUNT, APPLY_VOLUME_DISCOUNT, APPLY_QUANTITY_DISCOUNT,
// APPLY_DISCOUNT_COUPON, FREE_SHIPPING, FREE_BILLING, MINIMAL_AMOUNT, MAXIMAL_AMOUNT are
// all valid optional elements.
//
// Having ONE implementation (instead of the two separate, incomplete, drifted copies
// this repo used to have — src/xml/PricelistXMLWriter.ts and
// cloudflare-worker/src/xml/PricelistXMLWriter.ts, both now deleted) is what guarantees
// the CLI and the Worker produce byte-identical <PRICELIST> output for equivalent input,
// rather than relying on two hand-maintained implementations happening to agree.

// price / purchasePrice / standardPrice / actionPrice are all GROSS (VAT-included) —
// matching the source feed's own `includingVat=1` values, and exactly how the discount
// math is computed (no VAT arithmetic happens anywhere in the pricing engines).
//
// VAT handling status (2026-07-23): CONFIRMED via direct inspection of Shoptet's own
// reference export (exports/products.xml, 166,330 real <PRICELIST> blocks): NONE of
// them contain a <VAT> or <PRICE_VAT> element — those only ever appear once, at the
// <SHOPITEM> level, outside <PRICELISTS> entirely. And the per-tier PRICE/STANDARD_PRICE
// values inside <PRICELIST> are on the SAME (gross) scale as the SHOPITEM-level
// <PRICE_VAT> — e.g. one real item's top-level <PRICE_VAT>61.45</PRICE_VAT> matches its
// own top <PRICELIST>'s <STANDARD_PRICE>61.45</STANDARD_PRICE> exactly, byte for byte.
// So <PRICELIST> prices must be emitted GROSS, unconverted, with no <VAT> element at
// all — dividing by (1 + vatRate/100) here (as this file previously did) silently
// halved-then-some every tier price relative to what Shoptet's own automatic import
// expects, which is why imported pricelists computed differently than intended.
export interface PricelistInputs {
    price: number;
    purchasePrice?: number;
    standardPrice?: number;
    priceRatio?: number;
    minPriceRatio?: number;
    /** The actual action price value, only emitted when usedActionPrice is true. */
    actionPrice?: number;
    usedActionPrice?: boolean;
    /** VAT rate as a percentage, e.g. 23 for 23%. Used to convert price/purchasePrice/standardPrice/actionPrice to net. */
    vatRatePercent?: number;
    applyLoyaltyDiscount?: boolean;
    applyVolumeDiscount?: boolean;
    applyQuantityDiscount?: boolean;
    applyDiscountCoupon?: boolean;
    freeShipping?: boolean;
    freeBilling?: boolean;
    minimalAmount?: number;
    maximalAmount?: number;
}

function escapeXml(str: string): string {
    if (!/[&<>"']/.test(str)) return str;
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function num(n: number | undefined): string {
    return n === undefined ? '' : n.toFixed(2);
}

function bool(b: boolean | undefined): string {
    return b ? '1' : '0';
}

// Emits <TAG>value</TAG>, or a self-closing <TAG/> when value is empty/undefined —
// matches the pattern used throughout the real Shoptet reference export.
function el(tag: string, value: string | undefined): string {
    return value === undefined || value === '' ? `<${tag}/>` : `<${tag}>${escapeXml(value)}</${tag}>`;
}

export function buildPricelistXml(title: string, data: PricelistInputs): string {
    const parts: string[] = ['<PRICELIST>'];
    parts.push(el('TITLE', title));
    parts.push(el('PRICE', num(data.price)));
    parts.push(el('PURCHASE_PRICE', num(data.purchasePrice)));
    parts.push(el('STANDARD_PRICE', num(data.standardPrice)));
    // VAT / PRICE_VAT are never emitted inside <PRICELIST> — confirmed absent from all
    // 166,330 blocks in Shoptet's own reference export (exports/products.xml). VAT lives
    // only once, at the <SHOPITEM> level, outside <PRICELISTS>.
    parts.push(el('PRICE_RATIO', data.priceRatio !== undefined ? String(data.priceRatio) : '1'));
    parts.push(el('MIN_PRICE_RATIO', String(data.minPriceRatio ?? 0)));
    parts.push(el('ACTION_PRICE', data.usedActionPrice ? num(data.actionPrice) : undefined));
    parts.push(el('APPLY_LOYALTY_DISCOUNT', bool(data.applyLoyaltyDiscount)));
    parts.push(el('APPLY_VOLUME_DISCOUNT', bool(data.applyVolumeDiscount)));
    parts.push(el('APPLY_QUANTITY_DISCOUNT', bool(data.applyQuantityDiscount)));
    parts.push(el('APPLY_DISCOUNT_COUPON', bool(data.applyDiscountCoupon)));
    parts.push(el('FREE_SHIPPING', bool(data.freeShipping)));
    parts.push(el('FREE_BILLING', bool(data.freeBilling)));
    parts.push(el('MINIMAL_AMOUNT', num(data.minimalAmount)));
    parts.push(el('MAXIMAL_AMOUNT', num(data.maximalAmount)));
    parts.push('</PRICELIST>');
    return parts.join('');
}

export function buildPricelistsXml(entries: Array<{ title: string; data: PricelistInputs }>): string {
    const parts: string[] = ['<PRICELISTS>'];
    for (const { title, data } of entries) {
        parts.push(buildPricelistXml(title, data));
    }
    parts.push('</PRICELISTS>');
    return parts.join('');
}
