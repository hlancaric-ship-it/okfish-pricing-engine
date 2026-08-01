// DIFF-AWARE coupon fields sync. Computes fresh CouponPolicy output for every
// product/tier, compares it against the last-known-written state (persisted in
// coupon-state.json), and writes ONLY the items that actually changed.
//
// Usage:
//   npx tsx src/cli/sync-coupon-fields-diff.ts            (dry run — computes diff, writes nothing)
//   npx tsx src/cli/sync-coupon-fields-diff.ts --live     (live write, updates coupon-state.json)
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
const STATE_PATH = path.resolve(__dirname, '../../coupon-state.json');

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

function loadLoyaltyTierRatios(): Record<string, Decimal> {
    const policyPath = path.resolve(__dirname, '../../../src/config/policies/policy-v1.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf-8'));
    const ratios: Record<string, Decimal> = {};
    for (const [tier, ratio] of Object.entries(policy.loyaltyTiers as Record<string, number>)) {
        ratios[tier] = new Decimal(ratio);
    }
    return ratios;
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    console.log(`=== COUPON FIELDS DIFF SYNC (${isLive ? 'ŽIVÝ ZÁPIS' : 'DRY RUN'}) ===`);

    const state = loadState();
    const stateProductCount = Object.keys(state).length;
    console.log(`Načten předchozí stav: ${stateProductCount} produktů (${stateProductCount === 0 ? 'první běh' : 'inkrementální'}).`);

    const loyaltyTiers = loadLoyaltyTierRatios();

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
        const maxDiscountPct = parseNumber(row['maxDiscount']);
        const productMaxDiscount = maxDiscountPct !== undefined ? maxDiscountPct.dividedBy(100) : undefined;

        scanned++;
        const items = computeCouponWrites({ code, basePrice, actionPrice, productMaxDiscount }, loyaltyTiers);

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

    if (changedCount === 0) {
        console.log('Žádné změny — nic k zápisu.');
        return;
    }

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        if (byTier[tier].length > 0) {
            console.log(`  ${tier} (pricelist ${pricelistId}): ${byTier[tier].length} změn`);
        }
    }

    if (!isLive) {
        console.log('\nDRY RUN — žádný zápis neproběhl, coupon-state.json nebyl aktualizován.');
        return;
    }

    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
    const client = new ShoptetApiClient(token);
    const writer = new CouponSalesWriter(client, { dryRun: false });

    let failedAny = false;
    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        const items = byTier[tier];
        if (items.length === 0) continue;
        console.log(`--- Zapisuji tier ${tier} (pricelist ${pricelistId}): ${items.length} položek ---`);
        const stats = await writer.processTierBatch(pricelistId, tier, items);
        console.log(`Hotovo: zpracováno=${stats.processed} selhalo=${stats.failed}`);
        if (stats.failed > 0) failedAny = true;
    }

    // Only persist the new state if nothing failed — a partial/failed run should be
    // retried in full next time, not silently treated as "already written".
    if (!failedAny) {
        fs.writeFileSync(STATE_PATH, JSON.stringify(newState), 'utf-8');
        console.log(`\n[STATE] coupon-state.json aktualizován (${Object.keys(newState).length} produktů).`);
    } else {
        console.log('\n[STATE] Některé zápisy selhaly — coupon-state.json NEBYL aktualizován, příští běh zopakuje i tyhle položky.');
    }

    console.log('=== HOTOVO ===');
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
