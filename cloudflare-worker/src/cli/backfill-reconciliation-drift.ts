// Jednorázový nápravný (backfill) skript pro produkty, co uvízly v mezeře PŘED
// opravou INC-015 (viz INCIDENTS.md 2026-09-05) -- FULL SYNC větev
// ProductsReader.fetchProducts() fabrikovala basePrice=0 pro produkty s
// chybějící cenou místo aby je vynechala, což se v tier ceníku projevilo jako
// chybějící/nesedící záznam. Oprava (products-reader.ts) zastavuje VZNIKÁNÍ
// nových mezer, ale nedoplňuje ty, co už vznikly -- to je úkol tohoto skriptu.
//
// Sdílí stejnou re-derivační logiku jako reconcile-pricelist-drift.ts (Stage 5):
// stáhne živý základní ceník, přepočítá očekávané ceny stejnou funkcí jako
// produkce (calculateProductsPricing), a pro KAŽDÝ produkt×tier z
// .reconciliation_state.json (ne jen vzorek) porovná expected vs. actual.
//
// DRY-RUN JE VÝCHOZÍ REŽIM. Skript nikdy nezapisuje do Shoptetu, dokud
// nedostane explicitní --live flag. V dry-run módu vypíše diff (přes
// PricelistWriter's built-in dryRun logging) a uloží ho i jako JSON soubor
// ke kontrole před jakýmkoli ostrým během.
//
// Usage:
//   npx tsx src/cli/backfill-reconciliation-drift.ts             (dry-run, výchozí)
//   npx tsx src/cli/backfill-reconciliation-drift.ts --live       (ostrý zápis)
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';
import { calculateProductsPricing } from '../shoptet-api/pricing-bridge';
import { PricelistWriter, PricelistDiff } from '../shoptet-api/pricelist-writer';
import Decimal from 'decimal.js';
import { CsvParserStream } from '../csv/csv-parser';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const TOLERANCE = 0.02; // stejná tolerance jako reconcile-pricelist-drift.ts
const STATE_FILE = path.join(process.cwd(), '.reconciliation_state.json');
const OUTPUT_FILE = path.join(process.cwd(), 'backfill-plan.json');

interface PendingMismatch {
    firstSeen: string;
    expected: string;
    actual: string;
}
type ReconciliationState = Record<string, PendingMismatch>;

async function loadManufacturerMap(feedUrl: string): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) {
        console.warn(`[Backfill] Master feed fetch selhal (HTTP ${res.status}) -- manufacturer mapa bude prázdná.`);
        return map;
    }
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        if (row['code'] && row['manufacturer']) map[row['code']] = row['manufacturer'];
    }
    return map;
}

