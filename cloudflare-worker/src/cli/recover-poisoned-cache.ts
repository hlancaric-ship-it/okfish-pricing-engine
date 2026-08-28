import { ShoptetApiClient } from '../shoptet-api/client.js';
import { ALL_PRICELISTS_MAP } from '../coupon/tier-pricelist-map.js';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    const cfUrl = process.env.CF_WORKER_URL;
    const cfToken = process.env.CF_WORKER_TOKEN;

    if (!token || !cfUrl || !cfToken) throw new Error("Missing env vars");

    const client = new ShoptetApiClient(token);

    let totalRecovered = 0;

    for (const [tier, pricelistId] of Object.entries(ALL_PRICELISTS_MAP)) {
        if (tier === 'GUEST') continue; // GUEST is base, not cached the same way. Wait, we cache it too? Yes, but mostly ZR tiers.
        
        console.log(`\n=== Kontrola kontaminace cache pro ${tier} (${pricelistId}) ===`);
        
        // 1. Fetch remote cache
        const cacheRes = await fetch(`${cfUrl}/v1/price-cache/${pricelistId}`, {
            headers: { 'Authorization': `Bearer ${cfToken}` }
        });
        if (!cacheRes.ok) throw new Error(`Cache fetch failed: ${cacheRes.status}`);
        const cacheData = (await cacheRes.json()) as any;
        const cachedPrices = cacheData.prices || {};
        const cachedCodes = Object.keys(cachedPrices);
        console.log(`V cache pro ${tier} je ${cachedCodes.length} záznamů.`);

        // 2. Fetch Shoptet actual
        const actualItems = await client.getPricelistProducts(pricelistId);
        const actualCodes = new Set(actualItems.map((i: any) => i.code));
        console.log(`Na Shoptetu pro ${tier} je ${actualCodes.size} záznamů.`);

        // 3. Diff
        const poisonedCodes = cachedCodes.filter(c => !actualCodes.has(c));
        console.log(`Nalezeno ${poisonedCodes.length} otrávených záznamů (v cache, ale chybí na Shoptetu).`);

        if (poisonedCodes.length > 0) {
            const updates: Record<string, string> = {};
            for (const c of poisonedCodes) {
                updates[c] = ""; // Invalidates the cache entry
            }
            
            console.log(`[WRITE] Invaliduji ${poisonedCodes.length} záznamů v cache pro ${tier}...`);
            const updateRes = await fetch(`${cfUrl}/v1/price-cache/${pricelistId}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${cfToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ updates })
            });
            
            if (!updateRes.ok) throw new Error(`Cache update failed: ${updateRes.status}`);
            console.log(`Invalidace úspěšná pro ${tier}.`);
            totalRecovered += poisonedCodes.length;
        }
    }
    
    console.log(`\nCelkem invalidováno otrávených záznamů: ${totalRecovered}`);
}

main().catch(console.error);
