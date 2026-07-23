import * as fs from 'fs';
import * as path from 'path';
import sax from 'sax';

const inputPath = process.env.HOME ? path.join(process.env.HOME, 'Downloads', 'productsComplete.xml') : '';
const readStream = fs.createReadStream(inputPath, { encoding: 'utf8' });
const parser = sax.createStream(true, { trim: false, normalize: false, lowercase: false });

let currentPath: string[] = [];
let currentProduct: any = null;
let currentVariant: any = null;
let currentText = '';
let count = 0;

parser.on('opentag', (node) => {
    currentPath.push(node.name);
    currentText = '';

    if (node.name === 'SHOPITEM') {
        currentProduct = { applyLoyaltyDiscount: true, hasVariants: false };
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
            actionPrice: currentProduct?.actionPrice
        };
    }
});

parser.on('text', (text) => {
    currentText += text;
});

parser.on('closetag', (name) => {
    const activeContext = currentVariant || currentProduct;
    if (activeContext) {
        if (name === 'CODE') activeContext.code = currentText.trim();
        if (name === 'PRICE') activeContext.price = parseFloat(currentText.trim());
        if (name === 'STANDARD_PRICE') activeContext.standardPrice = parseFloat(currentText.trim());
        if (name === 'PURCHASE_PRICE') activeContext.purchasePrice = parseFloat(currentText.trim());
        if (name === 'ACTION_PRICE') activeContext.actionPrice = parseFloat(currentText.trim());
    }

    if (name === 'SHOPITEM' || name === 'VARIANT') {
        console.log(`Parsed ${name}:`, activeContext);
        if (name === 'SHOPITEM') currentProduct = null;
        if (name === 'VARIANT') currentVariant = null;
        
        count++;
        if (count >= 3) {
            process.exit(0);
        }
    }
    currentPath.pop();
});

readStream.pipe(parser);
