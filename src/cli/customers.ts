import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { CustomerTier } from '../core/interfaces.js';
import { uploadToWorker } from './upload.js';

export type UploadFn = (vipDiscountsMap: Record<string, number>, upgradedCustomers: number) => Promise<void>;

function determineTier(totalOrderValue: number): CustomerTier | undefined {
    if (totalOrderValue >= 10000) return "ZR25";
    if (totalOrderValue >= 7000) return "ZR20";
    if (totalOrderValue >= 5000) return "ZR18";
    if (totalOrderValue >= 2000) return "ZR16";
    if (totalOrderValue >= 1000) return "ZR14";
    if (totalOrderValue >= 700) return "ZR12";
    if (totalOrderValue >= 500) return "ZR10";
    if (totalOrderValue >= 300) return "ZR8";
    if (totalOrderValue >= 100) return "ZR6";
    return "ZR4"; // 0 - 99.99
}

export async function processCustomers(inputPath: string, outputPath: string, upload: UploadFn = uploadToWorker): Promise<void> {
    if (!fs.existsSync(inputPath)) {
        console.error(`❌ Soubor nenalezen: ${inputPath}`);
        process.exit(1);
    }

    console.log(`Zpracovávám ZÁKAZNICKÝ CSV soubor...`);

    const records: any[] = [];
    const stats: Record<string, number> = {};
    let totalCustomers = 0;
    let upgradedCustomers = 0;
    let diagnosticCount = 0;
    const vipDiscountsMap: Record<string, number> = {};

    const parser = fs.createReadStream(inputPath).pipe(
        parse({
            delimiter: ';',
            columns: true,
            skip_empty_lines: true
        })
    );

    for await (const row of parser) {
        totalCustomers++;

        const val = row.totalOrderValue;
        let total = 0;
        if (typeof val === 'string') {
            const clean = val.replace(',', '.').replace(/[^0-9.-]/g, '');
            total = clean ? parseFloat(clean) : 0;
        } else if (typeof val === 'number') {
            total = val;
        }

        const newTier = determineTier(total) || "ZR4";
        const email = row.email || "";

        if (email && newTier) {
            const discount = parseInt(newTier.replace('ZR', ''), 10);
            if (!isNaN(discount)) {
                vipDiscountsMap[email.toLowerCase()] = discount;
            }
        }
        const originalValue = (row.pricelistName ?? "").toString().trim();

        if (diagnosticCount < 20) {
            console.log(`[Diagnostic] Email: ${email} | Turnover: ${total} | Old: "${originalValue}" | New: "${newTier}"`);
            diagnosticCount++;
        }

        const oldNormalized = originalValue.toUpperCase();
        const newNormalized = newTier.toUpperCase();

        if (oldNormalized !== newNormalized) {
            upgradedCustomers++;
        }
        row.pricelistName = newTier;
        row.customerGroup = newTier;

        // Statistiky
        stats[newTier] = (stats[newTier] || 0) + 1;

        records.push(row);
    }

    return new Promise<void>((resolve, reject) => {
        const stringifier = stringify({
            header: true,
            delimiter: ';'
        });

        const writableStream = fs.createWriteStream(outputPath);
        
        stringifier.on('error', reject);
        writableStream.on('error', reject);
        writableStream.on('finish', () => {
            const sortedKeys = Object.keys(vipDiscountsMap).sort();
            const sortedMap: Record<string, number> = {};
            for (const key of sortedKeys) {
                sortedMap[key] = vipDiscountsMap[key];
            }

            const now = new Date();
            const dateStr = now.toISOString().replace('T', ' ').substring(0, 16);
            
            const v2Data = {
                generatedAt: dateStr,
                customersCount: totalCustomers,
                customers: sortedMap
            };
            const dir = path.dirname(outputPath);
            fs.writeFileSync(path.join(dir, 'vip-discounts.json'), JSON.stringify(v2Data, null, 2));

            console.log(`\n✅ Úspěšně vygenerováno: exports/customers_import.csv`);
            console.log(`✅ Úspěšně vygenerováno: exports/vip-discounts.json (Lokální záloha)`);
            console.log(`Celkem zákazníků: ${totalCustomers}\n`);
            console.log(`Beze změny: ${totalCustomers - upgradedCustomers}`);
            console.log(`Změněno:     ${upgradedCustomers}\n`);
            
            console.log(`Rozdělení do ceníků:`);
            const tiers = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];
            for (const tier of tiers) {
                const count = stats[tier] || 0;
                console.log(`${tier.padEnd(4, ' ')} : ${count.toString().padStart(6, ' ')} zákazníků`);
            }
            console.log();
            
            // Odeslání do Cloudflare Worker
            upload(vipDiscountsMap, upgradedCustomers).then(() => resolve()).catch(reject);
        });

        stringifier.pipe(writableStream);

        for (const record of records) {
            stringifier.write(record);
        }
        stringifier.end();
    });
}

// Only run as a CLI when this module is the entry point — importing it (e.g. from
// tests) must never trigger a real run or a real uploadToWorker() network call.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const inputPath = process.argv[2] || path.join(process.cwd(), 'customers.csv');
    const exportsDir = path.join(process.cwd(), 'exports');

    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
    }

    const outputPath = path.join(exportsDir, 'customers_import.csv');

    processCustomers(inputPath, outputPath).catch(console.error);
}
