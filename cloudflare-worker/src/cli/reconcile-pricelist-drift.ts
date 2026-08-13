// Reconciliation / Price Integrity Layer (Stage 5 of the validation model,
// see docs/CORE_LOGIC_AND_VALIDATION.md §3.5). READ-ONLY -- never writes to
// Shoptet. Independently re-derives what every tier price SHOULD be from the
// live base pricelist + policy-v1.json (the exact same function production
// uses, calculateProductsPricing), and diffs it against what is ACTUALLY
// written on each tier pricelist right now.
//
// This exists because Stage 1-4 (config validation, dry-run guards,
// regression tests, run-level fail-closed handling) all protect a *change*
// -- they can only catch something wrong with a sync run that actually
// executes and actually reaches an error branch. INC-010's root cause
// (getProductDetail() silently returning undefined for 12 days) never
// reached an error branch: every run just quietly did less work than it
// should have and reported SUCCESS throughout. 812 products drifted wrong
// with zero alerts. Stage 5 doesn't trust any run's self-report -- it
// re-derives the answer from first principles and compares against reality.
//
// Alert format is deliberately literal, per spec:
//   "Tahle cena měla být X. Shoptet má Y. Rozdíl = Z. Produkt {code}
//    (tier {tier}) nebyl synchronizován. -> ALERT."
//
// Debounce: a product missing ENTIRELY from a tier pricelist alerts
// immediately (unambiguous -- there is no legitimate reason a product with
// a computed price has zero entry in a tier pricelist). A VALUE mismatch
// only alerts once it has persisted across two separate runs (tracked via
// .reconciliation_state.json, committed to the repo like .sync_state.json)
// -- a price that changed 10 minutes ago and hasn't been picked up by the
// 15-minute sync cron yet is not a bug, and alerting on it immediately
// would just be noise that trains people to ignore the alert.
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';
import { calculateProductsPricing } from '../shoptet-api/pricing-bridge';
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

const TOLERANCE = 0.02; // rounding tolerance, EUR
const STATE_FILE = path.join(process.cwd(), '.reconciliation_state.json');

interface PendingMismatch {
    firstSeen: string; // YYYY-MM-DD
    expected: string;
    actual: string;
}
type ReconciliationState = Record<string, PendingMismatch>; // key: `${code}::${tier}`

function loadState(): ReconciliationState {
    try {
        if (!fs.existsSync(STATE_FILE)) return {};
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    } catch (e) {
        console.warn(`[Reconciliation] Nepodařilo se načíst ${STATE_FILE}, začínám s prázdným stavem:`, e);
        return {};
    }
}

function saveState(state: ReconciliationState) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

