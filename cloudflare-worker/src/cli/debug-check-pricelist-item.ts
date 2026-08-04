// One-off: fetch a specific product's item from a specific pricelist directly via
// the Private API (bypasses any admin-UI caching) to confirm a write actually landed.
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    const pricelistId = Number(process.env.PRICELIST_ID);
    const code = process.env.CODE;
    if (!pricelistId || !code) throw new Error('PRICELIST_ID and CODE env vars required');

    const client = new ShoptetApiClient(token);
    const items = await client.getPricelistItems(pricelistId);
    const item = items.find(i => i.code === code);
    console.log(JSON.stringify(item, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
