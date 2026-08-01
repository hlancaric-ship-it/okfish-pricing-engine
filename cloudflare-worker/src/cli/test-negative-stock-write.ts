// ONE-OFF, MANUAL TEST SCRIPT. Sets negativeStockAllowed=false for ONE product
// via PATCH /api/products/code/{code}. Not part of any scheduled job.
import * as fs from 'fs';
import * as path from 'path';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const code = process.argv[2];

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');

    const url = `https://api.myshoptet.com/api/products/code/${encodeURIComponent(code)}`;
    const body = {
        data: {
            variants: [
                { code, negativeStockAllowed: false }
            ]
        }
    };

    console.log(`PATCH ${url}`);
    console.log(JSON.stringify(body, null, 2));

    const res = await fetch(url, {
        method: 'PATCH',
        headers: {
            'Shoptet-Private-API-Token': token,
            'Content-Type': 'application/vnd.shoptet.v1.0'
        },
        body: JSON.stringify(body)
    });
    const json = await res.json();
    console.log('status:', res.status);
    console.log(JSON.stringify(json, null, 2));
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
