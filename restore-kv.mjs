import fs from 'fs';
import { createHash } from 'crypto';
import 'dotenv/config';

async function restore() {
    const data = JSON.parse(fs.readFileSync('exports/vip-discounts.json', 'utf8'));
    const vipDiscountsMap = data.customers;
    
    const baseUrl = process.env.CF_WORKER_URL; 
    const token = process.env.CF_WORKER_TOKEN;

    // Od e3aa5dd se zákazníci píšou pod STABILNÍ klíče customer:${hash} bez verze,
    // takže begin/finish (atomické přepnutí active_customer_version) už neexistují.
    // Restore = prostě přepsat klíče přes diff-aware /v1/import/chunk.
    console.log('Obnovuji zákaznické slevy pod stabilní klíče (bez verzování)...');

    const allItems = Object.entries(vipDiscountsMap).map(([email, discount]) => ({
        hash: createHash('sha256').update(email).digest('hex'),
        discount
    }));

    const BATCH_SIZE = 250;
    const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);

    let totalWritten = 0, totalSkipped = 0;

    for (let i = 0; i < totalBatches; i++) {
        const batchItems = allItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        const res = await fetch(`${baseUrl}/v1/import/chunk`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ customers: batchItems })
        });
        if (!res.ok) throw new Error(`Chunk ${i + 1} selhal: ${res.status}`);
        const resData = await res.json().catch(() => ({}));
        if (resData.written) totalWritten += resData.written;
        if (resData.skipped) totalSkipped += resData.skipped;
        console.log(`Chunk ${i+1}/${totalBatches}`);
    }

    console.log(`Finished! ${allItems.length} zákazníků: ${totalWritten} zapsáno, ${totalSkipped} beze změny.`);
}
restore().catch(console.error);
