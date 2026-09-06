#!/usr/bin/env node
'use strict';

// Build-time generátor lib/bakedToken.js.
//
// VĚDOMÉ ROZHODNUTÍ (Lucky, 2026-09-06): Shoptet Private API token se zapéká
// natvrdo do buildu, aby Pavel nemusel token nikam ručně zadávat a appka
// fungovala hned po instalaci. Pavel má jediný e-shop (okfish.sk) a appka
// není veřejně distribuovaná -- jde jen k němu.
//
// POZOR na threat model: asar archiv v .app/.exe JDE bez problémů rozbalit
// (`npx asar extract`), takže token je pro kohokoli s přístupem k instalačce
// čitelný. To je akceptované riziko dané výše uvedeným kontextem. Pokud se
// appka bude někdy distribuovat šířeji, tohle MUSÍ pryč a token se musí
// vydávat per-instalace ze serveru.
//
// Token se čte z .env v kořeni repa v době buildu; hodnota se nikdy necommituje
// (lib/bakedToken.js je v .gitignore).

const fs = require('fs');
const path = require('path');

const KEY_NAME = 'SHOPTET_PRIVATE_API_TOKEN';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_PATH = path.join(__dirname, '..', 'lib', 'bakedToken.js');

function readTokenFromEnv(envPath) {
    if (!fs.existsSync(envPath)) return '';
    let content;
    try {
        content = fs.readFileSync(envPath, 'utf8');
    } catch (err) {
        console.warn(`[bake-token] nelze číst ${envPath}: ${err.message}`);
        return '';
    }
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${KEY_NAME}=`)) {
            return trimmed.slice(`${KEY_NAME}=`.length).trim().replace(/^['"]|['"]$/g, '');
        }
    }
    return '';
}

// Priorita: kořen repa, pak desktop-app/.env jako fallback.
const candidates = [
    path.join(REPO_ROOT, '.env'),
    path.join(__dirname, '..', '.env')
];

let token = '';
let source = '';
for (const candidate of candidates) {
    token = readTokenFromEnv(candidate);
    if (token) {
        source = candidate;
        break;
    }
}

if (!token) {
    console.error(`[bake-token] CHYBA: ${KEY_NAME} nenalezen v žádném z: ${candidates.join(', ')}`);
    console.error('[bake-token] Build by vyrobil appku bez zapečeného tokenu -- končím.');
    process.exit(1);
}

const generated = `'use strict';

// !!! AUTOMATICKY GENEROVANÝ SOUBOR -- NEEDITOVAT RUČNĚ !!!
// Vyrábí ho scripts/bake-token.js při každém buildu (npm run prebuild:*).
// Tento soubor je v .gitignore a NIKDY se nesmí commitnout.
//
// VĚDOMÉ ROZHODNUTÍ (Lucky, 2026-09-06): token je zapečený natvrdo, aby appka
// fungovala bez ručního zadávání. Asar JDE rozbalit -- token je čitelný pro
// kohokoli, kdo má instalačku. Akceptované riziko: jeden klient (Pavel,
// okfish.sk), neveřejná distribuce.

module.exports = {
    BAKED_SHOPTET_TOKEN: ${JSON.stringify(token)}
};
`;

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, generated, 'utf8');
console.log(`[bake-token] zapečeno z ${source} -> lib/bakedToken.js (délka tokenu: ${token.length})`);
