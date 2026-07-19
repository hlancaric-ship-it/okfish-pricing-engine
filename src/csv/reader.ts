import { parse } from 'csv-parse';
import * as fs from 'fs';
import Decimal from 'decimal.js';
import { Product } from '../core/interfaces.js';

export async function readProductsCsv(filePath: string): Promise<Product[]> {
    return new Promise((resolve, reject) => {
        const results: Product[] = [];
        fs.createReadStream(filePath)
            .pipe(parse({
                delimiter: ';',
                columns: true,
                trim: true,
                skip_empty_lines: true
            }))
            .on('data', (data) => {
                const product: Product = {
                    sku: data.Code,
                    basePrice: new Decimal(data.Price || 0),
                };
                if (data.SalePrice) {
                    product.salePrice = new Decimal(data.SalePrice);
                }
                if (data.MaxDiscount) {
                    product.productLimitDiscount = new Decimal(data.MaxDiscount).dividedBy(100);
                }
                results.push(product);
            })
            .on('end', () => resolve(results))
            .on('error', (err) => reject(err));
    });
}
