import { parse } from 'csv-parse';
import * as fs from 'fs';
import Decimal from 'decimal.js';
import { PricingInput } from '../core/interfaces.js';

export async function readProductsCsv(filePath: string): Promise<PricingInput[]> {
    return new Promise((resolve, reject) => {
        const results: PricingInput[] = [];
        fs.createReadStream(filePath)
            .pipe(parse({
                delimiter: ';',
                columns: true,
                trim: true,
                skip_empty_lines: true
            }))
            .on('data', (row) => {
                const applyLoyalty = row.applyLoyaltyDiscount !== undefined 
                    ? ['1', 'true', 'yes'].includes(String(row.applyLoyaltyDiscount).toLowerCase())
                    : true; 

                const basePriceStr = row.standardPrice || row.price || "0";

                const input: PricingInput = {
                    sku: row.code,
                    basePrice: new Decimal(basePriceStr),
                    allowLoyaltyDiscount: applyLoyalty
                };

                if (row.actionPrice) {
                    input.salePrice = new Decimal(row.actionPrice);
                }
                if (row.maxDiscount) {
                    input.productMaxDiscount = new Decimal(row.maxDiscount).dividedBy(100);
                }
                if (row.manufacturer) {
                    input.manufacturer = row.manufacturer;
                }
                if (row.categoryText) {
                    input.category = row.categoryText;
                }
                if (row.purchasePrice) {
                    input.purchasePrice = new Decimal(row.purchasePrice);
                }
                if (row.percentVat) {
                    input.vatRate = new Decimal(row.percentVat);
                }
                
                results.push(input);
            })
            .on('end', () => resolve(results))
            .on('error', (err) => reject(err));
    });
}
