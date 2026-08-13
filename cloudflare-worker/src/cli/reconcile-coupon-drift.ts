// Coupon Reconciliation / Coupon Integrity Layer (Stage 5 of the validation model,
// see docs/CORE_LOGIC_AND_VALIDATION.md §3.5, built for pricing 2026-08-13; this is
// the same model applied to the coupon pipeline per INC-011). READ-ONLY -- never
// writes to Shoptet. Independently re-derives what every product's coupon fields
// (discountCoupon / minPriceRatio) SHOULD be from the live base pricelist + master
// feed + policy-v1.json/coupon-policy.json, using computeCouponWrites() -- the exact
// same function production write scripts (sync-coupon-fields-diff.ts,
// sync-coupon-fields-single-product.ts) use -- and diffs it against what is ACTUALLY
// written on every pricelist (10 ZR tiers + GUEST/"Hlavný cenník") right now.
//
// Why this exists (INC-011, 2026-08-13): a live spot-check found 61 products
// (~0.4% of catalog) with discountCoupon=TRUE on ZR20/ZR25 despite
// coupon-policy.json's lockedTiers absolute-precedence rule (Rule 4), and
// confirmed NO verification at all had ever been done for ZR6-ZR18 or the main/
// guest pricelist. Same root-cause family as INC-010: sync-coupon-fields-single-
// product.ts only runs on a Shoptet webhook that doesn't always fire, and every
// plošný/scheduled fallback (coupon-fields.yml etc.) was archived on 2026-08-12
// with nothing replacing it. Stage 1-3 (config validation, dry-run guards,
// regression tests) all protect a *change* -- they only catch something wrong with
// a write that actually runs. Stage 5 doesn't trust any run's self-report -- it
// re-derives the answer from first principles and compares against reality,
// independently of whether the webhook ever fired at all.
//
// ZR20/ZR25 always-false is checked FIRST and separately from the general
// mismatch pass, per Jan's explicit instruction -- it's the simplest,
// least-ambiguous check possible (Rule 4 has zero legitimate exceptions), so it
// gets its own immediate, no-debounce alert category rather than being buried
// inside the generic per-tier diff loop.
//
// Alert format (mirrors reconcile-pricelist-drift.ts's spec-literal format):
//   "Kupón pro produkt {code} (tier {tier}) měl být discountCoupon={X}/
//    minPriceRatio={Y}. Shoptet má discountCoupon={A}/minPriceRatio={B}. -> ALERT."
//
// Debounce: a product missing ENTIRELY from a tier pricelist, OR a ZR20/ZR25 lock
// violation (discountCoupon=true where Rule 4 demands false), alerts immediately --
// neither has a legitimate transient cause. A plain VALUE mismatch (wrong
// minPriceRatio, or a non-locked tier's discountCoupon flag off) only alerts once
// it has persisted across two separate runs (tracked via
// .coupon_reconciliation_state.json, committed to the repo like
// .reconciliation_state.json/.sync_state.json) -- a coupon field that changed 10
// minutes ago and hasn't been picked up by the twice-daily coupon-fields-diff cron
// yet is not a bug.
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { ShoptetApiClient } from '../shoptet-api/client';
import { CsvParserStream } from '../csv/csv-parser';
import { computeCouponWrites, CouponWriteItem, ProductCouponInput } from '../coupon/compute-coupon-writes';
import { ALL_PRICELISTS_MAP, GUEST_PRICELIST_ID, LOCKED_COUPON_TIERS } from '../coupon/tier-pricelist-map';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

// minPriceRatio is written with 4dp precision (compute-coupon-writes.ts's
// `.toFixed(4)`) -- tolerance covers rounding, not a meaningfully different cap.
const RATIO_TOLERANCE = 0.001;
const STATE_FILE = path.join(process.cwd(), '.coupon_reconciliation_state.json');

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
        console.warn(`[CouponReconciliation] Nepodařilo se načíst ${STATE_FILE}, začínám s prázdným stavem:`, e);
        return {};
    }
}

