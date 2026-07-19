import express from 'express';
import multer from 'multer';
import archiver from 'archiver';
import * as fs from 'fs';
import * as path from 'path';
import { readProductsCsv } from '../csv/reader.js';
import { writeProductsCsv } from '../csv/writer.js';
import { PricingEngine } from '../core/PricingEngine.js';
import { BasePricePolicy } from '../policies/BasePricePolicy.js';
import { HighestDiscountPolicy } from '../policies/HighestDiscountPolicy.js';
import { ProductMaxDiscountPolicy } from '../policies/ProductMaxDiscountPolicy.js';
import { BrandLimitPolicy } from '../policies/BrandLimitPolicy.js';
import { CategoryLimitPolicy } from '../policies/CategoryLimitPolicy.js';
import { RoundingPolicy } from '../policies/RoundingPolicy.js';
import { ValidatorPolicy } from '../policies/ValidatorPolicy.js';
import { CustomerTier } from '../core/interfaces.js';

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

    try {
        const policies = [
            new BasePricePolicy(),
            new HighestDiscountPolicy(),
            new ProductMaxDiscountPolicy(),
            new BrandLimitPolicy(),
            new CategoryLimitPolicy(),
            new RoundingPolicy(),
            new ValidatorPolicy()
        ];
        
        const engine = new PricingEngine(policies);
        const baseProducts = await readProductsCsv(req.file.path);
        
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="shoptet-exports.zip"');
        
        const archive = archiver('zip', { zlib: { level: 9 } });
        archive.pipe(res);
        
        const tiers: CustomerTier[] = ["ZR4", "ZR6", "ZR8", "ZR10", "ZR12", "ZR14", "ZR16", "ZR18", "ZR20", "ZR25"];
        
        const exportsDir = path.join(process.cwd(), 'exports', \`job-\${Date.now()}\`);
        fs.mkdirSync(exportsDir, { recursive: true });
        
        let changedPrices = 0;
        
        for (const tier of tiers) {
            const results = baseProducts.map(baseProduct => {
                const input = { ...baseProduct, customerTier: tier };
                const context = engine.calculatePrice(input);
                if (!context.currentPrice.equals(baseProduct.basePrice)) {
                    changedPrices++;
                }
                return context;
            });
            
            const outPath = path.join(exportsDir, \`\${tier}.csv\`);
            await writeProductsCsv(outPath, results);
            archive.file(outPath, { name: \`\${tier}.csv\` });
        }
        
        // Report
        const report = {
            generatedAt: new Date().toISOString(),
            products: baseProducts.length,
            priceLists: tiers.length,
            changedPrices,
            warnings: 0,
            errors: 0
        };
        
        const reportPath = path.join(exportsDir, 'report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        archive.file(reportPath, { name: 'report.json' });
        
        await archive.finalize();
        
        // Clean up
        fs.unlinkSync(req.file.path);
    } catch (e: any) {
        res.status(500).send(\`Error: \${e.message}\`);
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(\`Admin UI bezi na http://localhost:\${PORT}\`);
});
