// Syncs product pricing data (price, actionPrice, standardPrice, maxDiscount,
// percentVat, applyLoyaltyDiscount, manufacturer, categoryText) into the Worker's
// product KV cache, used by /v1/product-discount/:code/:tier for the frontend
// discount badges (cart, catalog, detail pages).
//
// Deliberately a SEPARATE, independent process from the existing feed-generation
// Worker/cron (cloudflare-worker/src/feed-generator.ts) — it only calls the Worker's
// public HTTP API (/v1/products/import/*), the same endpoints already used and
// verified on 2026-07-23. It never touches feed generation, R2, or the live XML feed,
// so running it (or it failing) cannot affect the production import pipeline.
//
// Usage: npm run sync-products   (from cloudflare-worker/)
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';

// Loads the repo-root .env (no `dotenv` dependency needed here) — same file the root
// project's CLI scripts (src/cli/upload.ts etc.) already read CF_WORKER_URL/TOKEN from.
function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const MASTER_FEED_URL = process.env.MASTER_FEED_URL;
const WORKER_URL = process.env.CF_WORKER_URL;
const TOKEN = process.env.CF_WORKER_TOKEN;

const NEEDED_FIELDS = [
    'code', 'price', 'actionPrice', 'standardPrice', 'priceRatio', 'purchasePrice',
    'maxDiscount', 'percentVat', 'applyLoyaltyDiscount', 'manufacturer', 'categoryText'
];

// Retries transient network/server failures (timeouts, dropped sockets, 5xx, 429)
// with exponential backoff (1s, 3s, 9s). Does NOT retry 4xx responses — those are
// real errors (bad token, bad request) that a retry can't fix and would only hide.
// Added 2026-08-12 after a week of sync.yml failures that were all transient network
// blips (HeadersTimeoutError, SocketError "other side closed", HTTP 502) — the cron
// safety net caught them 15 min later regardless, but this avoids the noisy failure
// + GitHub issue for a single hiccup.
async function fetchWithRetry(url: string, init: RequestInit = {}, label: string, retries = 3): Promise<Response> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, init);
            if (!res.ok && (res.status >= 500 || res.status === 429) && attempt < retries) {
                const delay = 1000 * 3 ** (attempt - 1);
                console.warn(`[retry] ${label} -> HTTP ${res.status}, attempt ${attempt}/${retries}, retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
            return res;
        } catch (e) {
            lastErr = e;
            if (attempt < retries) {
                const delay = 1000 * 3 ** (attempt - 1);
                console.warn(`[retry] ${label} -> ${(e as Error).message}, attempt ${attempt}/${retries}, retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
                continue;
            }
        }
    }
    throw lastErr;
}

async function main() {
    if (!MASTER_FEED_URL) throw new Error('MASTER_FEED_URL not set in .env');
    if (!WORKER_URL || !TOKEN) throw new Error('CF_WORKER_URL / CF_WORKER_TOKEN not set in .env');

    console.log('Fetching master feed...');
    const res = await fetchWithRetry(MASTER_FEED_URL, {}, 'master feed fetch');
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const beginRes = await fetchWithRetry(`${WORKER_URL}/v1/products/import/begin`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }
    }, 'import/begin');
    if (!beginRes.ok) throw new Error(`begin failed: ${beginRes.status}`);
    const { version } = await beginRes.json() as { version: string };
    console.log('version:', version);

    const BATCH_SIZE = 250;
    let batch: Array<{ code: string; row: Record<string, string> }> = [];
    let totalSent = 0;
    let totalWritten = 0;
    let totalSkipped = 0;
    let rowCount = 0;

    async function flushBatch() {
        if (batch.length === 0) return;
        const chunkRes = await fetchWithRetry(`${WORKER_URL}/v1/products/import/chunk`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ version, products: batch })
        }, `import/chunk (rows sent so far: ${totalSent})`);
        if (!chunkRes.ok) throw new Error(`chunk failed: ${chunkRes.status} ${await chunkRes.text()}`);
        // written/skipped: KV nyní zapisuje jen produkty, u kterých se data skutečně
        // liší od toho, co už tam je (viz index.ts import/chunk) -- na 16 708
        // produktech katalogu ověřeno živě proti stagingu 2026-08-12: druhý běh se
        // stejnými daty zapsal jen 1 (skutečně změněná cena), 16 707 přeskočil.
        const chunkData = await chunkRes.json() as { written?: number; skipped?: number };
        totalWritten += chunkData.written || 0;
        totalSkipped += chunkData.skipped || 0;
        totalSent += batch.length;
        batch = [];
    }

    // Node's global fetch() returns a standard WHATWG ReadableStream body — pipes
    // directly through the same CsvParserStream the Worker itself uses, no manual
    // Node-stream-to-web-stream conversion needed.
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const csvRow = value as Record<string, string>;
        const code = csvRow['code'];
        if (!code) continue;

        rowCount++;
        const row: Record<string, string> = {};
        for (const f of NEEDED_FIELDS) if (f !== 'code') row[f] = csvRow[f] || '';

        batch.push({ code, row });
        if (batch.length >= BATCH_SIZE) await flushBatch();

        if (rowCount % 2000 === 0) console.log(`...processed ${rowCount} rows, sent ${totalSent}`);
    }
    await flushBatch();

    const finishRes = await fetchWithRetry(`${WORKER_URL}/v1/products/import/finish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
    }, 'import/finish');
    const finishData = await finishRes.json();
    console.log(`DONE. rows=${rowCount} sent=${totalSent} written=${totalWritten} skipped=${totalSkipped}`, finishData);
}

main().catch(e => { console.error(e); process.exit(1); });
