// Finds products where actionPrice is set but equal to (or above) the
// standard price -- a no-op "action" that wrongly blocks tier/cap pricing
// (confirmed live 2026-08-05, LOWRANCE code 111139).
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

function parseNum(v: string | undefined): number | undefined {
    if (!v || v.trim() === '') return undefined;
    const n = parseFloat(v.replace(',', '.').replace(/\s/g, ''));
    return isNaN(n) ? undefined : n;
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL!;
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`fetch failed: ${res.status}`);
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    let scanned = 0;
    let found = 0;
    const rows: string[] = ['code;name;manufacturer;price;actionPrice'];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        const price = parseNum(row['price'] || row['standardPrice']);
        const actionPrice = parseNum(row['actionPrice']);
        if (price === undefined || actionPrice === undefined) continue;
        if (actionPrice >= price) {
            found++;
            rows.push(`${row['code']};${row['name'] || ''};${row['manufacturer'] || ''};${price};${actionPrice}`);
        }
    }
    console.log(`Prohledáno ${scanned}, nalezeno ${found} produktů s "prázdnou" akční cenou.`);
    const outPath = path.resolve(process.cwd(), '../noop_action_prices.csv');
    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`Uloženo: ${outPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
