// Targeted fix: clears ONLY the GUEST/top-level "Maximální povolená sleva"
// field (applyDiscountCoupon;maxDiscount, unprefixed) for the no-cap brands.
// Does NOT touch the ZR-tier pricelist columns (those are already correct).
//
// Usage: npx tsx src/cli/export-clear-guest-cap-only-csv.ts
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

const NO_CAP_BRANDS = new Set(['DELPHIN', 'DELPHIN BOMB', 'MIKADO', 'MIVARDI']);

async function main() {
    const feedUrl = process.env.MASTER_FEED_URL;
    if (!feedUrl) throw new Error('MASTER_FEED_URL not set in .env');

    const res = await fetch(feedUrl);
    if (!res.ok || !res.body) throw new Error(`Master feed fetch failed: HTTP ${res.status}`);

    const outPath = path.resolve(process.cwd(), '../clear_guest_cap_only.csv');
    const out = fs.createWriteStream(outPath);
    out.write('code;pairCode;applyDiscountCoupon;maxDiscount\n');

    const parsed = res.body.pipeThrough(new CsvParserStream());
    const reader = parsed.getReader();

    let scanned = 0;
    let matched = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const row = value as Record<string, string>;
        const code = row['code'];
        if (!code) continue;
        scanned++;

        const manufacturer = (row['manufacturer'] || '').trim().toUpperCase();
        if (!NO_CAP_BRANDS.has(manufacturer)) continue;
        matched++;
        out.write(`${code};${row['pairCode'] || ''};;\n`);
    }

    out.end();
    console.log(`Prohledáno ${scanned}, značky bez stropu: ${matched} produktů.`);
    console.log(`Soubor: ${outPath}`);
}

main().catch(e => { console.error('CHYBA:', e); process.exit(1); });
