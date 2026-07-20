import { EngineBuilder } from '../src/core/EngineBuilder.js';
import { PricingInput } from '../src/core/interfaces.js';
import { stringify } from 'csv-stringify';
import * as fs from 'fs';
import * as path from 'path';
import { PassThrough } from 'stream';
import Decimal from 'decimal.js';

const engine = EngineBuilder.fromConfig('src/config/policies/policy-v1.json').build();
const tiers = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"] as const;

function generateProducts(count: number): PricingInput[] {
    const products: PricingInput[] = [];
    for (let i = 0; i < count; i++) {
        products.push({
            sku: `SKU-${i}`,
            basePrice: new Decimal(Math.random() * 100 + 10),
            salePrice: Math.random() > 0.5 ? new Decimal(Math.random() * 80 + 5) : undefined,
            allowLoyaltyDiscount: true,
            productMaxDiscount: new Decimal("0.15")
        });
    }
    return products;
}

async function runEngineOnly(products: PricingInput[]) {
    const startMemory = process.memoryUsage().heapUsed;
    const start = performance.now();
    let peakMemory = startMemory;

    for (const tier of tiers) {
        for (const product of products) {
            engine.calculatePrice({ ...product, customerTier: tier });
        }
        const currentMem = process.memoryUsage().heapUsed;
        if (currentMem > peakMemory) peakMemory = currentMem;
    }

    const end = performance.now();
    return {
        elapsedSecs: ((end - start) / 1000).toFixed(2),
        peakRamMB: ((peakMemory - startMemory) / 1024 / 1024).toFixed(2)
    };
}

async function runStreaming(products: PricingInput[]) {
    const startMemory = process.memoryUsage().heapUsed;
    const start = performance.now();
    let peakMemory = startMemory;

    const promises = tiers.map(tier => {
        return new Promise<void>((resolve, reject) => {
            const stringifier = stringify({ header: true, delimiter: ';' });
            const passThrough = new PassThrough();
            stringifier.pipe(passThrough);

            passThrough.on('data', () => {}); // consume
            passThrough.on('end', () => resolve());
            passThrough.on('error', reject);

            for (const product of products) {
                const res = engine.calculatePrice({ ...product, customerTier: tier });
                stringifier.write({ Code: res.sku, Price: res.finalPrice.toFixed(2) });
            }
            stringifier.end();
            const currentMem = process.memoryUsage().heapUsed;
            if (currentMem > peakMemory) peakMemory = currentMem;
        });
    });

    await Promise.all(promises);

    const end = performance.now();
    return {
        elapsedSecs: ((end - start) / 1000).toFixed(2),
        peakRamMB: ((peakMemory - startMemory) / 1024 / 1024).toFixed(2)
    };
}

async function runProduction(products: PricingInput[], outDir: string) {
    const startMemory = process.memoryUsage().heapUsed;
    const start = performance.now();
    let peakMemory = startMemory;

    const promises = tiers.map(tier => {
        return new Promise<void>((resolve, reject) => {
            const stringifier = stringify({ header: true, delimiter: ';' });
            const fileStream = fs.createWriteStream(path.join(outDir, `${tier}.csv`));
            stringifier.pipe(fileStream);

            fileStream.on('finish', () => resolve());
            fileStream.on('error', reject);

            for (const product of products) {
                const res = engine.calculatePrice({ ...product, customerTier: tier });
                stringifier.write({ Code: res.sku, Price: res.finalPrice.toFixed(2) });
            }
            stringifier.end();
            const currentMem = process.memoryUsage().heapUsed;
            if (currentMem > peakMemory) peakMemory = currentMem;
        });
    });

    await Promise.all(promises);

    const end = performance.now();
    return {
        elapsedSecs: ((end - start) / 1000).toFixed(2),
        peakRamMB: ((peakMemory - startMemory) / 1024 / 1024).toFixed(2)
    };
}

async function main() {
    console.log("=== Shoptet Pricing Engine Benchmark ===");
    const counts = [16000, 50000, 100000];
    
    for (const count of counts) {
        console.log(`\n--- ${count} products ---`);
        const products = generateProducts(count);
        
        if (global.gc) global.gc();
        const engineStats = await runEngineOnly(products);
        console.log(`Engine Only:  ${engineStats.elapsedSecs} s | ${engineStats.peakRamMB} MB RAM`);

        if (global.gc) global.gc();
        const streamingStats = await runStreaming(products);
        console.log(`Streaming:    ${streamingStats.elapsedSecs} s | ${streamingStats.peakRamMB} MB RAM`);

        if (global.gc) global.gc();
        const tempDir = fs.mkdtempSync(path.join(process.cwd(), 'temp-bench-'));
        const prodStats = await runProduction(products, tempDir);
        console.log(`Production:   ${prodStats.elapsedSecs} s | ${prodStats.peakRamMB} MB RAM`);
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(console.error);