async function main() {
    const isLive = process.argv.includes('--live');
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set');
    if (!fs.existsSync(STATE_FILE)) throw new Error(`${STATE_FILE} neexistuje -- nic k backfillu.`);

    console.log('=== BACKFILL: RECONCILIATION DRIFT (INC-015) ===');
    console.log(`Režim: ${isLive ? '!!! OSTRÝ ZÁPIS !!!' : 'DRY-RUN (nic se nezapíše)'}\n`);

    const state: ReconciliationState = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    const affectedByTier = new Map<string, Set<string>>(); // tier name -> set kódů
    for (const key of Object.keys(state)) {
        const [code, tier] = key.split('::');
        if (!affectedByTier.has(tier)) affectedByTier.set(tier, new Set());
        affectedByTier.get(tier)!.add(code);
    }
    const totalAffected = Object.keys(state).length;
    console.log(`Načteno ${totalAffected} produkt×tier záznamů z ${STATE_FILE}.`);

    const client = new ShoptetApiClient(token);

    console.log('1. Stahuji seznam ceníků...');
    const pricelists = await client.getPricelists();
    const basePricelist = pricelists.find(p => p.name === 'Maloobchodný') || pricelists[0];
    const tierPricelists = pricelists.filter(p => p.id !== basePricelist.id && affectedByTier.has(p.name));
    console.log(`   Dotčené tiery: ${tierPricelists.map(p => p.name).join(', ')}`);

    console.log('2. Stahuji manufacturer mapu z master feedu...');
    const manufacturerMap = await loadManufacturerMap(feedUrl);
    console.log(`   ${Object.keys(manufacturerMap).length} kódů s manufacturer.`);

    console.log('3. Stahuji základní ceník...');
    const baseItems = await client.getPricelistProducts(basePricelist.id);
    console.log(`   ${baseItems.length} položek.`);

    const allAffectedCodes = new Set(Object.keys(state).map(k => k.split('::')[0]));

    const engineProducts = baseItems
        .map((item: any) => {
            const basePrice = item.price?.price ? parseFloat(item.price.price) : 0;
            const actionPrice = item.price?.actionPrice?.price;
            let productMaxDiscount: number | undefined = undefined;
            if (item.sales?.minPriceRatio) {
                const ratio = parseFloat(item.sales.minPriceRatio);
                if (!isNaN(ratio) && ratio <= 1) productMaxDiscount = 1 - ratio;
            }
            return {
                code: item.code,
                basePrice,
                actionPrice: actionPrice !== null && actionPrice !== undefined ? parseFloat(actionPrice) : undefined,
                productMaxDiscount,
                manufacturer: manufacturerMap[item.code],
            };
        })
        .filter((p: any) => allAffectedCodes.has(p.code));
    console.log(`   ${engineProducts.length}/${allAffectedCodes.size} postižených kódů má aktuálně platnou basePrice na základním ceníku.`);

    const missingFromBase = [...allAffectedCodes].filter(c => !engineProducts.some((p: any) => p.code === c));
    if (missingFromBase.length > 0) {
        console.warn(`   [WARNING] ${missingFromBase.length} postižených kódů NEMÁ platnou basePrice na základním ceníku ani teď -- nelze pro ně spočítat cenu, přeskakuji (typicky smazaný/vyřazený produkt): ${missingFromBase.slice(0, 20).join(', ')}${missingFromBase.length > 20 ? '...' : ''}`);
    }

    console.log('4. Počítám očekávané ceny (stejná funkce jako produkce)...');
    const { results, failures } = calculateProductsPricing(
        engineProducts as any,
        tierPricelists.map(p => ({ name: p.name, id: p.id }))
    );
    if (failures.length > 0) {
        console.warn(`   [WARNING] ${failures.length} výpočetních selhání -- viz pricing-bridge.ts failures, tyhle se v backfillu přeskočí.`);
    }
    const resultByCode = new Map(results.map(r => [r.code, r]));

    const writer = new PricelistWriter(client, { dryRun: !isLive });
    const fullPlan: Record<string, { pricelistId: number; diffs: Array<{ code: string; oldActual: string; newExpected: string }> }> = {};
    let totalPlanned = 0;
    let totalSkippedNoLongerMismatched = 0;
    let totalSkippedNoBasePrice = 0;

    for (const tier of tierPricelists) {
        console.log(`\n=== Tier ${tier.name} (${tier.id}) ===`);
        const affectedCodesForTier = affectedByTier.get(tier.name)!;
        const tierItems = await client.getPricelistProducts(tier.id);
        const tierActualByCode = new Map<string, number | null>();
        for (const item of tierItems) {
            const p = item.price?.price;
            tierActualByCode.set(item.code, p !== null && p !== undefined ? parseFloat(p) : null);
        }

        const diffs: PricelistDiff[] = [];
        const planEntries: Array<{ code: string; oldActual: string; newExpected: string }> = [];

        for (const code of affectedCodesForTier) {
            const r = resultByCode.get(code);
            if (!r) { totalSkippedNoBasePrice++; continue; }
            const expectedStr = r.prices[tier.name];
            if (!expectedStr) { totalSkippedNoBasePrice++; continue; }

            const actual = tierActualByCode.get(code);
            const actualNum = actual === null || actual === undefined ? null : actual;
            const expectedNum = parseFloat(expectedStr);
            const diff = actualNum === null ? Infinity : Math.abs(actualNum - expectedNum);

            if (diff <= TOLERANCE) {
                // Mezitím se to už samo srovnalo (např. běžný sync to dohnal) -- nic k opravě.
                totalSkippedNoLongerMismatched++;
                continue;
            }

            diffs.push({
                code,
                oldPrice: actualNum !== null ? new Decimal(actualNum) : null,
                newPrice: new Decimal(expectedStr),
            });
            planEntries.push({
                code,
                oldActual: actualNum === null ? 'CHYBÍ/null' : actualNum.toFixed(2),
                newExpected: expectedStr,
            });
        }

        if (diffs.length > 0) {
            await writer.processDiff(tier.id, tier.name, diffs);
            fullPlan[tier.name] = { pricelistId: tier.id, diffs: planEntries };
            totalPlanned += diffs.length;
        } else {
            console.log(`   Žádné zbývající rozdíly pro tenhle tier.`);
        }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({
        generatedAt: new Date().toISOString(),
        mode: isLive ? 'LIVE' : 'DRY_RUN',
        totalAffectedInState: totalAffected,
        totalPlanned,
        totalSkippedNoLongerMismatched,
        totalSkippedNoBasePrice,
        missingFromBaseCodes: missingFromBase,
        plan: fullPlan,
    }, null, 2), 'utf-8');

    console.log('\n\n=========================================');
    console.log('SOUHRN BACKFILLU');
    console.log('=========================================');
    console.log(`Režim: ${isLive ? 'OSTRÝ ZÁPIS' : 'DRY-RUN'}`);
    console.log(`Záznamů ve state (celkem): ${totalAffected}`);
    console.log(`Naplánováno k zápisu: ${totalPlanned}`);
    console.log(`Přeskočeno (mezitím se srovnalo samo): ${totalSkippedNoLongerMismatched}`);
    console.log(`Přeskočeno (chybí platná basePrice / calc selhal): ${totalSkippedNoBasePrice}`);
    console.log(`Plán uložen do: ${OUTPUT_FILE}`);
    if (!isLive) {
        console.log(`\nToto byl DRY-RUN. Pro ostrý zápis spusť znovu s --live po schválení diffu výše/v ${OUTPUT_FILE}.`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
