import { ShoptetApiClient } from './cloudflare-worker/src/shoptet-api/client';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const client = new ShoptetApiClient(process.env.SHOPTET_PRIVATE_API_TOKEN!);
    console.log("Fetching SKU 100464 from GUEST (ID 1)...");
    const item1 = await client.getPricelistItemByCode(1, '100464');
    console.log("100464:", JSON.stringify(item1, null, 2));

    console.log("Fetching SKU 110006 from GUEST (ID 1)...");
    const item2 = await client.getPricelistItemByCode(1, '110006');
    console.log("110006:", JSON.stringify(item2, null, 2));

    console.log("Fetching SKU 101609 from GUEST (ID 1)...");
    const item3 = await client.getPricelistItemByCode(1, '101609');
    console.log("101609:", JSON.stringify(item3, null, 2));
}

main().catch(console.error);
