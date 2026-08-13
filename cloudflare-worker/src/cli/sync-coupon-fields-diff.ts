// DIFF-AWARE coupon fields sync. Computes fresh CouponPolicy output for every
// product/tier, compares it against the last-known-written state (persisted in
// coupon-state.json), and writes ONLY the items that actually changed.
//
// This is the script the twice-daily cron runs unattended — it therefore includes
// three safety nets that a one-off manual script wouldn't need:
//   1. A minimum-scanned-products sanity check (catches a broken/truncated feed).
//   2. A circuit breaker refusing to live-write if the diff is implausibly large
//      (catches a feed format/mapping problem that produces plausible-looking but
//      wrong numbers across the catalog) — override with --force.
//   3. A live validation of TIER_PRICELIST_MAP/GUEST_PRICELIST_ID against
//      GET /api/pricelists before writing anything, so a renamed/recreated pricelist
//      in Shoptet admin gets caught loudly instead of silently writing to the wrong
//      ceník.
//
// Usage:
//   npx tsx src/cli/sync-coupon-fields-diff.ts               (dry run — computes diff, writes nothing)
//   npx tsx src/cli/sync-coupon-fields-diff.ts --live         (live write, updates coupon-state.json)
//   npx tsx src/cli/sync-coupon-fields-diff.ts --live --force (bypass the diff-size circuit breaker)
import * as fs from 'fs';
import * as path from 'path';
import Decimal from 'decimal.js';
import { CsvParserStream } from '../csv/csv-parser';
import { computeCouponWrites, CouponWriteItem } from '../coupon/compute-coupon-writes';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';
import { ShoptetApiClient } from '../shoptet-api/client';
import { CouponSalesWriter } from '../coupon/coupon-sales-writer';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const isLive = process.argv.includes('--live');
const isForced = process.argv.includes('--force');
const STATE_PATH = path.resolve(__dirname, '../../coupon-state.json');

// Below this many scanned products, treat the feed as broken/truncated rather than
// a genuinely tiny catalog — the real catalog has ~16-17k products.
const MIN_EXPECTED_PRODUCTS = 5000;
// Refuse to auto-write if more than this fraction of ALL possible items (scanned
// products x 11 pricelists) changed in one run — a real business change (a
// storewide sale ending, a coupon campaign starting) is expected to move a
// meaningful slice of the catalog, but not blow past this without a human looking.
const MAX_CHANGE_RATIO = 0.30;

// Compact per-item state: c = applyDiscountCoupon, r = minPriceRatio (4dp string).
type ItemState = { c: boolean; r: string };
type FullState = Record<string, Record<string, ItemState>>; // code -> tier -> state

