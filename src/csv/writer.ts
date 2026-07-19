import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import { PricingResult } from '../core/interfaces.js';

export async function writeProductsCsv(filePath: string, contexts: PricingResult[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const writableStream = fs.createWriteStream(filePath);
        const stringifier = stringify({
            header: true,
            delimiter: ';',
            columns: [
                { key: 'Code', header: 'Code' },
                { key: 'Price', header: 'Price' }
            ]
        });
        
        stringifier.on('error', (err) => reject(err));
        writableStream.on('error', (err) => reject(err));
        writableStream.on('finish', () => resolve());

        stringifier.pipe(writableStream);

        for (const context of contexts) {
            stringifier.write({
                Code: context.sku,
                Price: context.finalPrice.toFixed(2)
            });
        }
        stringifier.end();
    });
}
