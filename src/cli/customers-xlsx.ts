import * as fs from 'fs';
import * as crypto from 'crypto';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { CustomerTier } from "../core/interfaces.js";
import * as csvStringify from 'csv-stringify';
import { uploadToWorker } from './upload.js';

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

async function main() {
    const start = performance.now();

    const inputPath = path.join(process.cwd(), 'customers.xlsx');
    const exportsDir = path.join(process.cwd(), 'exports');
    const outputPath = path.join(exportsDir, 'customers_import.csv');

    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
    }

    if (!fs.existsSync(inputPath)) {
        console.error(`❌ Soubor nenalezen: ${inputPath}`);
        process.exit(1);
    }

    console.log(`Zpracovávám ZÁKAZNICKÝ XLSX soubor (streamování zapnuto)...`);

    const options = {
        sharedStrings: 'cache',
        hyperlinks: 'cache',
        worksheets: 'emit'
    };
    
    // @ts-ignore
    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(inputPath, options);
    
    const csvWriter = fs.createWriteStream(outputPath);
    const stringifier = csvStringify.stringify({ header: true });
    stringifier.pipe(csvWriter);

    let totalCustomers = 0;
    let upgradedCustomers = 0;
    let headerMap = new Map<string, number>();
    const stats: Record<string, number> = {};
    
    // Map of emails to discount percentages
    const vipDiscountsMap: Record<string, number> = {};

    return new Promise((resolve, reject) => {
        (async () => {
            try {
                for await (const worksheetReader of workbookReader) {
                    let isFirstRow = true;

                    for await (const row of worksheetReader) {
                        const rowData = row.values as any[];
                        
                        if (isFirstRow) {
                            rowData.forEach((val, idx) => {
                                if (val) headerMap.set(val.toString().trim(), idx);
                            });
                            stringifier.write(rowData.slice(1));
                            isFirstRow = false;
                            continue;
                        }

                        const getVal = (colName: string): any => {
                            const colIdx = headerMap.get(colName);
                            return colIdx !== undefined ? rowData[colIdx] : undefined;
                        };

                        const email = getVal('email')?.toString() || '';
                        if (!email) continue;

                        totalCustomers++;
                        const totalOrderValue = typeof getVal('totalOrderValue') === 'number' ? getVal('totalOrderValue') : 0;
                        const newTier = determineTier(totalOrderValue);
                        
                        if (newTier) {
                            vipDiscountsMap[email.toLowerCase()] = parseInt(newTier.replace('ZR', ''), 10);
                            stats[newTier] = (stats[newTier] || 0) + 1;
                            
                            const plColIdx = headerMap.get('pricelistName');
                            if (plColIdx !== undefined && rowData[plColIdx] !== newTier) {
                                rowData[plColIdx] = newTier;
                                upgradedCustomers++;
                            }
                        }

                        stringifier.write(rowData.slice(1));
                    }
                }
                stringifier.end();
            } catch (err) {
                reject(err);
            }
        })();

        csvWriter.on('finish', () => {
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
            fs.writeFileSync(path.join(exportsDir, 'vip-discounts.json'), JSON.stringify(v2Data, null, 2));

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
            uploadToWorker(vipDiscountsMap, upgradedCustomers).then(() => resolve(true)).catch(reject);
        });
    });
}

main().catch(console.error);
