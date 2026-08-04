// One-off: dumps raw status/paid fields for a customer's orders, filtered by
// order number if given. Used to check whether a manually created order
// (e.g. an admin "Doplnenie bodov ZR" turnover top-up) will actually be
// counted by CustomerAdapter's isCompleted check (status.id === -3 || paid).
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

async function main() {
    const email = process.env.EMAIL;
    const orderNumberFilter = process.env.ORDER_NUMBER;
    const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
    if (!token) throw new Error('SHOPTET_PRIVATE_API_TOKEN not set');

    const client: any = new ShoptetApiClient(token);
    let orders: any[] = [];

    // Prefer looking the order up directly by its code (avoids relying on
    // which email is currently the customer's "primary" one in Shoptet —
    // relevant here since this customer's two emails were recently merged).
    if (orderNumberFilter) {
        console.log(`Hledám objednávku přímo podle čísla: ${orderNumberFilter}...`);
        const res = await (client as any).fetchPaginated(`/orders?code=${encodeURIComponent(orderNumberFilter)}`, 'orders', 100);
        orders = res;
        if (orders.length === 0) {
            console.error('Objednávka podle čísla nenalezena, zkouším přes e-mail...');
        }
    }

    if (orders.length === 0) {
        if (!email) throw new Error('EMAIL not set and order lookup by code found nothing');
        console.log(`Hledám zákazníka podle e-mailu: ${email}...`);
        const customers = await client.getCustomers();
        const match = customers.find((c: any) => c.email?.toLowerCase() === email.toLowerCase());
        if (!match) {
            console.error('Zákazník nenalezen ani podle e-mailu (pravděpodobně kvůli sloučení dvou e-mailů — primární e-mail v Shoptetu je teď jiný).');
            process.exit(1);
        }
        const guid = (match as any).guid;
        console.log(`Nalezen guid: ${guid}, jméno: ${(match as any).fullName ?? '?'}`);
        orders = await client.getCustomerOrders(guid);
    }

    console.log(`Celkem objednávek: ${orders.length}\n`);

    for (const order of orders as any[]) {
        if (orderNumberFilter && String(order.code ?? order.number ?? order.id) !== orderNumberFilter) continue;
        const isCompleted = order.status?.id === -3 || order.paid;
        const isCancelled = order.status?.id === -4;
        console.log(JSON.stringify({
            code: order.code,
            id: order.id,
            statusId: order.status?.id,
            statusName: order.status?.name,
            paid: order.paid,
            priceWithVat: order.price?.withVat,
            isCompleted,
            isCancelled,
            countsTowardTurnover: isCompleted && !isCancelled,
        }, null, 2));
    }
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