function saveState(state: ReconciliationState) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n', 'utf-8');
}

interface FeedAttrs {
    manufacturer?: string;
    category?: string;
    allowLoyaltyDiscount: boolean;
}

// Same convention as sync-coupon-fields-diff.ts/sync-coupon-fields-single-product.ts's
// resolveAllowLoyaltyDiscount(): absent defaults to allowed.
function resolveAllowLoyaltyDiscount(row: Record<string, string>): boolean {
    const val = row['applyLoyaltyDiscount'];
    return val === '1' || val === 'true' || val === 'yes' || val === undefined;
}

async function loadFeedAttrsMap(feedUrl: string): Promise<Map<string, FeedAttrs>> {
    const map = new Map<string, FeedAttrs>();
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) {
        console.warn(`[CouponReconciliation] Master feed fetch selhal (HTTP ${res.status}) -- manufacturer/category/allowLoyaltyDiscount atributy budou chybět, brand/category stropy a loyalty-off produkty se nebudou počítat správně.`);
        return map;
    }
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        if (!row['code']) continue;
        map.set(row['code'], {
            manufacturer: row['manufacturer'] || undefined,
            category: row['categoryText'] || undefined,
            allowLoyaltyDiscount: resolveAllowLoyaltyDiscount(row)
        });
    }
    return map;
}

