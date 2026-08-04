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
    if (!email) throw new Error('EMAIL not set');

    const client = new ShoptetApiClient(token);

    // Find the customer's guid via the customers list (paginated fetch, filter by email)
    console.log(`Hledám zákazníka podle e-mailu: ${email}...`);
    let guid: string | undefined;
    const customers = await client.getCustomers();
    const match = customers.find((c: any) => c.email?.toLowerCase() === email.toLowerCase());
    if (!match) {
        console.error('Zákazník nenalezen podle e-mailu.');
        process.exit(1);
    }
    guid = (match as any).guid;
    console.log(`Nalezen guid: ${guid}, jméno: ${(match as any).fullName ?? '?'}`);

    const orders = await client.getCustomerOrders(guid!);
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
