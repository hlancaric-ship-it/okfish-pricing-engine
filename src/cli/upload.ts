import 'dotenv/config';

export async function uploadToWorker(vipDiscountsMap: Record<string, number>, upgradedCustomers: number): Promise<void> {
    const baseUrl = process.env.CF_WORKER_URL; 
    const token = process.env.CF_WORKER_TOKEN;

    if (!baseUrl || !token) {
        console.warn("\n⚠️  Přeskočeno: Proměnné CF_WORKER_URL nebo CF_WORKER_TOKEN nejsou nastaveny v .env");
        return;
    }

    const startTime = performance.now();
    const { createHash } = await import('crypto');

    let version: string;
    try {
        const beginRes = await fetch(`${baseUrl}/v1/import/begin`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!beginRes.ok) throw new Error(`Begin failed: ${beginRes.status}`);
        const beginData = await beginRes.json();
        version = beginData.version;
    } catch (err: any) {
        console.error("❌ Nepodařilo se zahájit import:", err.message);
        return;
    }

    const allItems = Object.entries(vipDiscountsMap).map(([email, discount]) => ({
        hash: createHash('sha256').update(email).digest('hex'),
        discount
    }));

    const BATCH_SIZE = 250;
    const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);

    for (let i = 0; i < totalBatches; i++) {
        console.log(`Uploading chunk ${i + 1}/${totalBatches}`);
        const batchItems = allItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        
        const payload = {
            version,
            customers: batchItems
        };

        let attempts = 0;
        let success = false;

        while (attempts < 3 && !success) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => {
                    controller.abort();
                }, 15000);

                const res = await fetch(`${baseUrl}/v1/import/chunk`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`
                    },
                    body: JSON.stringify(payload),
                    signal: controller.signal
                });

                clearTimeout(timeout);

                if (!res.ok) {
                    throw new Error(`HTTP Error: ${res.status}`);
                }
                success = true;

            } catch (err: any) {
                attempts++;
                if (attempts === 3) {
                    console.error(`\n❌ Selhalo odeslání dávky ${i + 1}. Import byl přerušen.`);
                    return;
                } else {
                    await new Promise(r => setTimeout(r, 1000 * attempts));
                }
            }
        }
    }
    
    let oldVersion: string | null = null;
    try {
        const finishRes = await fetch(`${baseUrl}/v1/import/finish`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ version, customers: allItems.length })
        });
        if (!finishRes.ok) throw new Error(`Finish failed: ${finishRes.status}`);
        
        const finalData = await finishRes.json();
        oldVersion = finalData.oldVersion;
    } catch (err: any) {
        console.error("\n❌ Nepodařilo se dokončit (aktivovat) import:", err.message);
        return;
    }
    
    if (oldVersion && oldVersion !== version) {
        try {
            const cleanupRes = await fetch(`${baseUrl}/v1/import/cleanup`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify({ version: oldVersion })
            });
            
            if (!cleanupRes.ok) throw new Error(`Cleanup failed`);
        } catch (err: any) {
            // Ignorujeme v rámci logiky cleanupu
        }
    }
    
    const durationSec = ((performance.now() - startTime) / 1000).toFixed(2);
    
    console.log(`\nImport completed`);
    console.log(`Customers: ${allItems.length}`);
    console.log(`Chunks: ${totalBatches}`);
    console.log(`Duration: ${durationSec} s\n`);
}
