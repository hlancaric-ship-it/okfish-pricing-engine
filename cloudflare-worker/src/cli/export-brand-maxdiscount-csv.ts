// Exports a minimal CSV (code;maxDiscount) for every product of a given brand,
// ready to import back into Shoptet (Shoptet's product import only touches the
// columns present in the file — no need for a full raw-export round-trip like
// the desktop-app's xlsx tools).
//
// Usage: BRAND="VAGNER" MAX_DISCOUNT=10 npx tsx src/cli/export-brand-maxdiscount-csv.ts
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
    const brand = process.env.BRAND;
    const maxDiscount = process.env.MAX_DISCOUNT;
    if (!brand) throw new Error('BRAND env var not set (e.g. BRAND=VAGNER)');
    if (!maxDiscount) throw new Error('MAX_DISCOUNT env var not set (e.g. MAX_DISCOUNT=10)');

    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    const brandLower = brand.trim().toLowerCase();
    const rows: string[] = ['code;pairCode;maxDiscount'];
    let matched = 0;
    let scanned = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        scanned++;
        if ((row['manufacturer'] || '').trim().toLowerCase() === brandLower) {
            rows.push(`${row['code']};${row['pairCode'] || ''};${maxDiscount}`);
            matched++;
        }
    }

    console.log(`Prohledáno ${scanned} produktů, značka "${brand}": nalezeno ${matched}.`);
    if (matched === 0) {
        console.log('⚠️  Nic nenalezeno — zkontroluj přesný název značky (case-sensitive shoda je ošetřená, ale překlep ne).');
    }

    const outDir = path.resolve('./exports');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `${brand.replace(/[^a-zA-Z0-9]/g, '_')}_maxdiscount_${maxDiscount}pct.csv`);
    fs.writeFileSync(outPath, rows.join('\n'), 'utf-8');
    console.log(`Uloženo: ${outPath} (${matched} řádků)`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
