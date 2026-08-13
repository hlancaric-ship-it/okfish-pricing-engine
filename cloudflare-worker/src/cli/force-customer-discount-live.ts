// One-off: forcibly overwrites ONE customer's discount in the Worker's
// active KV version, bypassing the normal turnover-based sync entirely.
//
// WHY: used when an e-shopář manually assigns a customer a higher pricelist
// tier directly in Shoptet admin (e.g. a manual "Doplnenie bodov" turnover
// top-up whose payment hasn't cleared yet, so the automated sync's
// isCompleted check correctly excludes it) and wants the frontend discount
// badge/coupon gating to reflect that decision immediately, without waiting
// for the underlying order to actually get marked paid.
//
// This does NOT change anything in Shoptet itself — it only overwrites the
// cached discount % the Worker serves for this one customer's email hash.
// The NEXT full sync will recompute this customer from real order turnover
// again and can revert this value if the order still isn't recognized as
// paid/completed by then.
import * as fs from 'fs';
import * as path from 'path';

function loadRootEnv() {
    const envPath = path.resolve(__dirname, '../../../.env');
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
}
loadRootEnv();

async function sha256(message: string): Promise<string> {
    const crypto = await import('crypto');
    return crypto.createHash('sha256').update(message).digest('hex');
}

async function main() {
    const email = process.env.EMAIL;
    const discountStr = process.env.DISCOUNT_PCT;
    const baseUrl = process.env.CF_WORKER_URL;
    const token = process.env.CF_WORKER_TOKEN;
    // Bezpečnostní pojistka (2026-08-12): tenhle skript zapisuje natvrdo bez
    // náhledu -- na rozdíl od sourozeneckých one-off skriptů (reset-cap-*,
    // revert-brand-caps-*, set-brand-cap-live) neměl žádný dry-run default,
    // takže překlep v e-mailu nebo % slevy šel rovnou do produkce. Defaultně
    // teď jen ukáže, co by se zapsalo; ostrý zápis vyžaduje explicitní LIVE=true.
    const live = process.env.LIVE === 'true';

    if (!email) throw new Error('EMAIL not set');
    if (!discountStr) throw new Error('DISCOUNT_PCT not set');
    if (!baseUrl || !token) throw new Error('CF_WORKER_URL/CF_WORKER_TOKEN not set');

    const discount = Number(discountStr);
    const hash = await sha256(email.trim().toLowerCase());
    console.log(`E-mail: ${email}`);
    console.log(`Hash: ${hash}`);
    console.log(`Nová sleva (natvrdo): ${discount}%`);
    console.log(live ? '!!! OSTRÝ ZÁPIS (LIVE=true) !!!' : '--- DRY RUN (nic se nezapíše, spusť s LIVE=true pro ostrý zápis) ---');

    const activeRes = await fetch(`${baseUrl}/v1/import/active`, {
        headers: { Authorization: `Bearer ${token}` },
    });
    if (!activeRes.ok) throw new Error(`Nepodařilo se zjistit aktivní verzi: ${activeRes.status}`);
    const activeData: any = await activeRes.json();
    const version = activeData.version;
    if (!version) throw new Error('Worker nevrátil žádnou aktivní verzi.');
    console.log(`Aktivní verze KV: ${version}`);

    if (!live) {
        console.log(`[DRY RUN] Zapsal by se hash=${hash} discount=${discount} do verze ${version}. Nic nezapsáno.`);
        return;
    }

    const chunkRes = await fetch(`${baseUrl}/v1/import/chunk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ version, customers: [{ hash, discount }] }),
    });
    if (!chunkRes.ok) {
        const body = await chunkRes.text().catch(() => '');
        throw new Error(`Zápis selhal: ${chunkRes.status} ${body}`);
    }
    console.log('✅ Zapsáno do aktivní verze KV.');

    // Verify by reading it back through the public discount endpoint.
    const verifyRes = await fetch(`${baseUrl}/v1/discount/${hash}`, { cache: 'no-store' as any });
    const verifyBody = await verifyRes.json();
    console.log('Ověření (GET /v1/discount/:hash):', JSON.stringify(verifyBody));
}

main().catch((e) => { console.error('CHYBA:', e); process.exit(1); });
