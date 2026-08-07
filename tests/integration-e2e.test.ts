import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { XMLValidator } from 'fast-xml-parser';
import { generateXml } from '../src/cli/generate-xml.js';
import { generateProductsImportCsv } from '../src/cli/generate.js';

// Both blocks below actually RUN the real CLI generators (generate-xml.ts, generate.ts)
// end-to-end and inspect freshly generated output — neither reads nor depends on the
// historical exports/products.xml or exports/products_import.csv checked into this repo.
// generate.ts's core CSV logic is exercised directly (not via `npm run generate`), which
// also means the customers.ts step (a real uploadToWorker() network call using whatever
// production credentials happen to be in .env) is never invoked by this test.

describe('generate-xml.ts — real run against a fixture, fresh output', () => {
    const fixtureInput = path.join(process.cwd(), 'tests', 'fixtures', 'generate-xml', 'sample-input.xml');
    const outputPath = path.join(process.cwd(), 'tests', 'fixtures', 'generate-xml', 'output.generated.xml');

    let xml: string;

    beforeAll(async () => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
        const result = await generateXml(fixtureInput, outputPath);
        expect(result.totalProducts).toBe(3);
        expect(result.errorsCount).toBe(0);
        xml = fs.readFileSync(outputPath, 'utf-8');
    });

    afterAll(() => {
        if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
    });

    it('produces a freshly generated file, not the historical exports/products.xml', () => {
        expect(fs.existsSync(outputPath)).toBe(true);
        expect(outputPath).not.toContain(`${path.sep}exports${path.sep}products.xml`);
    });

    it('is well-formed XML (independent parser: fast-xml-parser)', () => {
        expect(XMLValidator.validate(xml)).toBe(true);
    });

    it('computes ordinary loyalty-tier prices for product 1001 (no limits, no action price)', () => {
        const expected: Record<string, string> = {
            ZR4: '96.00', ZR6: '94.00', ZR8: '92.00', ZR10: '90.00', ZR12: '88.00',
            ZR14: '86.00', ZR16: '84.00', ZR18: '82.00', ZR20: '80.00', ZR25: '75.00'
        };
        const block = xml.match(/<CODE>1001<\/CODE>[\s\S]*?<PRICELISTS>[\s\S]*?<\/PRICELISTS>/)![0];
        for (const [tier, price] of Object.entries(expected)) {
            const pricelist = block.match(new RegExp(`<PRICELIST><TITLE>${tier}<\\/TITLE>.*?<\\/PRICELIST>`))![0];
            expect(pricelist, `${tier} price`).toContain(`<PRICE>${price}</PRICE>`);
            expect(pricelist, `${tier} purchase price`).toContain('<PURCHASE_PRICE>60.00</PURCHASE_PRICE>');
            expect(pricelist, `${tier} standard price`).toContain('<STANDARD_PRICE>100.00</STANDARD_PRICE>');
        }
    });

    it('clamps price to the HUMMINBIRD brand discount limit (4%) for product 2002', () => {
        // HUMMINBIRD replaces the old Apple fixture (Apple's 5% brand limit was
        // removed from policy-v1.json at the client's request, 2026-08-06 --
        // see CHANGELOG). basePrice 50, cap 4% -> floor 48.00. ZR4's own 4%
        // loyalty tier lands exactly on the floor already; every deeper tier
        // (ZR6+) has a steeper loyalty % than the cap, so all clamp to 48.00.
        const block = xml.match(/<CODE>2002<\/CODE>[\s\S]*?<PRICELISTS>[\s\S]*?<\/PRICELISTS>/)![0];
        const zr4 = block.match(/<PRICELIST><TITLE>ZR4<\/TITLE>.*?<\/PRICELIST>/)![0];
        expect(zr4).toContain('<PRICE>48.00</PRICE>');
        for (const tier of ['ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14', 'ZR16', 'ZR18', 'ZR20', 'ZR25']) {
            const pricelist = block.match(new RegExp(`<PRICELIST><TITLE>${tier}<\\/TITLE>.*?<\\/PRICELIST>`))![0];
            expect(pricelist, `${tier} clamped to brand limit`).toContain('<PRICE>48.00</PRICE>');
        }
    });

    it('picks whichever of action price / loyalty price is lower, per tier, for product 3003', () => {
        const block = xml.match(/<CODE>3003<\/CODE>[\s\S]*?<PRICELISTS>[\s\S]*?<\/PRICELISTS>/)![0];

        for (const tier of ['ZR4', 'ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14']) {
            const pricelist = block.match(new RegExp(`<PRICELIST><TITLE>${tier}<\\/TITLE>.*?<\\/PRICELIST>`))![0];
            expect(pricelist, `${tier} uses action price`).toContain('<PRICE>24.61</PRICE>');
            expect(pricelist, `${tier} ACTION_PRICE populated`).toContain('<ACTION_PRICE>24.61</ACTION_PRICE>');
        }

        const expectedLoyalty: Record<string, string> = { ZR16: '24.32', ZR18: '23.74', ZR20: '23.16', ZR25: '21.71' };
        for (const [tier, price] of Object.entries(expectedLoyalty)) {
            const pricelist = block.match(new RegExp(`<PRICELIST><TITLE>${tier}<\\/TITLE>.*?<\\/PRICELIST>`))![0];
            expect(pricelist, `${tier} uses loyalty price`).toContain(`<PRICE>${price}</PRICE>`);
            expect(pricelist, `${tier} ACTION_PRICE empty`).toContain('<ACTION_PRICE/>');
        }
    });

    it('carries non-PRICELISTS content through unchanged (NAME, CATEGORIES)', () => {
        expect(xml).toContain('<NAME>Test Product A</NAME>');
        expect(xml).toContain('<CATEGORY id="1">Test &gt; Category A</CATEGORY>');
    });

    it('emits exactly 10 PRICELIST blocks per product, named after the single source of truth (policy-v1.json)', () => {
        const blocks = xml.match(/<CODE>1001<\/CODE>[\s\S]*?<PRICELISTS>([\s\S]*?)<\/PRICELISTS>/)![1];
        const titles = [...blocks.matchAll(/<TITLE>([^<]+)<\/TITLE>/g)].map(m => m[1]);
        expect(titles).toEqual(['ZR4', 'ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14', 'ZR16', 'ZR18', 'ZR20', 'ZR25']);
    });
});

