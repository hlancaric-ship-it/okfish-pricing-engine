import express from 'express';
import multer from 'multer';
// @ts-ignore
import archiver from 'archiver';
import * as fs from 'fs';
import * as path from 'path';
import { parse } from 'csv-parse';
import { stringify } from 'csv-stringify';
import { Transform } from 'stream';
import { PricingEngine } from '../core/PricingEngine.js';
import { BasePricePolicy } from '../policies/BasePricePolicy.js';
import { HighestDiscountPolicy } from '../policies/HighestDiscountPolicy.js';
import { RoundingPolicy } from '../policies/RoundingPolicy.js';
import { CustomerTier } from '../core/interfaces.js';
import { EngineBuilder } from '../core/EngineBuilder.js';
import Decimal from 'decimal.js';

const app = express();
const upload = multer({ dest: 'uploads/' });

app.get('/', (req, res) => {
    res.send(`
        <html>
        <head><title>Shoptet Pricing Engine Admin</title></head>
        <body style="font-family: sans-serif; padding: 2rem;">
            <h1>Shoptet Pricing Engine Admin</h1>
            <form action="/generate" method="post" enctype="multipart/form-data">
                <label>Export produktů (CSV): <input type="file" name="productsCsv" required></label><br><br>
                <label>Export zákazníků (CSV): <input type="file" name="customersCsv"></label><br><br>
                <button type="submit" style="padding: 10px; background: #007bff; color: white; border: none; border-radius: 4px; cursor: pointer;">Generovat ZIP</button>
            </form>
        </body>
        </html>
    `);
});

app.post('/generate', upload.single('productsCsv'), async (req, res) => {
    if (!req.file) {
        return res.status(400).send("Chybí soubor produktů.");
    }

    const exportsDir = path.join(process.cwd(), 'exports', `job-${Date.now()}`);
    fs.mkdirSync(exportsDir, { recursive: true });

    try {
        const engine = EngineBuilder.fromConfig('src/config/policies/policy-v1.json').build();
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="shoptet-exports.zip"');
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        
        const tiers: CustomerTier[] = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];
        
        for (const tier of tiers) {
            const outPath = path.join(exportsDir, `${tier}.csv`);
            
            await new Promise((resolve, reject) => {
                const parser = parse({ delimiter: ';', columns: true, skip_empty_lines: true });
                const stringifier = stringify({ header: true, delimiter: ';', columns: [{ key: 'Code', header: 'Code' }, { key: 'Price', header: 'Price' }] });
                
                const transform = new Transform({
                    objectMode: true,
                    transform(row, encoding, callback) {
                        const applyLoyalty = row.applyLoyaltyDiscount === "1" || row.applyLoyaltyDiscount === "true" || row.applyLoyaltyDiscount === "yes" || row.applyLoyaltyDiscount === true;
                        
                        const input = {
                            sku: row.code,
                            basePrice: new Decimal(row.standardPrice || row.price || 0),
                            salePrice: row.actionPrice ? new Decimal(row.actionPrice) : undefined,
                            customerTier: tier,
                            allowLoyaltyDiscount: applyLoyalty,
                            productMaxDiscount: row.maxDiscount ? new Decimal(row.maxDiscount).dividedBy(100) : undefined,
                            manufacturer: row.manufacturer,
                            category: row.categoryText,
                            currency: row.currency
                        };
                        
                        try {
                            const result = engine.calculatePrice(input);
                            callback(null, { Code: result.sku, Price: result.finalPrice.toFixed(2) });
                        } catch (e: any) {
                            console.error(`Error processing SKU ${input.sku}: ${e.message}`);
                            callback();
                        }
                    }
                });

                const readStream = fs.createReadStream(req.file!.path);
                const writeStream = fs.createWriteStream(outPath);

                readStream.pipe(parser).pipe(transform).pipe(stringifier).pipe(writeStream);
                
                writeStream.on('finish', () => resolve(true));
                writeStream.on('error', reject);
                readStream.on('error', reject);
            });
            
            archive.file(outPath, { name: `${tier}.csv` });
        }
        
        await archive.finalize();
        
    } catch (e: any) {
        res.status(500).send(`Error: ${e.message}`);
    } finally {
        // Cleanup uploaded file and temporary directory
        if (req.file && fs.existsSync(req.file.path)) {
            fs.unlinkSync(req.file.path);
        }
        if (fs.existsSync(exportsDir)) {
            fs.rmSync(exportsDir, { recursive: true, force: true });
        }
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Admin UI bezi na http://localhost:${PORT}`);
});
