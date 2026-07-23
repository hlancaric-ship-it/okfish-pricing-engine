import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import sax from 'sax';
import { EngineBuilder } from '../core/EngineBuilder.js';
import { LOYALTY_TIERS } from '../core/config.js';
import { ProductAdapter, SaxProductContext } from '../xml/ProductAdapter.js';
import { buildPricelistsXml, PricelistInputs } from '../../shared/pricelist-xml.js';
import { RuleType } from '../core/interfaces.js';

const CONFIG_PATH = 'src/config/policies/policy-v1.json';

// core/config.ts's LOYALTY_TIERS is ordered descending (by design, for its own
// turnover-lookup scan in getLoyaltyTier()). The Worker emits PRICELIST blocks in
// ascending tier order (Object.keys(policy-v1.json.loyaltyTiers), i.e. ZR4..ZR25) — for
// byte-identical <PRICELISTS> output between this CLI and the Worker on equivalent
// input, the iteration order has to match too, so it's re-sorted here for XML output
// only (this doesn't touch core/config.ts's own order, which other code depends on).
const TIERS_IN_ASCENDING_ORDER = [...LOYALTY_TIERS].sort(
    (a, b) => parseInt(a.tier.slice(2), 10) - parseInt(b.tier.slice(2), 10)
);

interface GenerateXmlResult {
    totalProducts: number;
    errorsCount: number;
    durationMs: number;
}

