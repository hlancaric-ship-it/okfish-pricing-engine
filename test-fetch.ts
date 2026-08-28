import { ShoptetApiClient } from './cloudflare-worker/src/shoptet-api/client';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const client = new ShoptetApiClient(process.env.SHOPTET_PRIVATE_API_TOKEN!);
    console.log("Fetching SKU 100464 from ZR12 (ID 14)...");
    const item = await client.getPricelistItemByCode(14, '100464');
    console.log("ZR12 Result:", JSON.stringify(item, null, 2));

    console.log("Fetching SKU 110006 from ZR20 (ID 26)...");
    const item2 = await client.getPricelistItemByCode(26, '110006');
    console.log("ZR20 Result:", JSON.stringify(item2, null, 2));

    console.log("Fetching SKU 101609 from ZR4 (ID 2)...");
    const item3 = await client.getPricelistItemByCode(2, '101609');
    console.log("ZR4 Result:", JSON.stringify(item3, null, 2));
}

main().catch(console.error);