async function loadManufacturerMap(feedUrl: string): Promise<Record<string, string>> {
    const map: Record<string, string> = {};
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) {
        console.warn(`[Reconciliation] Master feed fetch selhal (HTTP ${res.status}) -- manufacturer mapa bude prázdná, brand stropy se nebudou počítat správně.`);
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

interface Alert {
    code: string;
    tier: string;
    expected: string;
    actual: string;
    kind: 'missing' | 'mismatch';
}

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set');

    const client = new ShoptetApiClient(token);
    const today = new Date().toISOString().slice(0, 10);

    console.log('=== RECONCILIATION / PRICE INTEGRITY LAYER ===');
    console.log(`Datum běhu: ${today}\n`);

    console.log('1. Stahuji seznam ceníků...');
    const pricelists = await client.getPricelists();
    const basePricelist = pricelists.find(p => p.name === 'Maloobchodný') || pricelists[0];
    const tierPricelists = pricelists.filter(p => p.id !== basePricelist.id);
    console.log(`   Základní: ${basePricelist.name} (${basePricelist.id}). Tiery: ${tierPricelists.map(p => p.name).join(', ')}`);

    console.log('2. Stahuji manufacturer mapu z master feedu...');
    const manufacturerMap = await loadManufacturerMap(feedUrl);
    console.log(`   ${Object.keys(manufacturerMap).length} kódů s manufacturer.`);

    console.log('3. Stahuji základní ceník...');
    const baseItems = await client.getPricelistProducts(basePricelist.id);
    console.log(`   ${baseItems.length} položek.`);

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
        .filter((p: any) => p.basePrice > 0);
    console.log(`   ${engineProducts.length} produktů s platnou basePrice.`);

    console.log('4. Počítám očekávané ceny pro všechny tiery (stejná funkce jako produkce)...');
    const { results, failures } = calculateProductsPricing(
        engineProducts,
        tierPricelists.map(p => ({ name: p.name, id: p.id }))
    );
    if (failures.length > 0) {
        console.warn(`   [WARNING] ${failures.length} výpočetních selhání (viz pricing-bridge.ts failures) -- tyhle produkty/tiery se v reconciliaci přeskočí, jsou to Stage-4 problémy, ne Stage-5.`);
    }

    const state = loadState();
    const newState: ReconciliationState = {};
    const immediateAlerts: Alert[] = [];
    const escalatedAlerts: Alert[] = [];
    let totalChecked = 0;
    let totalMatched = 0;

    for (const tier of tierPricelists) {
        console.log(`\n=== Stahuji a porovnávám tier ${tier.name} (${tier.id}) ===`);
        const tierItems = await client.getPricelistProducts(tier.id);
        const tierActualByCode = new Map<string, number | null>();
        for (const item of tierItems) {
            const p = item.price?.price;
            tierActualByCode.set(item.code, p !== null && p !== undefined ? parseFloat(p) : null);
        }

        for (const r of results) {
            const expected = r.prices[tier.name];
            if (!expected) continue;
            totalChecked++;
            const key = `${r.code}::${tier.name}`;
            const actual = tierActualByCode.get(r.code);

            if (actual === undefined) {
                // Zcela chybí -- žádná legitimní příčina, alertuje se okamžitě, bez debounce.
                immediateAlerts.push({ code: r.code, tier: tier.name, expected, actual: 'CHYBÍ CELÝ ZÁZNAM', kind: 'missing' });
                continue;
            }

            const actualStr = actual === null ? 'null (prázdné)' : actual.toFixed(2);
            const diff = actual === null ? Infinity : Math.abs(actual - parseFloat(expected));

            if (diff <= TOLERANCE) {
                totalMatched++;
                continue; // sedí, nic se nezapisuje do newState -- pending mismatch (pokud existoval) se tím pádem "vyřeší" a zmizí
            }

            const prior = state[key];
            if (prior && prior.firstSeen < today) {
                // Přetrvává z předchozího běhu -> eskalace, ALERT.
                escalatedAlerts.push({ code: r.code, tier: tier.name, expected, actual: actualStr, kind: 'mismatch' });
                newState[key] = { firstSeen: prior.firstSeen, expected, actual: actualStr };
            } else {
                // První spatření (dnes) -- ještě se nealertuje, jen se zaznamená do stavu.
                newState[key] = { firstSeen: prior?.firstSeen || today, expected, actual: actualStr };
            }
        }
    }

    saveState(newState);

    console.log('\n\n=========================================');
    console.log('VÝSLEDEK RECONCILIACE');
    console.log('=========================================');
    console.log(`Zkontrolováno: ${totalChecked} (produkt × tier kombinací)`);
    console.log(`Sedí: ${totalMatched}`);
    console.log(`Nově zjištěné (čeká na potvrzení příští běh, zatím NEALERTOVÁNO): ${Object.keys(newState).length - escalatedAlerts.length}`);
    console.log(`ALERT -- zcela chybí (okamžitě): ${immediateAlerts.length}`);
    console.log(`ALERT -- hodnota nesedí (přetrvává 2+ běhy): ${escalatedAlerts.length}`);

    const allAlerts = [...immediateAlerts, ...escalatedAlerts];
    if (allAlerts.length > 0) {
        console.log('\n--- ALERTY ---');
        for (const a of allAlerts) {
            const diffStr = a.kind === 'missing' ? 'N/A' : (parseFloat(a.actual) - parseFloat(a.expected)).toFixed(2);
            console.log(`Tahle cena měla být ${a.expected}. Shoptet má ${a.actual}. Rozdíl = ${diffStr}. Produkt ${a.code} (tier ${a.tier}) nebyl synchronizován. -> ALERT.`);
        }
    }

    // --- SELF-CHECK (meta-validace) ---------------------------------------
    // "0 alertů" je nerozeznatelné od "reconciliace se sama potichu rozbila
    // a nezkontrolovala skoro nic" -- PŘESNĚ ten samý tvar chyby jako
    // INC-010 (getProductDetail() vracelo undefined, run hlásil SUCCESS,
    // protože nikdy nedošel do větve, co by řekla "něco je špatně"). Kdyby
    // se to nekontrolovalo, reconciliace by mohla mít stejnou slepou
    // skvrnu, jakou má opravovat. Mirror stejného vzorce jako Stage 2's
    // Guard A (MIN_EXPECTED_PRODUCTS v sync-coupon-fields-diff.ts) --
    // absolutní minimum, ne relativní tolerance, protože relativní
    // tolerance k prázdnému výsledku (0/0) nedává smysl.
    console.log('\n5. Self-check: ověřuji, že reconciliace sama proběhla smysluplně...');
    const MIN_EXPECTED_BASE_PRODUCTS = 5000;
    const MIN_EXPECTED_CHECKS = MIN_EXPECTED_BASE_PRODUCTS * (tierPricelists.length - 1);
    const selfCheckFailures: string[] = [];

    if (engineProducts.length < MIN_EXPECTED_BASE_PRODUCTS) {
        selfCheckFailures.push(`Základní ceník vrátil jen ${engineProducts.length} produktů s platnou cenou (očekáváno alespoň ${MIN_EXPECTED_BASE_PRODUCTS}) -- feed/API pravděpodobně useknuté nebo selhala autentizace, reconciliace neproběhla na reálném katalogu.`);
    }
    if (totalChecked < MIN_EXPECTED_CHECKS) {
        selfCheckFailures.push(`Zkontrolováno jen ${totalChecked} produkt×tier kombinací (očekáváno alespoň ${MIN_EXPECTED_CHECKS}) -- některé tiery se pravděpodobně nestáhly vůbec.`);
    }
    if (tierPricelists.length < 5) {
        selfCheckFailures.push(`Nalezeno jen ${tierPricelists.length} tierových ceníků (očekáváno alespoň 5) -- getPricelists() pravděpodobně vrátilo neúplná data.`);
    }
    if (failures.length > engineProducts.length * 0.5) {
        selfCheckFailures.push(`${failures.length} výpočetních selhání z ${engineProducts.length} produktů -- víc než polovina, pricing-bridge samotný je pravděpodobně rozbitý, ne jednotlivé produkty.`);
    }

    if (selfCheckFailures.length > 0) {
        console.error('\n--- SELF-CHECK SELHAL (i kdyby 0 alertů výše) ---');
        for (const f of selfCheckFailures) console.error(`  - ${f}`);
    } else {
        console.log('   Self-check OK -- reconciliace zkontrolovala plausibilní objem dat, výsledek "0 alertů" (pokud nastal) je důvěryhodný.');
    }

    console.log('\n=== RECONCILIATION DOKONČENA ===');

    if (selfCheckFailures.length > 0) {
        throw new Error(`RECONCILIATION SELF-CHECK SELHAL (validace sama je podezřelá, nezávisle na ${allAlerts.length} nalezených alertech): ${selfCheckFailures.join(' | ')}`);
    }
    if (allAlerts.length > 0) {
        throw new Error(`Reconciliation našla ${allAlerts.length} neshod (${immediateAlerts.length}x zcela chybí, ${escalatedAlerts.length}x hodnota nesedí přes 2+ běhy). Detail výše v logu.`);
    }
}

main().catch(e => {
    console.error('CHYBA:', e);
    process.exit(1);
});
