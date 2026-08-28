import * as dotenv from 'dotenv';
dotenv.config();
import { ShoptetApiClient } from '../cloudflare-worker/src/shoptet-api/client';

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN is missing');

    const client = new ShoptetApiClient(token);
    const pricelists = await client.getPricelists();
    console.log(`Nalezeno ${pricelists.length} ceníků.`);

    // 1. Nejprve stáhneme správnou DPH pro všechny produkty ze základního ceníku (ID 1)
    console.log('\nStahuji základní ceník (ID 1) pro načtení správných sazeb DPH...');
    const baseItems = await client.fetchPaginated('/pricelists/1', 'pricelist', 100);
    console.log(`Základní ceník načten: ${baseItems.length} položek.`);

    const vatMap = new Map<string, { vatRate: string, includingVat: boolean }>();
    for (const b of baseItems as any[]) {
        vatMap.set(b.code, {
            vatRate: b.vatRate || '23.00',
            includingVat: b.includingVat !== undefined ? b.includingVat : true
        });
    }

    const vipPricelists = pricelists.filter(p => p.id !== 1); // Vše kromě základního
    let totalFixed = 0;

    for (const pl of vipPricelists) {
        console.log(`\nKontroluji ceník ${pl.name} (ID: ${pl.id})...`);
        const items = await client.fetchPaginated(`/pricelists/${pl.id}`, 'pricelist', 100);
        console.log(`  Načteno ${items.length} položek.`);

        const toFix = (items as any[]).filter(item => item.vatRate === '0.00' || item.includingVat === false);
        console.log(`  Nalezeno ${toFix.length} položek s nesprávnou DPH (0.00% / includingVat: false).`);

        if (toFix.length === 0) continue;

        const chunkSize = 100;
        for (let i = 0; i < toFix.length; i += chunkSize) {
            const chunk = toFix.slice(i, i + chunkSize);
            const payload = chunk.map(item => {
                const baseInfo = vatMap.get(item.code) || { vatRate: '23.00', includingVat: true };
                return {
                    code: item.code,
                    price: item.price.price,
                    actionPrice: item.price.actionPrice?.price || undefined,
                    includingVat: baseInfo.includingVat,
                    vatRate: baseInfo.vatRate
                };
            });

            await client.updatePricelistBatch(pl.id, payload);
            totalFixed += chunk.length;
            console.log(`  [OPRAVA] Zapsána dávka ${Math.floor(i / chunkSize) + 1} (${chunk.length} ks) pro ceník ${pl.name}.`);
        }
    }

    console.log(`\n=== HOTOVO: Celkem opraveno ${totalFixed} položek napříč všemi ceníky. ===\n`);
}

main().catch(err => {
    console.error('Chyba při opravě DPH:', err);
    process.exit(1);
});
