import { ShoptetApiClient } from '../cloudflare-worker/src/shoptet-api/client.ts';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) process.exit(1);

    const client = new ShoptetApiClient(token);
    try {
        console.log('Fetching pricelist 1...');
        const res = await client['rateLimiter'].execute(
            async () => fetch('https://api.myshoptet.com/api/pricelists/1', { headers: client['getHeaders']() }),
            async (r) => r.json()
        );
        console.log(JSON.stringify(res, null, 2).substring(0, 1000));
        console.log('---');
        console.log('Data keys:', Object.keys(res.data));
        if (res.data.pricelist) {
            console.log('Pricelist keys:', Object.keys(res.data.pricelist));
        }
    } catch (e) {
        console.error(e);
    }
}
main();