describe('generate.ts — real run against the real products.csv, fresh output', () => {
    const tmpDir = path.join(process.cwd(), 'tests', 'fixtures', 'generate-csv-tmp');
    const importCsvPath = path.join(tmpDir, 'products_import.csv');
    const errorsCsvPath = path.join(tmpDir, 'errors.csv');
    let records: any[];

    beforeAll(async () => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        const result = await generateProductsImportCsv(
            path.join(process.cwd(), 'products.csv'),
            importCsvPath,
            errorsCsvPath
        );
        expect(result.totalProducts).toBe(16633);

        const content = fs.readFileSync(importCsvPath);
        records = parse(content, { delimiter: ';', columns: true, skip_empty_lines: true, bom: true });
    }, 30000); // processes the real 16633-row products.csv; slower under coverage instrumentation

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('generates a fresh products_import.csv, not the historical exports/products_import.csv', () => {
        expect(fs.existsSync(importCsvPath)).toBe(true);
        expect(importCsvPath).not.toContain(`${path.sep}exports${path.sep}products_import.csv`);
    });

    it('has exactly 16633 product rows', () => {
        expect(records.length).toBe(16633);
    });

    it('calculates correct prices for product 97062', () => {
        const product = records.find((r: any) => r.code === '97062');
        expect(product).toBeDefined();
        expect(product['pricelist:2:price']).toBe('6,00'); // ZR4
        expect(product['pricelist:11:price']).toBe('5,63'); // ZR10
        expect(product['pricelist:29:price']).toBe('4,69'); // ZR25
    });

    it('calculates correct prices for product 39769 (action price & max discount)', () => {
        const product = records.find((r: any) => r.code === '39769');
        expect(product).toBeDefined();

        // Standard: 28,95 | Action: 24,61 | Limit: 25% (floor would be 21,71)
        // Since a cap (25%) is active AND the product has its own action price,
        // DiscountLimitPolicy's SALE rule (added after the 2026-08-04 VAGNER
        // incident) makes the action price authoritative outright for EVERY
        // tier -- never watered down by a steeper loyalty discount, and never
        // re-clamped to the cap floor either. 24.61 on all 10 tiers.
        for (const id of [2, 5, 8, 11, 14, 17, 20, 23, 26, 29]) {
            expect(product[`pricelist:${id}:price`], `pricelist:${id}:price`).toBe('24,61');
        }
    });
});

describe('generate.ts — per-pricelist VAT columns, matching a real confirmed-working manual import', () => {
    // tests/fixtures/generate-csv-vat/input.csv is a copy of Desktop/test_product_46585.csv
    // — a file the user manually imported into Shoptet via CSV import, which displayed
    // correctly (no double-VAT). Its pricelist:<id>:includingVat / pricelist:<id>:percentVat
    // columns are the confirmed-correct mechanism: declare the price as VAT-included,
    // copied through as-is, no division anywhere.
    const tmpDir = path.join(process.cwd(), 'tests', 'fixtures', 'generate-csv-vat-tmp');
    const outputCsvPath = path.join(tmpDir, 'output.csv');
    let records: any[];

    beforeAll(async () => {
        if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
        fs.mkdirSync(tmpDir, { recursive: true });

        await generateProductsImportCsv(
            path.join(process.cwd(), 'tests', 'fixtures', 'generate-csv-vat', 'input.csv'),
            outputCsvPath,
            path.join(tmpDir, 'errors.csv')
        );
        const content = fs.readFileSync(outputCsvPath);
        records = parse(content, { delimiter: ';', columns: true, skip_empty_lines: true, bom: true });
    });

    afterAll(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('copies pricelist:<id>:includingVat and pricelist:<id>:percentVat through unconverted, for every pricelist', () => {
        const product = records.find((r: any) => r.code === '46585');
        expect(product).toBeDefined();
        for (const id of [2, 5, 8, 11, 14, 17, 20, 23, 26, 29]) {
            expect(product[`pricelist:${id}:includingVat`], `pricelist:${id}:includingVat`).toBe('1');
            expect(product[`pricelist:${id}:percentVat`], `pricelist:${id}:percentVat`).toBe('23');
        }
    });

    it('computes the price using the pricing engine (action price wins for all tiers here), independent of the VAT columns', () => {
        const product = records.find((r: any) => r.code === '46585');
        // basePrice 4,61, actionPrice 2,77, no maxDiscount -> action wins even at ZR25
        // (4.61 * 0.75 = 3.4575 > 2.77).
        for (const id of [2, 5, 8, 11, 14, 17, 20, 23, 26, 29]) {
            expect(product[`pricelist:${id}:price`], `pricelist:${id}:price`).toBe('2,77');
        }
    });
});
