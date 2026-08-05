// Joins a code;pairCode;maxDiscount CSV (e.g. the confirmed brand-cap import
// file) against the feed's manufacturer field, to derive manufacturer->cap%
// without retyping brand names by hand.
// Usage: LOCAL_CSV_CONTENT env var or read from stdin? Simplify: paste path via arg.
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
    const dataPath = path.resolve(__dirname, 'data/maxdiscount-by-code.json');
    const raw = JSON.parse(fs.readFileSync(dataPath, 'utf-8')) as Record<string, string>;
    const codeToValue = new Map<string, string>(Object.entries(raw));
    console.log(`Načteno ${codeToValue.size} kódů s hodnotou z uloženého souboru.`);

    const url = process.env.MASTER_FEED_URL!;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`fetch failed: ${res.status}`);
    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const byBrand = new Map<string, Map<string, number>>();
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        const val = codeToValue.get(code);
        if (!val) continue;
        const brand = (row['manufacturer'] || '').trim();
        if (!brand) continue;
        if (!byBrand.has(brand)) byBrand.set(brand, new Map());
        const counts = byBrand.get(brand)!;
        counts.set(val, (counts.get(val) || 0) + 1);
    }

    const rows: string[] = [];
    for (const [brand, counts] of byBrand.entries()) {
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
        rows.push(`${brand}\t${sorted.map(([v, c]) => `${v}%(${c})`).join(', ')}`);
    }
    rows.sort();
    console.log(rows.join('\n'));
}
main().catch(e => { console.error(e); process.exit(1); });
