// FULL BACKUP of every pricelist's sales fields (minPriceRatio + discountCoupon)
// for every product, across all 11 pricelists (10 ZR tiers + GUEST).
//
// Run this BEFORE any change to automation/policy so there is always a known-good
// rollback point. Output: timestamped JSON in ./.snapshots, one entry per
// pricelist with { code -> { minPriceRatio, discountCoupon } }.
//
// Usage: npx tsx src/cli/backup-all-pricelists.ts
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set in .env');
    const client = new ShoptetApiClient(token);

    const snapshot: Record<string, Record<string, { minPriceRatio: string; discountCoupon: boolean }>> = {};
    let totalProducts = 0;

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        console.log(`Stahuji ceník ${tier} (pricelist ${pricelistId})...`);
        const items = await client.getPricelistItems(pricelistId);
        const byCode: Record<string, { minPriceRatio: string; discountCoupon: boolean }> = {};
        for (const item of items) {
            byCode[item.code] = {
                minPriceRatio: Number(item.sales.minPriceRatio).toFixed(4),
                discountCoupon: item.sales.discountCoupon,
            };
        }
        snapshot[tier] = byCode;
        totalProducts = Math.max(totalProducts, items.length);
        console.log(`  -> ${items.length} produktů`);
    }

    const snapshotDir = path.resolve('./.snapshots');
    if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });
    const snapshotPath = path.join(snapshotDir, `full_backup_${Date.now()}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify({ createdAt: new Date().toISOString(), pricelists: ALL_PRICELISTS_MAP, snapshot }, null, 2), 'utf-8');

    console.log(`\n=== HOTOVO ===`);
    console.log(`Zálohováno ${Object.keys(ALL_PRICELISTS_MAP).length} ceníků, max ${totalProducts} produktů na ceník.`);
    console.log(`Soubor: ${snapshotPath}`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
