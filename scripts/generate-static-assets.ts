// Bundles the frontend JS files (vip_*.js, root of repo) into a single generated
// TS module the Cloudflare Worker can serve directly over HTTP. Lets a new client
// onboard by pasting ONE <script src="https://<worker>.workers.dev/static/vip_prices.js">
// tag into Shoptet's header snippet (Vzhled a obsah -- no FTP account, no manual file
// upload, ever needed). The root vip_*.js files stay the single source of truth --
// this script regenerates cloudflare-worker/src/static-assets.ts from them; run it
// (npm run build:static-assets) whenever a vip_*.js file changes, before deploying.
//
// Uses JSON.stringify() to embed each file's content as a TS string constant --
// safe against the backticks/${} template-literal syntax the frontend files
// themselves contain (a raw template literal would need manual escaping and be a
// silent-corruption risk on every edit).
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const OUTPUT_PATH = path.join(REPO_ROOT, 'cloudflare-worker', 'src', 'static-assets.ts');

const ASSETS: { file: string; exportName: string }[] = [
    { file: 'vip_prices.js', exportName: 'VIP_PRICES_JS' },
    { file: 'vip_detail.js', exportName: 'VIP_DETAIL_JS' },
    { file: 'vip_cart.js', exportName: 'VIP_CART_JS' },
    { file: 'vip_catalog.js', exportName: 'VIP_CATALOG_JS' },
    { file: 'vip_cart_coupon_lock.js', exportName: 'VIP_CART_COUPON_LOCK_JS' },
    { file: 'vip_registration_hide_types.js', exportName: 'VIP_REGISTRATION_HIDE_TYPES_JS' },
];

function main() {
    const lines: string[] = [
        '// GENERATED FILE -- do not edit by hand.',
        '// Source of truth: the vip_*.js files at the repo root.',
        '// Regenerate with: npm run build:static-assets (scripts/generate-static-assets.ts)',
        '',
    ];

    for (const { file, exportName } of ASSETS) {
        const filePath = path.join(REPO_ROOT, file);
        const content = fs.readFileSync(filePath, 'utf-8');
        lines.push(`export const ${exportName} = ${JSON.stringify(content)};`, '');
    }

    fs.writeFileSync(OUTPUT_PATH, lines.join('\n'), 'utf-8');
    console.log(`Generated ${path.relative(REPO_ROOT, OUTPUT_PATH)} from ${ASSETS.length} source file(s).`);
}

main();
