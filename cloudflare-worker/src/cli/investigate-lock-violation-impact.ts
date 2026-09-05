// READ-ONLY forenzní nástroj: zjišťuje reálný finanční dopad 41 SKU, u kterých
// reconcile-coupon-drift.ts (běh 2026-08-27) nahlásil ZR20/ZR25 LOCK_VIOLATION
// (discountCoupon=true na zamčeném tieru, přestože Rule 4 má absolutní precedenci
// a kupón by tam měl být vždy false). Cílem je zjistit, jestli si na tyto SKU
// reálně objednal produkt zákazník na ZR20/ZR25 v období, kdy byl zámek porušen
// (od prvního zjištěného zápisu 2026-07-31), a pokud ano, jaký je rozdíl mezi
// zaplacenou a "správnou" (bez kupónu) cenou.
//
// Nezapisuje nic do Shoptetu ani KV/R2 -- pouze GET requesty.
import * as fs from 'fs';
import * as path from 'path';
import { ShoptetApiClient } from '../shoptet-api/client';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

// Extrahováno z coupon_run_33082060642.log (běh 2026-08-27) -- 41 unikátních SKU
// se ZR20/ZR25 lock violation (80 řádků, protože se často opakují na obou tierech).
const AFFECTED_SKUS = [
    '110006', '110011', '114046', '31186', '39374', '39375', '39376', '41792',
    '46445', '46446', '46447', '46449', '46451', '46965', '59723', '64580',
    '65805', '66764', '77667', '77826', '77854', '77865', '88246', '88764',
    '89283', '89284', '89285', '89286', '89287', '89288', '89289', '89290',
    '89291', '89292', '89293', '89294', '89295', '89296',
];

const LOCKED_PRICELIST_IDS = new Set([26, 29]); // ZR20, ZR25
const SINCE = '2026-07-31T00:00:00Z'; // datum prvního zjištěného problémového zápisu

interface OrderItem {
    code?: string;
    itemType?: string;
    name?: string;
    amount?: string | number;
    priceRatio?: string;
    unitPrice?: { withVat?: string };
    totalPrice?: { withVat?: string };
}

async function fetchOrderDetail(client: any, code: string): Promise<any | null> {
    const url = `https://api.myshoptet.com/api/orders/${encodeURIComponent(code)}`;
    const res = await fetch(url, {
        headers: {
            'Shoptet-Private-API-Token': process.env.SHOPTET_PRIVATE_API_TOKEN!,
            'Content-Type': 'application/vnd.shoptet.v1.0',
        },
    });
    if (!res.ok) {
        console.warn(`[WARN] GET /orders/${code} selhal: HTTP ${res.status}`);
        return null;
    }
    const json = await res.json() as any;
    return json.data ?? null;
}

async function main() {
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');

    const client: any = new ShoptetApiClient(token);

    console.log(`Stahuji objednávky změněné od ${SINCE}...`);
    const orders = await client.getOrdersByChangeTime(SINCE);
    console.log(`Nalezeno ${orders.length} objednávek ke kontrole.\n`);

    console.log('Stahuji zákazníky (pro zjištění tieru)...');
    const customers = await client.getCustomers();
    const customerByGuid = new Map<string, any>();
    for (const c of customers as any[]) customerByGuid.set(c.guid, c);
    console.log(`Načteno ${customers.length} zákazníků.\n`);

    const skuSet = new Set(AFFECTED_SKUS);
    const findings: any[] = [];
    let checked = 0;

    for (const order of orders as any[]) {
        checked++;
        if (checked % 50 === 0) console.log(`...zkontrolováno ${checked}/${orders.length} objednávek`);

        const detail = await fetchOrderDetail(client, order.code);
        if (!detail) continue;

        const items: OrderItem[] = detail.items ?? [];
        const matchedItems = items.filter(i => i.code && skuSet.has(String(i.code)));
        if (matchedItems.length === 0) continue;

        const customerGuid = detail.customerGuid ?? order.customerGuid;
        const customer = customerGuid ? customerByGuid.get(customerGuid) : null;
        const pricelistId = customer?.priceList?.id;
        const isLockedTier = pricelistId != null && LOCKED_PRICELIST_IDS.has(pricelistId);

        if (!isLockedTier) continue; // Zajímají nás jen objednávky ZR20/ZR25 zákazníků

        for (const item of matchedItems) {
            findings.push({
                orderCode: order.code,
                changeTime: order.changeTime,
                customerGuid,
                customerGroup: customer?.customerGroup?.name,
                pricelistId,
                pricelistName: customer?.priceList?.name,
                sku: item.code,
                itemName: item.name,
                amount: item.amount,
                unitPriceWithVat: item.unitPrice?.withVat,
                totalPriceWithVat: item.totalPrice?.withVat,
            });
        }
    }

    console.log('\n=========================================');
    console.log('VÝSLEDEK FORENZNÍ ANALÝZY DOPADU');
    console.log('=========================================');
    console.log(`Zkontrolováno objednávek: ${checked}`);
    console.log(`Nalezeno postižených položek (SKU ze seznamu, zákazník na ZR20/ZR25): ${findings.length}\n`);

    if (findings.length === 0) {
        console.log('ŽÁDNÝ potvrzený dopad na reálné objednávky nenalezen v tomto období.');
    } else {
        for (const f of findings) {
            console.log(JSON.stringify(f, null, 2));
        }
        const totalValue = findings.reduce((sum, f) => sum + (parseFloat(f.totalPriceWithVat) || 0), 0);
        console.log(`\nCelková hodnota postižených položek (s VAT): ${totalValue.toFixed(2)} Kč`);
        console.log('POZOR: toto je hrubá hodnota položek, ne přímo výše neoprávněné slevy --');
        console.log('pro přesný rozdíl je potřeba znát unitPrice s a bez kupónu, což tento script nepočítá.');
    }

    fs.writeFileSync(
        path.resolve(__dirname, '../../../lock-violation-impact-findings.json'),
        JSON.stringify(findings, null, 2),
        'utf-8'
    );
    console.log('\nDetailní výstup uložen do lock-violation-impact-findings.json');
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