function loadPolicyConfig(): { loyaltyTiers: Record<string, Decimal>; brandLimits: Record<string, Decimal>; categoryLimits: Record<string, Decimal> } {
    const policyPath = path.resolve(__dirname, '../../../src/config/policies/policy-v1.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
    const toDecimalMap = (obj: Record<string, number> | undefined): Record<string, Decimal> => {
        const out: Record<string, Decimal> = {};
        for (const [k, v] of Object.entries(obj || {})) out[k] = new Decimal(v);
        return out;
    };
    return {
        loyaltyTiers: toDecimalMap(policy.loyaltyTiers),
        brandLimits: toDecimalMap(policy.brandLimits),
        categoryLimits: toDecimalMap(policy.categoryLimits)
    };
}

interface Alert {
    code: string;
    tier: string;
    expected: string;
    actual: string;
    kind: 'missing' | 'lock-violation' | 'mismatch';
}

function formatCoupon(applyDiscountCoupon: boolean, minPriceRatio: string): string {
    return `discountCoupon=${applyDiscountCoupon}/minPriceRatio=${minPriceRatio}`;
}

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set');

    const client = new ShoptetApiClient(token);
    const today = new Date().toISOString().slice(0, 10);

    console.log('=== COUPON RECONCILIATION / COUPON INTEGRITY LAYER ===');
    console.log(`Datum běhu: ${today}\n`);

    console.log('1. Stahuji seznam ceníků...');
    const pricelists = await client.getPricelists();
    const pricelistsById = new Map(pricelists.map(p => [p.id, p]));
    for (const [tier, id] of Object.entries(ALL_PRICELISTS_MAP)) {
        if (!pricelistsById.has(id)) {
            throw new Error(`Ceník pro tier ${tier} (očekávané ID ${id}, viz tier-pricelist-map.ts) na Shoptetu vůbec neexistuje. Oprav ALL_PRICELISTS_MAP a spusť znovu.`);
        }
    }
    console.log(`   Všech ${Object.keys(ALL_PRICELISTS_MAP).length} očekávaných ceníků (10 ZR tierů + GUEST) potvrzeno živě.`);

    console.log('2. Stahuji atributy z master feedu (manufacturer/category/allowLoyaltyDiscount)...');
    const feedAttrs = await loadFeedAttrsMap(feedUrl);
    console.log(`   ${feedAttrs.size} kódů s atributy.`);

    console.log(`3. Stahuji základní/GUEST ceník (id ${GUEST_PRICELIST_ID}, zdroj basePrice/actionPrice)...`);
    const baseItems = await client.getPricelistProducts(GUEST_PRICELIST_ID);
    console.log(`   ${baseItems.length} položek.`);

    // productMaxDiscount is deliberately left undefined here, NEVER read from the base
    // pricelist's own sales.minPriceRatio -- that field IS the coupon output this
    // script is trying to independently verify, so using it as an input would be the
    // exact circular-dependency bug coupon-sales-writer.ts documents (fixed
    // 2026-08-06 in sync-coupon-fields-live.ts/sync-coupon-fields-single-product.ts).
    // resolveEffectiveLimit() inside computeCouponWrites() falls back to
    // brandLimits/categoryLimits on its own when this is undefined -- same safe
    // convention as sync-coupon-fields-single-product.ts.
    const engineProducts: ProductCouponInput[] = baseItems
        .map((item: any) => {
            const basePrice = item.price?.price ? new Decimal(item.price.price) : new Decimal(0);
            const actionPriceRaw = item.price?.actionPrice?.price;
            const attrs = feedAttrs.get(item.code);
            return {
                code: item.code as string,
                basePrice,
                actionPrice: actionPriceRaw !== null && actionPriceRaw !== undefined ? new Decimal(actionPriceRaw) : undefined,
                productMaxDiscount: undefined,
                manufacturer: attrs?.manufacturer,
                category: attrs?.category,
                allowLoyaltyDiscount: attrs?.allowLoyaltyDiscount
            };
        })
        .filter((p) => p.basePrice.greaterThan(0));
    console.log(`   ${engineProducts.length} produktů s platnou basePrice.`);

    console.log('4. Počítám očekávané kupónové zápisy pro všechny ceníky (stejná funkce jako produkce: computeCouponWrites())...');
    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();
    // expectedByCode: code -> tier -> CouponWriteItem
    const expectedByCode = new Map<string, Map<string, CouponWriteItem>>();
    for (const product of engineProducts) {
        const items = computeCouponWrites(product, loyaltyTiers, brandLimits, categoryLimits);
        const byTier = new Map<string, CouponWriteItem>();
        for (const item of items) byTier.set(item.tier, item);
        expectedByCode.set(product.code, byTier);
    }
    console.log(`   Spočítáno pro ${expectedByCode.size} produktů × ${Object.keys(ALL_PRICELISTS_MAP).length} ceníků.`);

    const state = loadState();
    const newState: ReconciliationState = {};
    const lockViolationAlerts: Alert[] = [];
    const missingAlerts: Alert[] = [];
    const escalatedMismatchAlerts: Alert[] = [];
    let totalChecked = 0;
    let totalMatched = 0;

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        console.log(`\n=== Stahuji a porovnávám ceník ${tier} (${pricelistId}) ===`);
        const tierItems = tier === 'GUEST' ? baseItems : await client.getPricelistProducts(pricelistId);
        const actualByCode = new Map<string, { discountCoupon: boolean; minPriceRatio: string } | null>();
        for (const item of tierItems) {
            if (item.sales && item.sales.discountCoupon !== undefined && item.sales.minPriceRatio !== undefined) {
                actualByCode.set(item.code, { discountCoupon: item.sales.discountCoupon, minPriceRatio: item.sales.minPriceRatio });
            } else {
                actualByCode.set(item.code, null);
            }
        }

        const isLockedTier = (LOCKED_COUPON_TIERS as readonly string[]).includes(tier);

        for (const [code, byTier] of expectedByCode) {
            const expected = byTier.get(tier);
            if (!expected) continue;
            totalChecked++;
            const key = `${code}::${tier}`;
            const actual = actualByCode.get(code);
            const expectedStr = formatCoupon(expected.applyDiscountCoupon, expected.minPriceRatio.toFixed(4));

            if (actual === undefined) {
                // Produkt zcela chybí v tomhle ceníku -- žádná legitimní příčina, okamžitý alert.
                missingAlerts.push({ code, tier, expected: expectedStr, actual: 'CHYBÍ CELÝ ZÁZNAM', kind: 'missing' });
                continue;
            }
            if (actual === null) {
                // Záznam existuje, ale nemá vůbec sales.discountCoupon/minPriceRatio (INC-011:
                // "checkbox zaškrtnutý, ale hodnota nedopočítaná" projevuje se přesně takhle).
                missingAlerts.push({ code, tier, expected: expectedStr, actual: 'ZÁZNAM BEZ sales.discountCoupon/minPriceRatio', kind: 'missing' });
                continue;
            }

            // FIRST/SIMPLEST CHECK, per Jan's explicit instruction: ZR20/ZR25 must
            // ALWAYS show discountCoupon=false (Rule 4, absolute precedence, no
            // exceptions) -- checked here as its own immediate-alert category,
            // independent of whatever computeCouponWrites() itself says (which will
            // also always say false for these tiers -- this check catches Shoptet
            // disagreeing with that, not the engine disagreeing with itself).
            if (isLockedTier && actual.discountCoupon === true) {
                lockViolationAlerts.push({
                    code, tier,
                    expected: 'discountCoupon=false (Rule 4, lockedTiers, absolutní precedence)',
                    actual: formatCoupon(actual.discountCoupon, actual.minPriceRatio),
                    kind: 'lock-violation'
                });
                continue;
            }

            const actualStr = formatCoupon(actual.discountCoupon, actual.minPriceRatio);
            const flagMatches = actual.discountCoupon === expected.applyDiscountCoupon;
            // minPriceRatio only has real (checkout-visible) meaning when the coupon is
            // actually enabled -- when discountCoupon=false on BOTH sides, checkout never
            // consults minPriceRatio at all, and live Shoptet products routinely carry a
            // stale/never-explicitly-set 0.000 there instead of the "no room" 1.0000
            // computeCouponWrites() would write. Comparing it anyway floods the alert
            // list with values that are true (field wasn't set to what the engine would
            // set) but have zero financial/checkout impact -- not the kind of drift this
            // reconciliation exists to surface. Only compare the ratio when the coupon
            // is meant to be usable (expected true) or Shoptet currently has it enabled
            // (actual true) -- either case means the ratio value is checkout-relevant.
            const ratioMatters = expected.applyDiscountCoupon || actual.discountCoupon;
            const actualRatio = parseFloat(actual.minPriceRatio);
            const expectedRatio = expected.minPriceRatio.toNumber();
            const ratioMatches = !ratioMatters || (!isNaN(actualRatio) && Math.abs(actualRatio - expectedRatio) <= RATIO_TOLERANCE);

            if (flagMatches && ratioMatches) {
                totalMatched++;
                continue; // sedí -- případný pending mismatch tím "vyřeší" a zmizí ze stavu
            }

            const prior = state[key];
            if (prior && prior.firstSeen < today) {
                escalatedMismatchAlerts.push({ code, tier, expected: expectedStr, actual: actualStr, kind: 'mismatch' });
                newState[key] = { firstSeen: prior.firstSeen, expected: expectedStr, actual: actualStr };
            } else {
                newState[key] = { firstSeen: prior?.firstSeen || today, expected: expectedStr, actual: actualStr };
            }
        }
    }

    saveState(newState);

    console.log('\n\n=========================================');
    console.log('VÝSLEDEK KUPÓNOVÉ RECONCILIACE');
    console.log('=========================================');
    console.log(`Zkontrolováno: ${totalChecked} (produkt × ceník kombinací)`);
    console.log(`Sedí: ${totalMatched}`);
    console.log(`Nově zjištěné neshody (čeká na potvrzení příští běh, zatím NEALERTOVÁNO): ${Object.keys(newState).length - escalatedMismatchAlerts.length}`);
    console.log(`ALERT -- ZR20/ZR25 lock porušen (okamžitě): ${lockViolationAlerts.length}`);
    console.log(`ALERT -- zcela chybí / bez sales polí (okamžitě): ${missingAlerts.length}`);
    console.log(`ALERT -- hodnota nesedí (přetrvává 2+ běhy): ${escalatedMismatchAlerts.length}`);

    const allAlerts = [...lockViolationAlerts, ...missingAlerts, ...escalatedMismatchAlerts];
    if (allAlerts.length > 0) {
        console.log('\n--- ALERTY ---');
        for (const a of allAlerts) {
            console.log(`Kupón měl být ${a.expected}. Shoptet má ${a.actual}. Produkt ${a.code} (ceník ${a.tier}) nebyl synchronizován. -> ALERT.`);
        }
    }

    // --- SELF-CHECK (meta-validace) ---------------------------------------
    // Stejný důvod jako reconcile-pricelist-drift.ts: "0 alertů" je
    // nerozeznatelné od "reconciliace se sama potichu rozbila a nezkontrolovala
    // skoro nic" -- přesně tvar INC-010/INC-011 (webhook nikdy neproběhl,
    // report zůstal "úspěšný", protože se nikdy nedostal do větve, co by řekla
    // "něco je špatně"). Mirror Stage 2 Guard A (MIN_EXPECTED_PRODUCTS) i
    // reconcile-pricelist-drift.ts's self-check.
    console.log('\n5. Self-check: ověřuji, že kupónová reconciliace sama proběhla smysluplně...');
    const MIN_EXPECTED_BASE_PRODUCTS = 5000;
    const EXPECTED_PRICELIST_COUNT = Object.keys(ALL_PRICELISTS_MAP).length; // 11 (10 ZR + GUEST)
    const MIN_EXPECTED_CHECKS = MIN_EXPECTED_BASE_PRODUCTS * EXPECTED_PRICELIST_COUNT;
    const selfCheckFailures: string[] = [];

    if (engineProducts.length < MIN_EXPECTED_BASE_PRODUCTS) {
        selfCheckFailures.push(`Základní/GUEST ceník vrátil jen ${engineProducts.length} produktů s platnou cenou (očekáváno alespoň ${MIN_EXPECTED_BASE_PRODUCTS}) -- feed/API pravděpodobně useknuté nebo selhala autentizace, reconciliace neproběhla na reálném katalogu.`);
    }
    if (totalChecked < MIN_EXPECTED_CHECKS) {
        selfCheckFailures.push(`Zkontrolováno jen ${totalChecked} produkt×ceník kombinací (očekáváno alespoň ${MIN_EXPECTED_CHECKS}) -- některé ceníky se pravděpodobně nestáhly vůbec.`);
    }
    if (feedAttrs.size < MIN_EXPECTED_BASE_PRODUCTS) {
        selfCheckFailures.push(`Master feed vrátil jen ${feedAttrs.size} kódů s atributy (očekáváno alespoň ${MIN_EXPECTED_BASE_PRODUCTS}) -- feed pravděpodobně useknutý, manufacturer/category stropy by se nepočítaly správně.`);
    }

    if (selfCheckFailures.length > 0) {
        console.error('\n--- SELF-CHECK SELHAL (i kdyby 0 alertů výše) ---');
        for (const f of selfCheckFailures) console.error(`  - ${f}`);
    } else {
        console.log('   Self-check OK -- kupónová reconciliace zkontrolovala plausibilní objem dat, výsledek "0 alertů" (pokud nastal) je důvěryhodný.');
    }

    console.log('\n=== KUPÓNOVÁ RECONCILIACE DOKONČENA ===');

    if (selfCheckFailures.length > 0) {
        throw new Error(`COUPON RECONCILIATION SELF-CHECK SELHAL (validace sama je podezřelá, nezávisle na ${allAlerts.length} nalezených alertech): ${selfCheckFailures.join(' | ')}`);
    }
    if (allAlerts.length > 0) {
        throw new Error(`Kupónová reconciliace našla ${allAlerts.length} neshod (${lockViolationAlerts.length}x ZR20/ZR25 lock porušen, ${missingAlerts.length}x zcela chybí, ${escalatedMismatchAlerts.length}x hodnota nesedí přes 2+ běhy). Detail výše v logu.`);
    }
}

main().catch(e => {
    console.error('CHYBA:', e);
    process.exit(1);
});
