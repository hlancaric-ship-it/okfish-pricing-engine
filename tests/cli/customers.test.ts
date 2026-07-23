import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { processCustomers } from '../../src/cli/customers.js';

describe('Customers CLI - Golden Test', () => {
    const fixturesDir = path.join(process.cwd(), 'tests', 'fixtures');
    const inputPath = path.join(fixturesDir, 'customers_golden_in.csv');
    const expectedPath = path.join(fixturesDir, 'customers_golden_expected.csv');
    const outputPath = path.join(fixturesDir, 'customers_golden_out.csv');

    let uploadCalls: Array<{ map: Record<string, number>; upgraded: number }> = [];
    // processCustomers() takes the upload step as an explicit parameter — this test
    // passes a fake so it never makes a real network call (the real uploadToWorker()
    // would hit whatever CF_WORKER_URL/CF_WORKER_TOKEN happen to be configured, which
    // in this repo's .env are real production credentials).
    const fakeUpload = async (map: Record<string, number>, upgraded: number) => {
        uploadCalls.push({ map, upgraded });
    };

    afterAll(() => {
        // Cleanup generated test files
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        const jsonFiles = fs.readdirSync(fixturesDir).filter(f => f.endsWith('.json'));
        for (const file of jsonFiles) {
            fs.unlinkSync(path.join(fixturesDir, file));
        }
    });

    it('should match the golden dataset output', async () => {
        // Run the processor with an injected fake upload — no real network call.
        await processCustomers(inputPath, outputPath, fakeUpload);

        // Read and compare
        const generatedContent = fs.readFileSync(outputPath, 'utf-8');
        const expectedContent = fs.readFileSync(expectedPath, 'utf-8');

        expect(generatedContent).toBe(expectedContent);
    });

    it('never calls the real uploadToWorker — only the injected fake', async () => {
        expect(uploadCalls.length).toBe(1);
    });
});
