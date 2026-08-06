// Počítá skladový semafor (zelená/žlutá/červená) + stav platby pro všechny
// OTEVŘENÉ objednávky (ne vybavené, ne zrušené) a zapíše výsledek do Workerovy
// KV, odkud ho čte skrytá stránka /orders-dashboard-xk92q. Skladové množství
// se čte z master feedu, součet sloupců `stock:Predvolený sklad` +
// `stock:Feedový` (oba sklady mají v adminu zapnuté "Viditelnost skladu na
// e-shopu", takže se sčítají do zákaznicky zobrazené dostupnosti -- ověřeno
// živě 2026-08-06), takže netřeba dělat N+1 API volání na sklad pro položku.
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';
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

const MASTER_FEED_URL = process.env.MASTER_FEED_URL;
const CF_WORKER_URL = process.env.CF_WORKER_URL;
const CF_WORKER_TOKEN = process.env.CF_WORKER_TOKEN;

// Statusy, které Shoptet sám považuje za hotové -- vybavená (-3) a zrušená (-4).
// Tyhle objednávky se NEVYŘAZUJÍ ze seznamu (klient chce vidět, že "zmizely" tím,
// že se přeškrtnou, ne že prostě nejsou vidět), jen se označí jako `resolved`,
// aby je dashboard automaticky přeškrtl -- žádné ruční klikání tady, stačí
// v Shoptetu reálně vybavit objednávku a projeví se to samo při dalším refreshi.
const CLOSED_STATUS_IDS = new Set([-3, -4]);

// Status id 11 = "Navýšenie bodov" -- CELÁ objednávka je jen interní ruční
// navýšení obratu majitelem (viz status list z /api/orders/statuses, potvrzeno
// živě: 42 takových objednávek). Není to skutečná objednávka k vybavení vůbec,
// takže se z dashboardu úplně vynechává -- ani jako otevřená, ani jako
// "resolved" (nikdy nebyla otevřená v prvním místě).
const FAKE_ORDER_STATUS_IDS = new Set([11]);

interface OrderItemStatus {
    name: string;
    code: string | null;
    ordered: number;
    inStock: number | null; // null = kód nenalezen ve feedu (nedohledatelné)
}

interface OrderStatus {
    code: string;
    guid: string;
    customerName: string;
    statusName: string;
    paid: boolean;
    priceWithVat: string;
    adminUrl: string;
    creationTime: string;
    semaphore: 'green' | 'yellow' | 'red';
    items: OrderItemStatus[];
    statusId: number;
    resolvedByStatus: boolean;
}

async function loadStockMap(): Promise<Record<string, number>> {
    if (!MASTER_FEED_URL) throw new Error('MASTER_FEED_URL not set');
    const res = await fetch(MASTER_FEED_URL);
    if (!res.ok || !res.body) throw new Error(`Feed fetch failed: HTTP ${res.status}`);
    const map: Record<string, number> = {};
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code) continue;
        // Shoptet má DVA fyzické sklady ("Predvolený sklad", "Feedový") a OBA mají
        // zapnuté "Viditelnost skladu na e-shopu" (ověřeno živě v adminu 2026-08-06) --
        // tzn. zákazníkům zobrazovaná dostupnost je součet obou, ne jen jednoho.
        // Bez tohohle součtu jsme systematicky podhodnocovali sklad u ~3853/16650
        // produktů (těch, co mají zásobu ve Feedový skladu), což vysvětlovalo
        // případy, kdy objednávka šla vybavit i přes to, že náš dashboard hlásil
        // "chýba" (potvrzeno živě: FOX mikina/tepláky, obj. 2026000958).
        let sum = 0;
        let any = false;
        for (const col of ['stock:Predvolený sklad', 'stock:Feedový']) {
            const v = row[col];
            if (v !== undefined && v !== '') {
                const n = parseFloat(v.replace(',', '.'));
                if (!isNaN(n)) { sum += n; any = true; }
            }
        }
        if (any) map[code] = sum;
    }
    return map;
}

