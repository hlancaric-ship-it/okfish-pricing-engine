import { ShoptetApiClient } from './cloudflare-worker/src/shoptet-api/client.ts';
import 'dotenv/config';

async function run() {
    const client = new ShoptetApiClient(process.env.SHOPTET_PRIVATE_API_TOKEN!);
    const groups = await client.getCustomerGroups();
    console.log(groups);
}
run().catch(e => console.log('CAUGHT:', e.message, e.stack));
