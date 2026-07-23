// Reuses the exact same Worker HTTP API already deployed and verified in production
// (cloudflare-worker/src/index.ts, cloudflare-worker/src/cli/sync-products.ts,
// src/cli/upload.ts) — this app never talks to Cloudflare directly, only to our own
// Worker's public endpoints.
'use strict';

const crypto = require('crypto');

const WORKER_URL = 'https://shoptet-vip-worker.hlancaric.workers.dev';
const TOKEN = 'shoptet-vip-secret-12345';

async function syncCustomers(vipDiscountsMap, log) {
    log('Odesílám zákaznické slevy na Worker...');
    const beginRes = await fetch(`${WORKER_URL}/v1/import/begin`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!beginRes.ok) throw new Error(`begin selhal: ${beginRes.status}`);
    const { version } = await beginRes.json();

    const items = Object.entries(vipDiscountsMap).map(([email, discount]) => ({
        hash: crypto.createHash('sha256').update(email).digest('hex'),
        discount
    }));

    const BATCH_SIZE = 250;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        const batch = items.slice(i, i + BATCH_SIZE);
        const res = await fetch(`${WORKER_URL}/v1/import/chunk`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ version, customers: batch })
        });
        if (!res.ok) throw new Error(`chunk selhal: ${res.status}`);
        log(`...odesláno ${Math.min(i + BATCH_SIZE, items.length)}/${items.length} zákazníků`);
    }

    const finishRes = await fetch(`${WORKER_URL}/v1/import/finish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version, customers: items.length })
    });
    if (!finishRes.ok) throw new Error(`finish selhal: ${finishRes.status}`);
    log(`HOTOVO. Zákazníků synchronizováno na Worker: ${items.length}`);
}

async function syncProducts(products, log) {
    log('Odesílám produktová data na Worker...');
    const beginRes = await fetch(`${WORKER_URL}/v1/products/import/begin`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }
    });
    if (!beginRes.ok) throw new Error(`begin selhal: ${beginRes.status}`);
    const { version } = await beginRes.json();

    const BATCH_SIZE = 250;
    for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
        const res = await fetch(`${WORKER_URL}/v1/products/import/chunk`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ version, products: batch })
        });
        if (!res.ok) throw new Error(`chunk selhal: ${res.status}`);
        log(`...odesláno ${Math.min(i + BATCH_SIZE, products.length)}/${products.length} produktů`);
    }

    const finishRes = await fetch(`${WORKER_URL}/v1/products/import/finish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
    });
    if (!finishRes.ok) throw new Error(`finish selhal: ${finishRes.status}`);
    log(`HOTOVO. Produktů synchronizováno na Worker: ${products.length}`);
}

module.exports = { syncCustomers, syncProducts };
