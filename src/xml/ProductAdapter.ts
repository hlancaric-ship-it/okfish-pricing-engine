import Decimal from 'decimal.js';
import { Product } from '../core/types';
import { PricingInput, CustomerTier } from '../core/interfaces.js';

// Shape produced by generate-xml.ts's SAX parser while walking a real Shoptet product
// export: numeric fields are already parsed (parseFloat), not comma-decimal strings.
export interface SaxProductContext {
    code?: string;
    price?: number;
    priceVat?: number;
    standardPrice?: number;
    purchasePrice?: number;
    actionPrice?: number;
    manufacturer?: string;
    category?: string;
    currency?: string;
    applyLoyaltyDiscount?: boolean;
    /** VAT rate as a percentage (e.g. 23), from the source export's <VAT> element. */
    vatRatePercent?: number;
}

export class ProductAdapter implements Product {
    code: string;
    itemGroup?: string;
    basePrice: number;
    actionPrice?: number;
    purchasePrice?: number;
    vatRate: number;
    manufacturer?: string;
    category?: string;
    currency: string;
    customParameters: Record<string, string>;
    variants: string[];

    constructor(row: any, variants: string[]) {
        this.code = row.code;
        this.itemGroup = row.itemGroup;
        this.basePrice = this.parseNum(row.price) || 0;
        this.actionPrice = this.parseNum(row.actionPrice);
        this.purchasePrice = this.parseNum(row.purchasePrice);
        this.vatRate = this.parseNum(row.vat) || 20;
        this.manufacturer = row.manufacturer;
        this.category = row.category;
        this.currency = row.currency || 'EUR';
        this.customParameters = {
            'marza_v_percentach': row.marza_v_percentach || ''
        };
        this.variants = variants;
    }

    private parseNum(val: string | undefined): number | undefined {
        if (!val) return undefined;
        const normalized = val.replace(',', '.').replace(/[^0-9.-]/g, '');
        const num = parseFloat(normalized);
        return isNaN(num) ? undefined : num;
    }

    // Converts a SAX-parsed product context (from generate-xml.ts, walking a real
    // Shoptet product export) into the PricingEngine's PricingInput shape for a given
    // tier. Mirrors the same basePrice fallback chain generate.ts uses for the CSV path
    // (standardPrice -> price -> 0), so both CLI entry points feed the engine
    // equivalently for equivalent source data.
    static toPricingInput(context: SaxProductContext, tier: string): PricingInput {
        const basePrice = context.standardPrice ?? context.price ?? context.priceVat ?? 0;
        return {
            sku: context.code ?? '',
            basePrice: new Decimal(basePrice),
            salePrice: context.actionPrice !== undefined ? new Decimal(context.actionPrice) : undefined,
            customerTier: tier as CustomerTier,
            allowLoyaltyDiscount: context.applyLoyaltyDiscount ?? true,
            purchasePrice: context.purchasePrice !== undefined ? new Decimal(context.purchasePrice) : undefined,
            manufacturer: context.manufacturer,
            category: context.category,
            currency: context.currency
        };
    }
}
