import { ShoptetApiClient } from './cloudflare-worker/src/shoptet-api/client.ts';
import dotenv from 'dotenv';
dotenv.config();

async function run() {
    const res = await fetch('https://api.myshoptet.com/api/pricelists', {
        headers: {
            'Shoptet-Private-API-Token': process.env.SHOPTET_PRIVATE_API_TOKEN || '',
            'Content-Type': 'application/vnd.shoptet.v1.0'
        }
    });
    console.log("Headers:");
    res.headers.forEach((value, key) => console.log(`${key}: ${value}`));
}
run();