function loadState(): FullState {
    if (!fs.existsSync(STATE_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
    } catch {
        console.warn('[STATE] coupon-state.json se nepodařilo načíst, začínám od prázdného stavu.');
        return {};
    }
}

function parseNumber(val: string | undefined): Decimal | undefined {
    if (!val || val.trim() === '') return undefined;
    const normalized = val.replace(',', '.').replace(/\s/g, '');
    const n = new Decimal(normalized);
    return n.isNaN() ? undefined : n;
}

// Same convention as engine/pricing.ts's resolveAllowLoyaltyDiscount(): absent
// defaults to allowed, only an explicit falsy-looking value turns it off.
function resolveAllowLoyaltyDiscount(row: Record<string, string>): boolean {
    const val = row['applyLoyaltyDiscount'];
    return val === '1' || val === 'true' || val === 'yes' || val === undefined;
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

/**
 * Confirms TIER_PRICELIST_MAP/GUEST_PRICELIST_ID (hardcoded, one-time-verified
 * constants) still point to the pricelists they think they do, by checking their
 * names via a live GET /api/pricelists call. Throws loudly rather than silently
 * writing coupon rules to a renamed/recreated/reassigned pricelist.
 */
async function validatePricelistMap(client: ShoptetApiClient): Promise<void> {
    const live = await client.getPricelists();
    const liveById = new Map(live.map(p => [p.id, p.name]));

    const expectedNames: Record<string, string> = {
        ZR4: 'ZR4', ZR6: 'ZR6', ZR8: 'ZR8', ZR10: 'ZR10', ZR12: 'ZR12',
        ZR14: 'ZR14', ZR16: 'ZR16', ZR18: 'ZR18', ZR20: 'ZR20', ZR25: 'ZR25',
        GUEST: 'Hlavný cenník'
    };

    const mismatches: string[] = [];
    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const liveName = liveById.get(pricelistId);
        const expected = expectedNames[tier];
        if (liveName === undefined) {
            mismatches.push(`${tier}: pricelist ID ${pricelistId} už na Shoptetu neexistuje`);
        } else if (liveName !== expected) {
            mismatches.push(`${tier}: pricelist ID ${pricelistId} se teď jmenuje "${liveName}", čekali jsme "${expected}"`);
        }
    }

    if (mismatches.length > 0) {
        throw new Error(
            `Validace ceníkové mapy selhala — TIER_PRICELIST_MAP v tier-pricelist-map.ts neodpovídá skutečnému stavu na Shoptetu:\n` +
            mismatches.map(m => `  - ${m}`).join('\n') +
            `\nOprav tier-pricelist-map.ts a spusť znovu. Žádný zápis neproběhl.`
        );
    }
    console.log('[VALIDACE] Ceníková mapa (TIER_PRICELIST_MAP) souhlasí se skutečným stavem na Shoptetu.');
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    console.log(`=== COUPON FIELDS DIFF SYNC (${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'}) ===`);

    // Construct the client (fails fast on missing token) but deliberately DON'T call
    // validatePricelistMap() yet — that's a real Shoptet API request, and on a "0
    // changes" run (the common case, twice a day) there's nothing to protect: no
    // write is going to happen anyway. Validation runs later, only once we know
    // there's actually something to write, keeping no-op runs down to zero Shoptet
    // API calls (the feed fetch itself is a public CDN export, not the Private API).
    let client: ShoptetApiClient | null = null;
    if (isLive) {
        const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
        if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
        client = new ShoptetApiClient(token);
    }

    const state = loadState();
    const stateProductCount = Object.keys(state).length;
    console.log(`Načten předchozí stav: ${stateProductCount} produktů (${stateProductCount === 0 ? 'první běh' : 'inkrementální'}).`);

    const { loyaltyTiers, brandLimits, categoryLimits } = loadPolicyConfig();

    console.log('Fetching master feed...');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    // Group only the CHANGED items by tier, ready to batch-write per pricelist.
    const byTier: Record<string, CouponWriteItem[]> = {};
    for (const tier of Object.keys(ALL_PRICELISTS_MAP)) byTier[tier] = [];

    let scanned = 0;
    let changedCount = 0;
    const newState: FullState = {};

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code) continue;

        const basePrice = parseNumber(row['price'] || row['standardPrice']);
        if (!basePrice || basePrice.lessThanOrEqualTo(0)) continue;

        const actionPrice = parseNumber(row['actionPrice']);
        // Fixed 2026-08-13 (INC-011): this used to read the feed's `maxDiscount`
        // column as productMaxDiscount, unlike every other coupon write/reconcile
        // script (sync-coupon-fields-live.ts, sync-coupon-fields-single-product.ts,
        // reconcile-coupon-drift.ts). That column is GUEST's own coupon-room field
        // (self-referential -- same circular-dependency bug documented in
        // coupon-sales-writer.ts, fixed there 2026-08-06 but never mirrored here).
        // resolveEffectiveLimit() falls back to brandLimits/categoryLimits on its
        // own when this is undefined.
        const productMaxDiscount = undefined;
        const manufacturer = row['manufacturer'] || undefined;
        const category = row['categoryText'] || undefined;
        const allowLoyaltyDiscount = resolveAllowLoyaltyDiscount(row);

        scanned++;
        const items = computeCouponWrites(
            { code, basePrice, actionPrice, productMaxDiscount, manufacturer, category, allowLoyaltyDiscount },
            loyaltyTiers, brandLimits, categoryLimits
        );

        const prevForCode = state[code] || {};
        const newForCode: Record<string, ItemState> = {};

        for (const item of items) {
            const newVal: ItemState = { c: item.applyDiscountCoupon, r: item.minPriceRatio.toFixed(4) };
            newForCode[item.tier] = newVal;

            const prevVal = prevForCode[item.tier];
            const changed = !prevVal || prevVal.c !== newVal.c || prevVal.r !== newVal.r;
            if (changed) {
                changedCount++;
                byTier[item.tier].push(item);
            }
        }
        newState[code] = newForCode;

        if (scanned % 4000 === 0) console.log(`...prohledáno ${scanned} produktů, zatím ${changedCount} změn`);
    }

    console.log(`\nProhledáno ${scanned} produktů. Změn oproti poslednímu stavu: ${changedCount}.`);

    // Safety net #1: a broken/truncated feed still parses SOME valid-looking rows,
    // but far fewer than the real catalog — refuse to treat that as "nothing to do"
    // silently, and refuse to write on top of a partial scan.
    if (scanned < MIN_EXPECTED_PRODUCTS) {
        throw new Error(
            `Prohledáno jen ${scanned} produktů (očekáváno alespoň ${MIN_EXPECTED_PRODUCTS}) — feed je pravděpodobně useknutý nebo rozbitý. ` +
            `Žádný zápis neproběhl, coupon-state.json nebyl změněn.`
        );
    }

    if (changedCount === 0) {
        console.log('Žádné změny — nic k zápisu.');
        return;
    }

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        if (byTier[tier].length > 0) {
            console.log(`  ${tier} (pricelist ${pricelistId}): ${byTier[tier].length} změn`);
        }
    }

    // Safety net #2: refuse an implausibly large diff without an explicit --force.
    const totalPossibleItems = scanned * Object.keys(ALL_PRICELISTS_MAP).length;
    const changeRatio = changedCount / totalPossibleItems;
    if (isLive && changeRatio > MAX_CHANGE_RATIO && !isForced) {
        throw new Error(
            `Změna se týká ${(changeRatio * 100).toFixed(1)} % všech položek (${changedCount}/${totalPossibleItems}), ` +
            `což překračuje pojistku ${(MAX_CHANGE_RATIO * 100).toFixed(0)} %. To může znamenat problém s feedem, ne skutečnou ` +
            `obchodní změnu. Žádný zápis neproběhl. Pokud je to opravdu v pořádku, spusť znovu s --force.`
        );
    }

    if (!isLive) {
        console.log('\nDRY RUN — žádný zápis neproběhl, coupon-state.json nebyl aktualizován.');
        return;
    }

    // Only now — right before the first real write — spend the one extra Shoptet API
    // request to validate the pricelist mapping. Every check above this point was
    // free (local feed math), so a run that ends up with nothing to write costs the
    // Shoptet API nothing at all.
    await validatePricelistMap(client!);

    const writer = new CouponSalesWriter(client!, { dryRun: false });

    let failedAny = false;
    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const items = byTier[tier];
        if (items.length === 0) continue;
        console.log(`--- Zapisuji tier ${tier} (pricelist ${pricelistId}): ${items.length} změn ---`);
        const stats = await writer.processTierBatch(pricelistId, tier, items);
        console.log(`Hotovo: zpracováno=${stats.processed} selhalo=${stats.failed}`);
        if (stats.failed > 0) failedAny = true;
    }

    // Only persist the new state if nothing failed — a partial/failed run should be
    // retried in full next time, not silently treated as "already written". Also
    // never shrink tracked coverage: merge into the previous state rather than
    // replacing it outright, so a run that (for whatever reason) only scanned part
    // of the feed can't cause already-tracked products to silently drop out of state.
    if (!failedAny) {
        const mergedState: FullState = { ...state, ...newState };
        fs.writeFileSync(STATE_PATH, JSON.stringify(mergedState), 'utf-8');
        console.log(`\n[STATE] coupon-state.json aktualizován (${Object.keys(mergedState).length} produktů celkem, ${Object.keys(newState).length} z tohoto běhu).`);
    } else {
        console.log('\n[STATE] Některé zápisy selhaly — coupon-state.json NEBYL aktualizován, příští běh zopakuje i tyhle položky.');
    }

    console.log('=== HOTOVO ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
