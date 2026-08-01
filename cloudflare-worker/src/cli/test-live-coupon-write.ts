// ONE-OFF, MANUAL TEST SCRIPT. Sends exactly ONE product/ONE tier live write to
// confirm the coupon-fields integration works against the real Shoptet API before
// any batch/automated write is enabled. Not part of any scheduled job.
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    const client = new ShoptetApiClient(token);

    const pricelistId = 2; // ZR4
    const items = [{ code: '103988', discountCoupon: true, minPriceRatio: '0.8400' }];

    console.log(`Odesílám ŽIVÝ zápis: pricelist ${pricelistId}, produkt ${items[0].code}...`);
    const result = await client.updatePricelistSalesBatch(pricelistId, items);
    console.log('=== ODPOVĚĎ API ===');
    console.log(result);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
