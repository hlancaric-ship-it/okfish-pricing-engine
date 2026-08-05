// Generates a Shoptet-import-ready CSV that sets the correct flat-discount
// action price for Delphin/Delphin BOMB/Mikado products currently missing one
// entirely (confirmed live 2026-08-05, DELPHIN code 93849 and 16 others).
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

const FLAT_BRANDS: Record<string, number> = {
    DELPHIN: 15,
    'DELPHIN BOMB': 15,
    MIKADO: 9,
};

function parseNum(v: string | undefined): number | undefined {
    if (!v || v.trim() === '') return undefined;
    const n = parseFloat(v.replace(',', '.').replace(/\s/g, ''));
    return isNaN(n) ? undefined : n;
}

function round2(n: number): number {
    return Math.round(n * 100) / 100;
}

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL!;
    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`fetch failed: ${res.status}`);
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    let scanned = 0;
    let found = 0;
    const rows: string[] = ['code;pairCode;actionPrice'];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        const manufacturer = (row['manufacturer'] || '').trim().toUpperCase();
        const pct = FLAT_BRANDS[manufacturer];
        if (pct === undefined) continue;
        const price = parseNum(row['price'] || row['standardPrice']);
        const actionPrice = parseNum(row['actionPrice']);
        if (!price) continue;
        if (actionPrice === undefined) {
            found++;
            const newAction = round2(price * (1 - pct / 100));
            rows.push(`${row['code']};${row['pairCode'] || ''};${newAction}`);
        }
    }
    console.log(`Prohledáno ${scanned}, opraveno: ${found}.`);
    const outPath = path.resolve(process.cwd(), '../flat_brand_fix_action_price.csv');
    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`Uloženo: ${outPath}`);
}
main().catch(e => { console.error(e); process.exit(1); });
