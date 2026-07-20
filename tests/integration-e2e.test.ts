import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { describe, it, expect, beforeAll } from 'vitest';

describe('Integration E2E Test', () => {
    const exportsDir = path.join(process.cwd(), 'exports');
    const importCsvPath = path.join(exportsDir, 'products_import.csv');
    
    beforeAll(() => {
        // Zkusíme vymazat staré exporty před spuštěním testu
        if (fs.existsSync(importCsvPath)) {
            fs.unlinkSync(importCsvPath);
        }
        
        // Spustíme kompletní generování
        execSync('npm run generate', { stdio: 'ignore' });
    });

    it('should generate products_import.csv successfully', () => {
        expect(fs.existsSync(importCsvPath)).toBe(true);
    });

    describe('Data correctness', () => {
        let records: any[];

        beforeAll(() => {
            const content = fs.readFileSync(importCsvPath);
            records = parse(content, {
                delimiter: ';',
                columns: true,
                skip_empty_lines: true,
                bom: true
            });
        });

        it('should have exactly 16633 product rows', () => {
            expect(records.length).toBe(16633);
        });

        it('should calculate correct prices for product 97062', () => {
            const product = records.find(r => r.code === '97062');
            expect(product).toBeDefined();
            
            // Expected prices from our validation
            expect(product['pricelist:2:price']).toBe('6,00'); // ZR4
            expect(product['pricelist:11:price']).toBe('5,63'); // ZR10
            expect(product['pricelist:29:price']).toBe('4,69'); // ZR25
        });

        it('should calculate correct prices for product 39769 (Action Price & Max Discount)', () => {
            const product = records.find(r => r.code === '39769');
            expect(product).toBeDefined();
            
            // Standard: 28,95 | Action: 24,61 | Limit: 25% (21,71)
            
            // Lower tiers should use Action price because their % discount is worse
            expect(product['pricelist:2:price']).toBe('24,61'); // ZR4 -> Action
            expect(product['pricelist:11:price']).toBe('24,61'); // ZR10 -> Action
            expect(product['pricelist:17:price']).toBe('24,61'); // ZR14 -> Action
            
            // Higher tiers switch to loyalty discount because it's better than action price
            expect(product['pricelist:20:price']).toBe('24,32'); // ZR16
            expect(product['pricelist:26:price']).toBe('23,16'); // ZR20
            
            // Maximum tier hits the product max discount limit (25% off 28,95 = 21,71)
            expect(product['pricelist:29:price']).toBe('21,71'); // ZR25
        });
    });
});
