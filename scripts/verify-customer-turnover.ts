import { ShoptetApiClient } from '../cloudflare-worker/src/shoptet-api/client.ts';
import Decimal from 'decimal.js';
import * as dotenv from 'dotenv';
dotenv.config();

const client = new ShoptetApiClient(process.env.SHOPTET_PRIVATE_API_TOKEN || '');

const testCustomers = [
    { guid: '88036423-a6d1-49f5-90f0-ab25abae4274', name: 'Monika Kováčová', expected: 12617.69 },
    { guid: '7fc03434-56b9-4710-a0af-18d751ed1c80', name: 'Radoslav Chodelka', expected: 38.56 },
    { guid: 'a7db86f6-1cef-4b33-bffe-56a0ea7c96c1', name: 'Juraj Koník', expected: 55335.12 },
    { guid: 'd031675a-c9d5-464b-928c-a1958c6488a6', name: 'Tomáš Birčák', expected: 28713.16 }
];

async function verify() {
    console.log('Spouštím verifikaci konkrétních zákazníků proti Shoptet API...\n');

    for (const testCase of testCustomers) {
        // Vyfiltrovat objednávky zákazníka z API
        const customerOrders = await client.getCustomerOrders(testCase.guid);
        
        let sumAPI = new Decimal(0);
        let completedCount = 0;
        let cancelledCount = 0;

        for (const order of customerOrders) {
            const isCompleted = order.status.id === -3 || order.paid;
            const isCancelled = order.status.id === -4;

            if (isCancelled) {
                cancelledCount++;
            } else if (isCompleted) {
                completedCount++;
                sumAPI = sumAPI.plus(new Decimal(order.price.withVat));
            }
        }

        const match = sumAPI.toNumber() === testCase.expected;
        const color = match ? '\x1b[32m' : '\x1b[31m';
        const reset = '\x1b[0m';
        console.log(`\nZákazník: ${testCase.name} (${testCase.guid})`);
        console.log(`Objednávek celkem v API: ${customerOrders.length}`);
        console.log(`- Dokončených: ${completedCount}`);
        console.log(`- Stornovaných: ${cancelledCount}`);
        console.log(`Očekávaný obrat z exportu: ${testCase.expected}`);
        console.log(`${color}Vypočtený obrat z API:   ${sumAPI.toNumber()}${reset}`);
        console.log(`Shoda: ${match ? 'ANO' : 'NE'}`);
    }
}

verify().catch(console.error);
