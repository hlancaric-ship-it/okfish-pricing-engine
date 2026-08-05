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
    const url = process.env.MASTER_FEED_URL!;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fetch failed: ${res.status}`);
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    let found = 0;
    while (found < 8) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        if ((row['manufacturer'] || '').trim().toUpperCase() !== 'MIVARDI') continue;
        const price = parseFloat((row['price'] || '').replace(',', '.'));
        const actionPrice = parseFloat((row['actionPrice'] || '').replace(',', '.'));
        const stock = row['stock'] || row['availableAmount'] || row['stockAmount'] || '';
        if (!price || !actionPrice) continue;
        const discPct = (1 - actionPrice / price) * 100;
        if (discPct < 20 && discPct > 0) {
            console.log(`code=${row['code']} name=${row['name'] || ''} price=${price} actionPrice=${actionPrice} disc=${discPct.toFixed(1)}% stock=${stock}`);
            found++;
        }
    }
    if (found === 0) console.log('nic nenalezeno');
}
main().catch(e => { console.error(e); process.exit(1); });
