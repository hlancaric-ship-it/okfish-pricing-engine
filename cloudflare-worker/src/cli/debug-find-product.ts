// One-off: dump raw feed rows matching a name substring, to inspect exact field values.
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';

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
    const needle = (process.env.NEEDLE || '').toLowerCase();
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set');
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`fetch failed ${res.status}`);
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    let found = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        if ((row['name'] || '').toLowerCase().includes(needle)) {
            found++;
            console.log(JSON.stringify({
                code: row['code'], name: row['name'], manufacturer: row['manufacturer'],
                categoryText: row['categoryText'], price: row['price'], standardPrice: row['standardPrice'],
                actionPrice: row['actionPrice'], maxDiscount: row['maxDiscount'],
                applyDiscountCoupon: row['applyDiscountCoupon'], applyLoyaltyDiscount: row['applyLoyaltyDiscount']
            }));
            if (found >= 15) break;
        }
    }
    console.log(`Nalezeno (max 15 vypsáno): ${found}`);
}
main().catch(e => { console.error(e); process.exit(1); });
