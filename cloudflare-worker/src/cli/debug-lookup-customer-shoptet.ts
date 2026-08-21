// One-off: look up a customer directly in Shoptet (not the Worker's KV mirror)
// by email, to see raw customerGroup + priceList assignment.
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
    const email = (process.env.EMAIL || '').trim().toLowerCase();
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!email) throw new Error('EMAIL not set');
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');

    const client: any = new ShoptetApiClient(token);
    const baseUrl = 'https://api.myshoptet.com/api';
    const url = `${baseUrl}/customers?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, {
        headers: { 'Shoptet-Private-API-Token': token, Accept: 'application/vnd.shoptet.v1.0' }
    });
    console.log('status:', res.status);
    const body = await res.json();
    console.log(JSON.stringify(body, null, 2));
}
main().catch(e => { console.error(e); process.exit(1); });
