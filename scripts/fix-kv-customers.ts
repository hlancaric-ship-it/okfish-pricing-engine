import { RemoteCustomerCache } from '../cloudflare-worker/src/shoptet-api/customer-cache';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
    const csv = fs.readFileSync('exports/customers_import.csv', 'utf-8');
    const lines = csv.split('\n');
    
    const cache = new RemoteCustomerCache(
        process.env.CF_WORKER_URL!,
        process.env.CF_WORKER_TOKEN!
    );
    
    let count = 0;
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        const parts = line.split(';');
        const email = parts[22]; // email is at index 22
        const pricelist = parts[25]; // WAIT, let me check the headers
        // Let's use string manipulation or a proper parser.
        // Or just regex for ZR
        if (email && email.includes('@')) {
            const match = line.match(/ZR(\d+)/i);
            const discount = match ? parseInt(match[1], 10) : 0;
            if (discount >= 0) {
                 await cache.setCustomerDiscount(email, discount);
                 count++;
            }
        }
    }
    
    console.log(`Odesílám ${count} zákazníků do KV...`);
    await cache.commit('dummy', false);
    console.log('Hotovo');
}
main().catch(console.error);
