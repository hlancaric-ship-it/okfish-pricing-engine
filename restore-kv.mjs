import fs from 'fs';
import { createHash } from 'crypto';
import 'dotenv/config';

async function restore() {
    const data = JSON.parse(fs.readFileSync('exports/vip-discounts.json', 'utf8'));
    const vipDiscountsMap = data.customers;
    
    const baseUrl = process.env.CF_WORKER_URL; 
    const token = process.env.CF_WORKER_TOKEN;

    const beginRes = await fetch(`${baseUrl}/v1/import/begin`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
    });
    const { version } = await beginRes.json();
    console.log('Restoring to version:', version);

    const allItems = Object.entries(vipDiscountsMap).map(([email, discount]) => ({
        hash: createHash('sha256').update(email).digest('hex'),
        discount
    }));

    const BATCH_SIZE = 250;
    const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);

    for (let i = 0; i < totalBatches; i++) {
        const batchItems = allItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        await fetch(`${baseUrl}/v1/import/chunk`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ version, customers: batchItems })
        });
        console.log(`Chunk ${i+1}/${totalBatches}`);
    }

    const finishRes = await fetch(`${baseUrl}/v1/import/finish`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ version, customers: allItems.length })
    });
    console.log('Finished!', await finishRes.json());
}
restore().catch(console.error);
