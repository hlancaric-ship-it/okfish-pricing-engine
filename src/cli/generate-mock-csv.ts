import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify';

async function main() {
    const targetCount = parseInt(process.argv[2], 10);
    
    if (isNaN(targetCount) || targetCount <= 0) {
        console.error("Užití: npx tsx src/cli/generate-mock-csv.ts <počet_řádků>");
        console.error("Příklad: npx tsx src/cli/generate-mock-csv.ts 100000");
        process.exit(1);
    }

    const inputPath = path.join(process.cwd(), 'products.csv');
    if (!fs.existsSync(inputPath)) {
        console.error("Zdrojový soubor products.csv nebyl nalezen!");
        process.exit(1);
    }

    const outputPath = path.join(process.cwd(), `products_mock_${targetCount}.csv`);
    
    console.log(`Načítám vzorová data z ${inputPath}...`);
    const fileContent = fs.readFileSync(inputPath);
    
    // Načteme všechny řádky do paměti (pro 1.6 MB to není problém)
    const records = parse(fileContent, {
        delimiter: ';',
        columns: true,
        skip_empty_lines: true,
        bom: true
    });

    if (records.length === 0) {
        console.error("Vstupní soubor je prázdný!");
        process.exit(1);
    }

    console.log(`Načteno ${records.length} originálních produktů.`);
    console.log(`Generuji ${targetCount} produktů do ${outputPath}...`);

    const stringifier = stringify({
        header: true,
        delimiter: ';'
    });

    const writeStream = fs.createWriteStream(outputPath);
    
    return new Promise((resolve, reject) => {
        stringifier.on('error', reject);
        writeStream.on('error', reject);
        
        writeStream.on('finish', () => {
            console.log(`✅ Úspěšně vygenerováno ${targetCount} záznamů.`);
            resolve(true);
        });

        stringifier.pipe(writeStream);

        // Zapíšeme postupně zkopírované řádky až po targetCount
        for (let i = 0; i < targetCount; i++) {
            const originalRecord = records[i % records.length];
            // Pro unikátnost mírně upravíme kód produktu přidáním prefixu
            const newRecord = { ...originalRecord, code: `MOCK-${i}-${originalRecord.code}` };
            
            // Remove empty keys caused by trailing semicolon if exists
            if ("" in newRecord) {
                delete newRecord[""];
            }

            stringifier.write(newRecord);
        }
        
        stringifier.end();
    });
}

main().catch(console.error);
