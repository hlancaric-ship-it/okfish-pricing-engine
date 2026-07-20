import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import Decimal from 'decimal.js';
import { EngineBuilder } from "../core/EngineBuilder.js";
import { CustomerTier } from "../core/interfaces.js";
import { ValidationEngine } from "../core/ValidationEngine.js";

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

async function main() {
    const start = performance.now();
    const configPath = 'src/config/policies/policy-v1.json';
    const engine = EngineBuilder.fromConfig(configPath).build();
    const validationEngine = new ValidationEngine();

    const inputPath = path.join(process.cwd(), 'products.xlsx');
    const exportsDir = path.join(process.cwd(), 'exports');
    const outputPath = path.join(exportsDir, 'products_import.xlsx');

    if (!fs.existsSync(exportsDir)) {
        fs.mkdirSync(exportsDir, { recursive: true });
    }

    if (!fs.existsSync(inputPath)) {
        console.error(`❌ Soubor nenalezen: ${inputPath}`);
        console.error(`Ujistěte se, že jste nahráli 'products.xlsx' ze Shoptetu.`);
        process.exit(1);
    }

    console.log(`Zpracovávám XLSX soubor (streamování zapnuto)...`);

    // Stream Reader and Writer to avoid OutOfMemory errors on huge files
    const options = {
        sharedStrings: 'cache',
        hyperlinks: 'cache',
        worksheets: 'emit'
    };
    
    // @ts-ignore - ExcelJS typings can be incomplete for streams
    const workbookReader = new ExcelJS.stream.xlsx.WorkbookReader(inputPath, options);
    
    const workbookWriter = new ExcelJS.stream.xlsx.WorkbookWriter({
        filename: outputPath,
        useStyles: true,
        useSharedStrings: true
    });

    let totalProducts = 0;
    let errorsCount = 0;
    let headerMap = new Map<string, number>();

    for await (const worksheetReader of workbookReader) {
        const worksheetWriter = workbookWriter.addWorksheet(worksheetReader.name);
        
        let isFirstRow = true;

        for await (const row of worksheetReader) {
            const writerRow = worksheetWriter.addRow([]);
            
            // @ts-ignore
            row.eachCell({ includeEmpty: true }, (cell: any, colNumber: number) => {
                const newCell = writerRow.getCell(colNumber);
                newCell.value = cell.value;
                newCell.style = cell.style; // Zachová formátování!
                
                if (isFirstRow) {
                    const headerName = cell.value?.toString().trim();
                    if (headerName) {
                        headerMap.set(headerName, colNumber);
                    }
                }
            });

            if (isFirstRow) {
                isFirstRow = false;
                writerRow.commit();
                continue;
            }

            // Data extraction for calculations
            const getVal = (colName: string): any => {
                const colIdx = headerMap.get(colName);
                if (!colIdx) return undefined;
                return row.getCell(colIdx).value;
            };

            const parseNumber = (val: any) => {
                if (val === undefined || val === null || val === '') return undefined;
                if (typeof val === 'number') return val;
                if (typeof val === 'string') {
                    const clean = val.replace(',', '.').replace(/[^0-9.-]/g, '');
                    return clean ? parseFloat(clean) : undefined;
                }
                return undefined;
            };

            const applyLoyaltyRaw = getVal('applyLoyaltyDiscount');
            let applyLoyalty = true;
            if (applyLoyaltyRaw !== undefined) {
                const str = applyLoyaltyRaw.toString().toLowerCase();
                applyLoyalty = str === "1" || str === "true" || str === "yes" || str === "ano";
            }

            const code = getVal('code')?.toString() || '';
            
            // Skip empty rows
            if (!code) {
                writerRow.commit();
                continue;
            }

            totalProducts++;

            const parsedBasePrice = parseNumber(getVal('standardPrice') || getVal('price'));
            const parsedSalePrice = parseNumber(getVal('actionPrice'));
            const parsedMaxDiscount = parseNumber(getVal('maxDiscount'));
            const parsedPurchasePrice = parseNumber(getVal('purchasePrice'));
            
            for (let idx = 0; idx < TIER_MAPPING.length; idx++) {
                const m = TIER_MAPPING[idx];
                const targetColIdx = headerMap.get(m.col);
                if (!targetColIdx) {
                    console.warn(`Varování: Sloupec ${m.col} nenalezen v hlavičce pro produkt ${code}.`);
                    continue;
                }
                const targetCell = writerRow.getCell(targetColIdx);
                
                const input = {
                    sku: code,
                    basePrice: new Decimal(parsedBasePrice || 0),
                    salePrice: parsedSalePrice ? new Decimal(parsedSalePrice) : undefined,
                    customerTier: m.tier,
                    allowLoyaltyDiscount: applyLoyalty,
                    productMaxDiscount: parsedMaxDiscount ? new Decimal(parsedMaxDiscount).dividedBy(100) : undefined,
                    manufacturer: getVal('manufacturer')?.toString(),
                    category: getVal('categoryText')?.toString(),
                    purchasePrice: parsedPurchasePrice ? new Decimal(parsedPurchasePrice) : undefined,
                    currency: getVal('currency')?.toString()
                };
                
                try {
                    const inputValidation = validationEngine.validateInput(input);
                    if (!inputValidation.valid) {
                        errorsCount++;
                        targetCell.value = "";
                        continue;
                    }

                    const result = engine.calculatePrice(input);
                    
                    const resultValidation = validationEngine.validateResult(result);
                    if (!resultValidation.valid || result.rejected) {
                        errorsCount++;
                        targetCell.value = "";
                        continue;
                    }

                    // XLSX works best with native JS numbers or formatted strings
                    targetCell.value = Number(result.finalPrice.toFixed(2));
                    
                } catch (e: any) {
                    errorsCount++;
                    targetCell.value = "";
                }
            }

            writerRow.commit();
        }
    }

    await workbookWriter.commit();

    const end = performance.now();
    const durationMs = Math.round(end - start);

    fs.writeFileSync(path.join(exportsDir, 'run.json'), JSON.stringify({
        products: totalProducts,
        errors: errorsCount,
        durationMs
    }, null, 2));
    
    console.log(`\n✅ Úspěšně vygenerováno: exports/products_import.xlsx`);
    console.log(`Celkem zpracováno produktů: ${totalProducts}`);
    console.log(`Čas zpracování: ${(durationMs / 1000).toFixed(2)} sekund`);
}

main().catch(console.error);
