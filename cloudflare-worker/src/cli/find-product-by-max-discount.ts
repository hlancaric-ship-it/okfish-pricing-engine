// ONE-OFF lookup script: finds sample products with a specific maxDiscount % in the
// master feed, using the real CsvParserStream (handles quoted multi-line fields
// correctly, unlike naive line-splitting).
import * as fs from 'fs';
import * as path from 'path';
import { CsvParserStream } from '../csv/csv-parser';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

const TARGET = process.argv[2] || '8';

async function main() {
    const url = process.env.MASTER_FEED_URL!;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fetch failed: ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();
    let found = 0;

    while (found < 5) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const md = (row['maxDiscount'] || '').trim();
        if (md === TARGET) {
            console.log(`code=${row['code']} price=${row['price']} actionPrice=${row['actionPrice']} maxDiscount=${md}`);
            found++;
        }
    }
    if (found === 0) console.log(`Žádný produkt s maxDiscount=${TARGET} nenalezen.`);
}

main().catch(e => { console.error(e); process.exit(1); });
