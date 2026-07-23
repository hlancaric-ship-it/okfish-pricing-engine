export interface Product {
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
}

export interface PriceResult {
    price: number;
    actionPrice?: number;
    minPriceRatio: number;
}