function escapeXmlText(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeXmlAttr(str: string): string {
    return escapeXmlText(str).replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function parsedNumberOrUndefined(text: string): number | undefined {
    const trimmed = text.trim();
    if (trimmed === '') return undefined;
    const n = parseFloat(trimmed);
    return isNaN(n) ? undefined : n;
}

// Streams a real Shoptet product export XML through SAX, replacing each item's
// <PRICELISTS> block with one computed from the SAME pricing engine and the SAME
// shared XML generator (shared/pricelist-xml.ts) the Cloudflare Worker uses — so this
// CLI and the Worker produce byte-identical <PRICELIST> output for equivalent input.
// Everything else in the source document passes through unchanged.
export async function generateXml(inputPath: string, outputPath: string): Promise<GenerateXmlResult> {
    const engine = EngineBuilder.fromConfig(CONFIG_PATH).build();

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    const start = performance.now();
    let totalProducts = 0;
    let errorsCount = 0;

    function generateXMLForContext(context: SaxProductContext & { hasActionPrice?: boolean }): string {
        const entries: Array<{ title: string; data: PricelistInputs }> = [];
        for (const tierConfig of TIERS_IN_ASCENDING_ORDER) {
            try {
                const input = ProductAdapter.toPricingInput(context, tierConfig.tier);
                const result = engine.calculatePrice(input);
                const fallbackPrice = context.standardPrice ?? context.price ?? context.priceVat ?? 0;
                const price = result.rejected ? fallbackPrice : Number(result.finalPrice.toFixed(2));
                const usedActionPrice = !result.rejected && result.appliedRules.some(r => r.rule === RuleType.SALE);

                entries.push({
                    title: tierConfig.pricelistName,
                    data: {
                        price,
                        purchasePrice: context.purchasePrice,
                        standardPrice: context.standardPrice,
                        priceRatio: 1,
                        minPriceRatio: 0,
                        actionPrice: context.actionPrice,
                        usedActionPrice: usedActionPrice && context.hasActionPrice,
                        applyLoyaltyDiscount: context.applyLoyaltyDiscount ?? true,
                        vatRatePercent: context.vatRatePercent
                    }
                });
            } catch {
                errorsCount++;
            }
        }
        return buildPricelistsXml(entries);
    }

    return new Promise<GenerateXmlResult>((resolve, reject) => {
        const readStream = fs.createReadStream(inputPath, { encoding: 'utf8' });
        const writeStream = fs.createWriteStream(outputPath, { encoding: 'utf8' });
        const parser = sax.createStream(true, { trim: false, normalize: false, lowercase: false });

        let currentPath: string[] = [];
        let currentProduct: (SaxProductContext & { hasVariants?: boolean; hasActionPrice?: boolean }) | null = null;
        let currentVariant: (SaxProductContext & { hasActionPrice?: boolean }) | null = null;
        let currentText = '';
        let inPricelists = false;
        let shouldDropPricelists = false;

        parser.on('opentag', (node: any) => {
            currentPath.push(node.name);
            currentText = '';

            if (node.name === 'SHOPITEM') {
                currentProduct = { applyLoyaltyDiscount: true, hasVariants: false };
                totalProducts++;
            } else if (node.name === 'VARIANTS') {
                if (currentProduct) currentProduct.hasVariants = true;
            } else if (node.name === 'VARIANT') {
                currentVariant = {
                    applyLoyaltyDiscount: currentProduct?.applyLoyaltyDiscount,
                    manufacturer: currentProduct?.manufacturer,
                    category: currentProduct?.category,
                    purchasePrice: currentProduct?.purchasePrice,
                    price: currentProduct?.price,
                    standardPrice: currentProduct?.standardPrice,
                    actionPrice: currentProduct?.actionPrice,
                    hasActionPrice: currentProduct?.hasActionPrice,
                    vatRatePercent: currentProduct?.vatRatePercent
                };
            } else if (node.name === 'PRICELISTS') {
                inPricelists = true;
                shouldDropPricelists = true;
            } else if (node.name === 'ACTION_PRICE') {
                if (currentVariant) currentVariant.hasActionPrice = true;
                else if (currentProduct) currentProduct.hasActionPrice = true;
            }

            if (!shouldDropPricelists) {
                let attrs = '';
                for (const [key, val] of Object.entries(node.attributes)) {
                    attrs += ` ${key}="${escapeXmlAttr(String(val))}"`;
                }
                writeStream.write(`<${node.name}${attrs}>`);
            }
        });

        parser.on('text', (text: string) => {
            currentText += text;
            if (!shouldDropPricelists) writeStream.write(escapeXmlText(text));
        });

        parser.on('cdata', (cdata: string) => {
            if (!shouldDropPricelists) writeStream.write(`<![CDATA[${cdata}]]>`);
        });

        parser.on('processinginstruction', (pi: { name: string; body: string }) => {
            if (!shouldDropPricelists) writeStream.write(`<?${pi.name} ${pi.body}?>`);
        });

        parser.on('doctype', (doctype: string) => {
            if (!shouldDropPricelists) writeStream.write(`<!DOCTYPE ${doctype}>`);
        });

        parser.on('closetag', (name: string) => {
            const activeContext = currentVariant || currentProduct;
            if (activeContext && !inPricelists) {
                if (name === 'CODE') activeContext.code = currentText.trim();
                if (name === 'PRICE') activeContext.price = parsedNumberOrUndefined(currentText);
                if (name === 'PRICE_VAT') activeContext.priceVat = parsedNumberOrUndefined(currentText);
                if (name === 'STANDARD_PRICE') activeContext.standardPrice = parsedNumberOrUndefined(currentText);
                if (name === 'PURCHASE_PRICE') activeContext.purchasePrice = parsedNumberOrUndefined(currentText);
                if (name === 'ACTION_PRICE') activeContext.actionPrice = parsedNumberOrUndefined(currentText);
                if (name === 'MANUFACTURER' && currentPath.includes('SHOPITEM')) activeContext.manufacturer = currentText.trim();
                if (name === 'CATEGORY' && currentPath.includes('CATEGORIES')) activeContext.category = currentText.trim();
                if (name === 'CURRENCY') activeContext.currency = currentText.trim();
                if (name === 'VAT' && !inPricelists) activeContext.vatRatePercent = parsedNumberOrUndefined(currentText);
                if (name === 'APPLY_LOYALTY_DISCOUNT') {
                    const t = currentText.trim();
                    activeContext.applyLoyaltyDiscount = (t === '1' || t.toLowerCase() === 'true');
                }
            }

            if (name === 'PRICELISTS') {
                inPricelists = false;
                shouldDropPricelists = false;
            } else {
                if (name === 'SHOPITEM' || name === 'VARIANT') {
                    if (activeContext) {
                        let shouldGenerate = false;
                        if (name === 'VARIANT') {
                            shouldGenerate = true;
                        } else if (name === 'SHOPITEM' && !currentProduct?.hasVariants) {
                            shouldGenerate = true;
                        }
                        if (shouldGenerate) {
                            writeStream.write(generateXMLForContext(activeContext));
                        }
                    }
                    if (name === 'SHOPITEM') currentProduct = null;
                    if (name === 'VARIANT') currentVariant = null;
                }

                if (!shouldDropPricelists) {
                    writeStream.write(`</${name}>`);
                }
            }
            currentPath.pop();
        });

        parser.on('end', () => {
            writeStream.end(() => {
                resolve({ totalProducts, errorsCount, durationMs: Math.round(performance.now() - start) });
            });
        });

        parser.on('error', (err: Error) => reject(err));
        readStream.on('error', reject);
        writeStream.on('error', reject);

        readStream.pipe(parser);
    });
}

// CLI entry point — only runs when this module is executed directly, never on import.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const DOWNLOADS_DIR = process.env.HOME ? path.join(process.env.HOME, 'Downloads') : path.join(process.cwd(), 'downloads');
    const EXPORTS_DIR = path.join(process.cwd(), 'exports');
    const OUTPUT_PATH = path.join(EXPORTS_DIR, 'products.xml');

    let inputPath = '';
    if (fs.existsSync(DOWNLOADS_DIR)) {
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(f => f.startsWith('products') && f.endsWith('.xml'))
            .map(f => ({ name: f, time: fs.statSync(path.join(DOWNLOADS_DIR, f)).mtime.getTime() }))
            .sort((a, b) => b.time - a.time);
        if (files.length > 0) inputPath = path.join(DOWNLOADS_DIR, files[0].name);
    }

    if (!inputPath || !fs.existsSync(inputPath)) {
        console.error(`❌ Žádný soubor products*.xml nenalezen ve složce ${DOWNLOADS_DIR}`);
        process.exit(1);
    }

    console.log(`Používám referenční export: ${inputPath}`);
    console.log(`Zpracovávám XML soubor (SAX streamování zapnuto)...`);

    generateXml(inputPath, OUTPUT_PATH).then(({ totalProducts, errorsCount, durationMs }) => {
        console.log(`\n✅ Úspěšně vygenerováno: exports/products.xml`);
        console.log(`Celkem zpracováno produktů: ${totalProducts}`);
        console.log(`Chyby: ${errorsCount}`);
        console.log(`Čas zpracování: ${(durationMs / 1000).toFixed(2)} sekund`);
    }).catch(err => {
        console.error('XML generation failed:', err);
        process.exit(1);
    });
}
