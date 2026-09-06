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

    // Verzovaný import (begin/finish = atomické přepnutí active_customer_version)
    // zanikl v e3aa5dd -- zákazníci se píšou pod STABILNÍ klíče customer:${hash}
    // bez verze. Zůstalo jen diff-aware POST /v1/import/chunk, takže odpadá i
    // cleanup staré verze (žádné osiřelé verzované klíče nevznikají).
    const allItems = Object.entries(vipDiscountsMap).map(([email, discount]) => ({
        hash: createHash('sha256').update(email).digest('hex'),
        discount
    }));

    const BATCH_SIZE = 250;
    const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);

    let totalWritten = 0, totalSkipped = 0;

    for (let i = 0; i < totalBatches; i++) {
        console.log(`Uploading chunk ${i + 1}/${totalBatches}`);
        const batchItems = allItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
        
        const payload = { customers: batchItems };

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

                const resData: any = await res.json().catch(() => ({}));
                if (resData.written) totalWritten += resData.written;
                if (resData.skipped) totalSkipped += resData.skipped;

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
    
    const durationSec = ((performance.now() - startTime) / 1000).toFixed(2);

    console.log(`\nImport completed`);
    console.log(`Customers: ${allItems.length}`);
    console.log(`Chunks: ${totalBatches}`);
    console.log(`Written: ${totalWritten} (nové/změněné), Skipped: ${totalSkipped} (beze změny)`);
    console.log(`Duration: ${durationSec} s\n`);
}
