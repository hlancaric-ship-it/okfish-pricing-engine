import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { Transform } from "stream";
import Decimal from 'decimal.js';
import * as os from 'os';

import { EngineBuilder } from "../core/EngineBuilder.js";
import { ValidationEngine } from "../core/ValidationEngine.js";
import { CustomerTier } from "../core/interfaces.js";

const TIER_MAPPING = [
    { tier: "ZR4" as CustomerTier, col: "pricelist:2:price" },
    { tier: "ZR6" as CustomerTier, col: "pricelist:5:price" },
    { tier: "ZR8" as CustomerTier, col: "pricelist:8:price" },
    { tier: "ZR10" as CustomerTier, col: "pricelist:11:price" },
    { tier: "ZR12" as CustomerTier, col: "pricelist:14:price" },
    { tier: "ZR14" as CustomerTier, col: "pricelist:17:price" },
    { tier: "ZR16" as CustomerTier, col: "pricelist:20:price" },
    { tier: "ZR18" as CustomerTier, col: "pricelist:23:price" },
    { tier: "ZR20" as CustomerTier, col: "pricelist:26:price" },
    { tier: "ZR25" as CustomerTier, col: "pricelist:29:price" }
];

async function runBenchmark(productCount: number) {
    const inputCsv = path.join(process.cwd(), `products_mock_${productCount}.csv`);
    if (!fs.existsSync(inputCsv)) {
        console.error(`Chyba: Vstupní soubor ${inputCsv} neexistuje! Spusťte nejdřív generátor.`);
        process.exit(1);
    }

    const configPath = 'src/config/policies/policy-v1.json';
    const engine = EngineBuilder.fromConfig(configPath).build();
    const validationEngine = new ValidationEngine();

    console.log(`\n🚀 Spouštím Benchmark pro ${productCount} produktů...`);
    
    // CPU Start
    const cpuStart = os.cpus().map(cpu => cpu.times);
    const startMs = performance.now();
    let peakMemory = 0;
    
    const memInterval = setInterval(() => {
        const mem = process.memoryUsage().heapUsed;
        if (mem > peakMemory) peakMemory = mem;
    }, 50);

    let processed = 0;

    await new Promise((resolve, reject) => {
        const parser = parse({
            delimiter: ';',
            columns: true,
            skip_empty_lines: true,
            bom: true
        });

        const transform = new Transform({
            objectMode: true,
            transform(row: any, encoding: string, callback: any) {
                processed++;
                if ("" in row) delete row[""];
                
                const applyLoyalty = row.applyLoyaltyDiscount === "1" || row.applyLoyaltyDiscount === "true" || row.applyLoyaltyDiscount === "yes" || row.applyLoyaltyDiscount === true || row.applyLoyaltyDiscount === undefined;
                const parseNumber = (val: any) => {
                    if (!val) return undefined;
                    if (typeof val === 'string') return val.replace(',', '.');
                    return val;
                };

                const parsedBasePrice = parseNumber(row.standardPrice || row.price);
                const parsedSalePrice = parseNumber(row.actionPrice);
                const parsedMaxDiscount = parseNumber(row.maxDiscount);
                const parsedPurchasePrice = parseNumber(row.purchasePrice);

                for (const m of TIER_MAPPING) {
                    const input = {
                        sku: row.code,
                        basePrice: new Decimal(parsedBasePrice || 0),
                        salePrice: parsedSalePrice ? new Decimal(parsedSalePrice) : undefined,
                        customerTier: m.tier,
                        allowLoyaltyDiscount: applyLoyalty,
                        productMaxDiscount: parsedMaxDiscount ? new Decimal(parsedMaxDiscount).dividedBy(100) : undefined,
                        manufacturer: row.manufacturer,
                        category: row.categoryText,
                        purchasePrice: parsedPurchasePrice ? new Decimal(parsedPurchasePrice) : undefined,
                        currency: row.currency
                    };
                    
                    try {
                        const inputValidation = validationEngine.validateInput(input);
                        if (!inputValidation.valid) { row[m.col] = ""; continue; }

                        const result = engine.calculatePrice(input);
                        
                        const resultValidation = validationEngine.validateResult(result);
                        if (!resultValidation.valid || result.rejected) { row[m.col] = ""; continue; }

                        row[m.col] = result.finalPrice.toFixed(2).replace('.', ',');
                    } catch (e: any) {
                        row[m.col] = "";
                    }
                }
                callback(null, row);
            }
        });

        const stringifier = stringify({ header: true, delimiter: ';' });

        // Nechceme opotřebovávat disk při benchmarku zbytečným zápisem (nebo aspoň zapíšeme do null / dev/null)
        // K vyzkoušení end-to-end použijeme dev/null na macu a linuxu
        const outStream = fs.createWriteStream(os.platform() === 'win32' ? '\\\\.\\NUL' : '/dev/null');

        const readStream = fs.createReadStream(inputCsv);
        readStream.pipe(parser).pipe(transform).pipe(stringifier).pipe(outStream);
        
        outStream.on('finish', () => resolve(true));
        outStream.on('error', reject);
        readStream.on('error', reject);
    });

    clearInterval(memInterval);
    const endMs = performance.now();
    const duration = (endMs - startMs) / 1000;
    
    const cpuEnd = os.cpus().map(cpu => cpu.times);
    let totalIdle = 0, totalTick = 0;
    for(let i = 0; i < cpuEnd.length; i++) {
        const typeStart = cpuStart[i];
        const typeEnd = cpuEnd[i];
        
        let idleStart = typeStart.idle;
        let idleEnd = typeEnd.idle;
        
        let tickStart = Object.values(typeStart).reduce((acc, tv) => acc + tv, 0);
        let tickEnd = Object.values(typeEnd).reduce((acc, tv) => acc + tv, 0);
        
        totalIdle += idleEnd - idleStart;
        totalTick += tickEnd - tickStart;
    }
    const cpuUsage = 100 - ~~(100 * totalIdle / totalTick);

    console.log(`✅ Hotovo!`);
    console.log(`⏱️  Čas:       ${duration.toFixed(2)} sekund`);
    console.log(`💾 Peak RAM:  ${(peakMemory / 1024 / 1024).toFixed(2)} MB`);
    console.log(`💻 Využití CPU: ~${cpuUsage} %`);

    if (productCount >= 100000) {
        if (duration > 45.0) {
            console.error(`❌ OCHRANA VÝKONU ZABRALA: 100k produktů trvalo déle než 45 sekund (${duration.toFixed(2)} s). Může jít o závažnou regresi!`);
            process.exit(1);
        } else if (duration > 30.0) {
            console.warn(`⚠️ VÝKONNOSTNÍ VAROVÁNÍ: 100k produktů trvalo déle než 30 sekund (${duration.toFixed(2)} s). Zkontrolujte případné neefektivity v kódu.`);
        } else {
            console.log(`✅ Výkon je v normě (pod 30 sekund).`);
        }
    }
}

const count = parseInt(process.argv[2], 10);
if (isNaN(count)) {
    console.error("Zadejte počet produktů pro benchmark (např. 100000)");
    process.exit(1);
}

runBenchmark(count).catch(console.error);
