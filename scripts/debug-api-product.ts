import { ShoptetApiClient } from '../cloudflare-worker/src/shoptet-api/client';
import * as dotenv from 'dotenv';
dotenv.config();

async function run() {
    const client = new ShoptetApiClient(process.env.SHOPTET_PRIVATE_API_TOKEN!);
    console.log("Fetching pricelists...");
    const pricelists = await client.getPricelists();
    
    const plId = pricelists[0].id;
    console.log("Fetching products for pricelist", plId);
    
    const items = await client.getPricelistProducts(plId, 1);
    const guid = items[0].guid;
    
    console.log("PRODUCT IN LIST:");
    console.log(JSON.stringify(items[0], null, 2));

    const detail = await client.getProductDetail(guid);
    console.log("PRODUCT DETAIL:");
    console.log(JSON.stringify(detail, null, 2));
}

run().catch(console.error);
