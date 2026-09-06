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
import * as crypto from 'crypto';
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

// --force / SYNC_PRODUCTS_FORCE=1 obejde feed hash guard (viz níž). Pro ruční
// workflow_dispatch běhy a pro případ, kdy se KV cache rozjede s feedem (např. po
// ručním zásahu do `product:*` klíčů) a je potřeba ji přepsat i bez změny feedu.
const FORCE = process.argv.includes('--force')
    || ['1', 'true', 'yes'].includes(String(process.env.SYNC_PRODUCTS_FORCE || '').toLowerCase());

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

    // --- Krok 1: přečíst feed a spočítat jeho otisk ---------------------------
    // Feed hash guard (2026-09-06, KV NÁKLADY): dokud se feed nezmění, nemá smysl
    // posílat katalog do import/chunk — Worker tam dělá KV.get() pro KAŽDÝ z ~16 700
    // produktů (diff guard šetří jen zápisy, čtení se platí vždycky). Otisk se počítá
    // PRŮBĚŽNĚ nad procházenými řádky (crypto Hash.update per řádek), ne z celého těla
    // v paměti — feed se čte streamem přes CsvParserStream a celý buffer bychom v RAM
    // držet nechtěli. Do hashe jde jen `code` + hodnoty NEEDED_FIELDS, tj. přesně to,
    // co se do KV opravdu zapisuje: kosmetická změna feedu (jiné pořadí sloupců, změna
    // pole, které nesyncujeme) tak zbytečně neshodí guard.
    console.log('Fetching master feed...');
    const res = await fetchWithRetry(MASTER_FEED_URL, {}, 'master feed fetch');
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const hasher = crypto.createHash('sha256');
    const products: Array<{ code: string; row: Record<string, string> }> = [];
    let rowCount = 0;

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

        // Deterministický zápis do hashe: NEEDED_FIELDS má pevné pořadí, JSON.stringify
        // nad `row` vytvořeným v tom pořadí je proto stabilní napříč běhy. \x1f/\x1e
        // jako oddělovače, aby se hodnoty nemohly "slít" do jiné kombinace.
        hasher.update(`${code}\x1f${JSON.stringify(row)}\x1e`);

        products.push({ code, row });

        if (rowCount % 2000 === 0) console.log(`...parsed ${rowCount} rows`);
    }

    if (rowCount === 0) throw new Error('Master feed neobsahuje ani jeden produkt s `code` — nebudu na základě prázdného feedu nic měnit.');

    const feedHash = hasher.digest('hex');
    console.log(`Feed přečten: ${rowCount} produktů, hash=${feedHash.slice(0, 16)}...`);

    // --- Krok 2: guard — shoda otisku = konec bez jediného KV čtení produktů ---
    if (FORCE) {
        console.log('[feed-hash] --force / SYNC_PRODUCTS_FORCE — guard přeskočen, import poběží i bez změny feedu.');
    } else {
        // Selhání čtení otisku (výpadek Workeru, nový klíč) NESMÍ shodit sync — v tom
        // případě se prostě chováme jako dřív a import proběhne.
        let storedHash: string | null = null;
        try {
            const hashRes = await fetchWithRetry(`${WORKER_URL}/v1/products/feed-hash`, {
                headers: { Authorization: `Bearer ${TOKEN}` }
            }, 'feed-hash GET');
            if (hashRes.ok) {
                storedHash = (await hashRes.json() as { hash: string | null }).hash;
            } else {
                console.warn(`[feed-hash] GET vrátil HTTP ${hashRes.status} — guard se přeskakuje, import poběží.`);
            }
        } catch (e) {
            console.warn(`[feed-hash] GET selhal (${(e as Error).message}) — guard se přeskakuje, import poběží.`);
        }

        if (storedHash && storedHash === feedHash) {
            console.log(`SKIP: master feed je od posledního úspěšného syncu beze změny (${rowCount} produktů, hash ${feedHash.slice(0, 16)}...). Import se nespouští, KV se nedotýkáme. Vynutit lze pomocí --force nebo SYNC_PRODUCTS_FORCE=1.`);
            return;
        }
        console.log(storedHash
            ? `[feed-hash] Feed se změnil (uloženo ${storedHash.slice(0, 16)}..., aktuálně ${feedHash.slice(0, 16)}...) — import poběží.`
            : '[feed-hash] Žádný uložený otisk (první běh po nasazení guardu) — import poběží.');
    }

    // --- Krok 3: vlastní import -----------------------------------------------
    const beginRes = await fetchWithRetry(`${WORKER_URL}/v1/products/import/begin`, {
        method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` }
    }, 'import/begin');
    if (!beginRes.ok) throw new Error(`begin failed: ${beginRes.status}`);
    const { version } = await beginRes.json() as { version: string };
    console.log('version:', version);

    const BATCH_SIZE = 250;
    let totalSent = 0;
    let totalWritten = 0;
    let totalSkipped = 0;

    for (let i = 0; i < products.length; i += BATCH_SIZE) {
        const batch = products.slice(i, i + BATCH_SIZE);
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

        if (totalSent % 2000 < BATCH_SIZE) console.log(`...sent ${totalSent}/${products.length}`);
    }

    const finishRes = await fetchWithRetry(`${WORKER_URL}/v1/products/import/finish`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ version })
    }, 'import/finish');
    if (!finishRes.ok) throw new Error(`finish failed: ${finishRes.status} ${await finishRes.text()}`);
    const finishData = await finishRes.json();

    // --- Krok 4: uložit otisk AŽ TEĎ ------------------------------------------
    // Záměrně až po úspěšném import/finish. Kdyby se ukládal dopředu, přerušený běh
    // (spadlý chunk, timeout runneru) by nechal v KV otisk feedu, který se ve
    // skutečnosti nikdy celý nenaimportoval, a další běh by ho guardem přeskočil —
    // katalog by zůstal nedopsaný, dokud se feed znovu nezmění.
    try {
        const putRes = await fetchWithRetry(`${WORKER_URL}/v1/products/feed-hash`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ hash: feedHash })
        }, 'feed-hash POST');
        if (!putRes.ok) {
            console.warn(`[feed-hash] Uložení otisku selhalo: HTTP ${putRes.status} — import je ale hotový, jen příští běh guard nepřeskočí.`);
        } else {
            console.log(`[feed-hash] Otisk uložen (${feedHash.slice(0, 16)}...).`);
        }
    } catch (e) {
        console.warn(`[feed-hash] Uložení otisku selhalo: ${(e as Error).message} — import je hotový, jen příští běh guard nepřeskočí.`);
    }

    console.log(`DONE. rows=${rowCount} sent=${totalSent} written=${totalWritten} skipped=${totalSkipped}`, finishData);
}

main().catch(e => { console.error(e); process.exit(1); });
