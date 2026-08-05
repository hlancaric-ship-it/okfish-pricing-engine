// Fast, targeted verification of the fixed pricing-bridge.ts against a
// handful of known products (not a full 1.5h catalog sync) -- ahead of
// re-enabling sync.yml. Mirrors EXACTLY what ProductsReader's FULL SYNC path
// does (getPricelistProducts -> item.price/item.sales.minPriceRatio), just
// scoped to a handful of already-verified sample codes.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { ShoptetApiClient } from '../cloudflare-worker/src/shoptet-api/client.ts';
import { calculateProductsPricing } from '../cloudflare-worker/src/shoptet-api/pricing-bridge.ts';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const SAMPLE_MANUFACTURER: Record<string, string> = {
    '39062': 'DELPHIN',
    '111139': 'LOWRANCE',
    '55867': 'MIVARDI',
    '65782': 'LOWRANCE',
    '106645': '',
    '55696': 'MIVARDI', // real -35% výprodej, must stay untouched
};
const SAMPLE_CODES = new Set(Object.keys(SAMPLE_MANUFACTURER));

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');
    const client = new ShoptetApiClient(token);

    const pricelists = await client.getPricelists();
    const basePricelist = pricelists.find(p => p.name === 'Maloobchodný') || pricelists[0];
    console.log(`Base pricelist: ${basePricelist.name} (${basePricelist.id})`);

    console.log('Stahuji základní ceník (může trvat, stránkuje se)...');
    const items = await client.getPricelistProducts(basePricelist.id);
    console.log(`Staženo ${items.length} položek, filtruji na vzorek...`);

    for (const item of items) {
        if (!SAMPLE_CODES.has(item.code)) continue;

        const basePrice = item.price?.price ? parseFloat(item.price.price) : 0;
        const actionPrice = item.price?.actionPrice?.price !== undefined && item.price?.actionPrice?.price !== null
            ? parseFloat(item.price.actionPrice.price) : undefined;
        const ratio = item.sales?.minPriceRatio;
        const productMaxDiscount = ratio !== undefined && ratio !== null ? (1 - parseFloat(ratio)) : undefined;

        console.log(`\n=== ${item.code} ===`);
        console.log(`  basePrice=${basePrice} actionPrice=${actionPrice} live minPriceRatio=${ratio} (=> old-code would've used productMaxDiscount=${productMaxDiscount})`);

        const results = calculateProductsPricing(
            [{ code: item.code, basePrice, actionPrice, productMaxDiscount, manufacturer: SAMPLE_MANUFACTURER[item.code] }],
            pricelists.map(p => ({ name: p.name, id: p.id }))
        );
        console.log('  Vypočtené ceny (fixed pricing-bridge):', JSON.stringify(results[0]?.prices, null, 2));
    }
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
