// Mirrors ZR4's coupon-eligibility fields (discountCoupon/minPriceRatio) onto
// pricelist 1 (GUEST/"Hlavný cenník") for every product where they differ.
//
// WHY: coupon-sales-writer.ts (the automated 2x/day cron) hard-refuses to write
// to GUEST_PRICELIST_ID, on purpose — that field doubles as the product's real
// "Maximální povolená sleva" cap, and an earlier incident (BUG #3, see
// INCIDENTS.md) corrupted that cap catalog-wide when the cron wrote to it
// automatically. That protection stays in place.
//
// But this left GUEST's coupon-eligibility fields sitting at whatever they were
// before our system ever existed (often wide open — minPriceRatio "0.000",
// i.e. NO floor) — and per confirmed live testing (2026-08-04), the storefront
// appears to gate coupon eligibility off THIS record regardless of the actual
// logged-in customer's own tier, which was letting coupons apply on products
// (and to customers) that should have been blocked.
//
// This script is a manually-triggered ONE-OFF (never run by a cron), following
// the same direct-API pattern Shoptet support confirmed is correct
// (PATCH /pricelists/{id}/batch, minPriceRatio). It only copies ZR4's ALREADY
// CORRECTLY COMPUTED values onto GUEST — it does not invent new logic, so
// whatever CouponPolicy already decided for ZR4 (the lowest/0% loyalty tier,
// closest analogue to an anonymous guest) becomes GUEST's value too.
//
// Usage:
//   npx tsx src/cli/sync-guest-coupon-cap-live.ts            (dry run — reports how many differ)
//   npx tsx src/cli/sync-guest-coupon-cap-live.ts --live      (live write)
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';
import { GUEST_PRICELIST_ID, TIER_PRICELIST_MAP } from '../coupon/tier-pricelist-map';

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
const ZR4_PRICELIST_ID = TIER_PRICELIST_MAP['ZR4'];

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
    const client = new ShoptetApiClient(token);

    console.log(`Načítám ZR4 (pricelist ${ZR4_PRICELIST_ID}) a GUEST (pricelist ${GUEST_PRICELIST_ID})...`);
    const [zr4Items, guestItems] = await Promise.all([
        client.getPricelistItems(ZR4_PRICELIST_ID),
        client.getPricelistItems(GUEST_PRICELIST_ID),
    ]);

    const guestByCode = new Map(guestItems.map(i => [i.code, i]));

    const toWrite: Array<{ code: string; discountCoupon: boolean; minPriceRatio: string }> = [];
    for (const zr4 of zr4Items) {
        const guest = guestByCode.get(zr4.code);
        if (!guest) continue; // product not present on GUEST pricelist — skip, don't invent
        const zr4Ratio = zr4.sales.minPriceRatio;
        const zr4Coupon = zr4.sales.discountCoupon;
        if (guest.sales.minPriceRatio !== zr4Ratio || guest.sales.discountCoupon !== zr4Coupon) {
            toWrite.push({ code: zr4.code, discountCoupon: zr4Coupon, minPriceRatio: zr4Ratio });
        }
    }

    console.log(`Prohledáno ${zr4Items.length} produktů na ZR4. Liší se od GUEST: ${toWrite.length}.`);

    if (!isLive) {
        console.log('DRY RUN — žádný zápis neproběhl. Spusť s --live pro ostrý zápis.');
        console.log('Prvních 10 kódů:', toWrite.slice(0, 10).map(i => `${i.code}(coupon=${i.discountCoupon},ratio=${i.minPriceRatio})`).join(', '));
        return;
    }

    if (toWrite.length === 0) {
        console.log('Nic k zápisu.');
        return;
    }

    const snapshotDir = path.resolve('./.snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `guest_coupon_cap_rollback_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify({
        before: toWrite.map(i => ({ code: i.code, sales: guestByCode.get(i.code)?.sales })),
    }, null, 2), 'utf-8');
    console.log(`[SNAPSHOT] Uložen stav pro rollback: ${snapshotPath}`);

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];
    const BATCH_SIZE = 100;

    for (let i = 0; i < toWrite.length; i += BATCH_SIZE) {
        const batch = toWrite.slice(i, i + BATCH_SIZE);
        try {
            await client.updatePricelistSalesBatch(GUEST_PRICELIST_ID, batch);
            processed += batch.length;
        } catch (err: any) {
            failed += batch.length;
            errors.push(`batch ${i}-${i + batch.length}: ${err.message}`);
        }
        console.log(`...zpracováno ${processed + failed}/${toWrite.length} (chyby: ${failed})`);
    }

    console.log(`\n=== HOTOVO === Zpracováno: ${processed}, Selhalo: ${failed}`);
    if (errors.length > 0) {
        console.log('Chyby:');
        errors.forEach(e => console.log('  ' + e));
    }
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