function computeSemaphore(items: OrderItemStatus[]): 'green' | 'yellow' | 'red' {
    let anyOk = false;
    let anyMissing = false;
    for (const item of items) {
        if (item.inStock === null) { anyMissing = true; continue; }
        if (item.inStock >= item.ordered) anyOk = true;
        else anyMissing = true;
    }
    if (anyMissing && !anyOk) return 'red';
    if (anyMissing) return 'yellow';
    return 'green';
}

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    if (!CF_WORKER_URL || !CF_WORKER_TOKEN) throw new Error('CF_WORKER_URL/TOKEN not set');

    console.log('Načítám skladové množství z feedu...');
    const stockMap = await loadStockMap();
    console.log(`Načteno ${Object.keys(stockMap).length} skladových položek.`);

    const client = new ShoptetApiClient(token);

    // Načteme, co jsme naposledy zapsali -- pro objednávky, které mezitím
    // zavřeli v Shoptetu (Vybavená/Stornovaná), nemusíme znovu stahovat celý
    // detail (drahé, N+1). Stačí převzít jejich dřív spočítané položky a jen
    // aktualizovat stav podle toho, co už máme z `changed` (viz níže) -- ten
    // obsahuje status.id pro KAŽDOU objednávku v okně zdarma, bez extra volání.
    let previousByCode: Record<string, OrderStatus> = {};
    try {
        const prevRes = await fetch(`${CF_WORKER_URL}/v1/orders-status`, {
            headers: { Authorization: `Bearer ${CF_WORKER_TOKEN}` }
        });
        if (prevRes.ok) {
            const prevData = await prevRes.json() as { orders?: OrderStatus[] };
            for (const o of prevData.orders || []) previousByCode[o.code] = o;
        }
    } catch { /* první běh bez historie je v pořádku */ }

    // Objednávky za posledních 14 dní -- starší archiv řešíme jinak, tohle je
    // pro operativní "co se musí vybavit teď" přehled.
    const from = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, '+0000');
    console.log(`Stahuji objednávky od ${from}...`);
    const changed = await client.getOrdersByChangeTime(from);
    console.log(`Nalezeno ${changed.length} objednávek za posledních 14 dní.`);

    const results: OrderStatus[] = [];
    for (const order of changed) {
        if (FAKE_ORDER_STATUS_IDS.has(order.status.id)) continue;

        if (CLOSED_STATUS_IDS.has(order.status.id)) {
            // Uzavřená objednávka -- pokud ji už známe z minula, jen aktualizujeme
            // stav a přeškrtneme, bez nového (drahého) stažení detailu. Pokud ji
            // neznáme vůbec (byla uzavřená hned od začátku, nikdy nebyla "otevřená"
            // v našem sledování), přeskočíme -- nikdy nás nezajímala kvůli skladu.
            const prev = previousByCode[order.code];
            if (prev) {
                results.push({ ...prev, paid: order.paid, statusName: order.status.name, statusId: order.status.id, resolvedByStatus: true });
            }
            continue;
        }

        const detailRes = await fetch(
            `https://api.myshoptet.com/api/orders/${order.code}`,
            { headers: { 'Shoptet-Private-API-Token': token, Accept: 'application/json' } }
        );
        if (!detailRes.ok) {
            console.warn(`Přeskakuji ${order.code} — detail se nepodařilo načíst (HTTP ${detailRes.status}).`);
            continue;
        }
        const detailJson = await detailRes.json() as any;
        const detail = detailJson.data?.order;
        if (!detail) continue;

        const rawProductItems = (detail.items || []).filter((i: any) => i.itemType === 'product');
        const realProductItems = rawProductItems
            // "Navýšenie bodov" / "Doplnenie bodov" -- ruční interní navýšení obratu
            // majitelem (viz sync-orchestrator.ts, isManualTurnoverTopUp), NENÍ
            // skutečný fyzický produkt. Nemá smysluplný kód ani sklad -- bez filtru
            // se to omylem srovnávalo s náhodnou shodou ve feedu (viděno živě:
            // "-184383/1" u objednávky Andreje Koreně).
            .filter((i: any) => !/navýšenie bodov|doplnenie bodov/i.test(i.name || ''));

        // Objednávka SESTÁVÁ POUZE z ručních navýšení bodů (žádný skutečný produkt) --
        // není to reálná objednávka k vybavení, jen interní účetní záznam. Bez tohohle
        // filtru prázdný seznam položek vypadal jako "vše skladom" -> špatně se
        // zobrazovalo jako "PRIPRAVENÉ NA ODOSLANIE" (potvrzeno živě: Martin Dujnič,
        // Lubo Ďurán -- objednávky typu "Doplnenie bodov ZR"). Takové objednávky se
        // do dashboardu vůbec nezapisují.
        if (rawProductItems.length > 0 && realProductItems.length === 0) continue;

        const items: OrderItemStatus[] = realProductItems
            .map((i: any) => {
                // Order items nesou productGuid, ne code -- ale feed je klíčovaný podle
                // code. Zkusíme dohledat code z feedu podle guid, pokud ho items nemají
                // rovnou (Private API u položek code obvykle nevrací).
                const code = i.code || null;
                const ordered = parseFloat(i.amount || '1');
                const inStock = code && stockMap[code] !== undefined ? stockMap[code] : null;
                return { name: i.name, code, ordered, inStock };
            });

        results.push({
            code: order.code,
            guid: order.guid,
            customerName: detail.billingAddress?.fullName || '—',
            statusName: order.status.name,
            paid: order.paid,
            priceWithVat: order.price.withVat,
            adminUrl: detail.adminUrl,
            creationTime: detail.creationTime,
            semaphore: computeSemaphore(items),
            items,
            statusId: order.status.id,
            resolvedByStatus: CLOSED_STATUS_IDS.has(order.status.id),
        });
    }

    console.log(`Zpracováno ${results.length} objednávek. Zapisuji do Workeru...`);

    await fetch(`${CF_WORKER_URL}/v1/orders-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${CF_WORKER_TOKEN}` },
        body: JSON.stringify({ orders: results, updatedAt: new Date().toISOString() })
    });

    console.log('=== HOTOVO ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
