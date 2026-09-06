'use strict';

// Lets the Nastavení tab read/edit the Shoptet Private API token stored in the
// repo's .env, without exposing or touching the other secrets that live in the
// same file (MASTER_FEED_URL, CF_*). Only ever reads/rewrites the one line it
// owns -- every other line in .env is preserved byte-for-byte.

const fs = require('fs');
const path = require('path');

const os = require('os');
// Packaged app can't resolve a repo-relative path (there is no repo inside
// the .app bundle) -- Pavol needs an actual git clone on disk for both
// reading policy JSON and git commit/push to work, so this points at a
// fixed clone location instead. See README_PAVOL.txt for the one-time
// git clone setup.
const REPO_ROOT = path.join(os.homedir(), 'okfish-pricing-engine');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const KEY_NAME = 'SHOPTET_PRIVATE_API_TOKEN';

// VĚDOMÉ ROZHODNUTÍ (Lucky, 2026-09-06): token je zapečený do buildu, aby Pavel
// nemusel po instalaci nic zadávat. Uživatelské nastavení (.env v jeho klonu repa)
// má ale VŽDY přednost -- zapečená hodnota je jen fallback, když .env token nemá.
// Threat model: asar JDE rozbalit, token je z instalačky čitelný. Akceptováno,
// protože jde o jediného klienta (okfish.sk) a appka není veřejně distribuovaná.
// bakedToken.js generuje scripts/bake-token.js při buildu; ve vývoji nemusí existovat.
let BAKED_TOKEN = '';
try {
    BAKED_TOKEN = require('./bakedToken').BAKED_SHOPTET_TOKEN || '';
} catch (err) {
    // Soubor neexistuje (dev bez buildu) -- fallback prostě není k dispozici.
    BAKED_TOKEN = '';
}

function readEnvLines() {
    if (!fs.existsSync(ENV_PATH)) return [];
    try {
        return fs.readFileSync(ENV_PATH, 'utf8').split('\n');
    } catch (err) {
        return [];
    }
}

// Vrací jen token z .env (bez fallbacku) -- potřeba pro rozlišení, jestli
// uživatel má vlastní hodnotu, nebo jede na zapečené.
function readEnvApiKey() {
    for (const line of readEnvLines()) {
        const trimmed = line.trim();
        if (trimmed.startsWith(`${KEY_NAME}=`)) {
            return trimmed.slice(`${KEY_NAME}=`.length).trim().replace(/^['"]|['"]$/g, '');
        }
    }
    return '';
}

// Efektivní token: uživatelské nastavení > zapečená hodnota.
function readApiKey() {
    return readEnvApiKey() || BAKED_TOKEN;
}

// Masked so the Nastavení tab can show "je nastaveno" without the raw secret
// sitting in the renderer's DOM/devtools by default -- the "Zobrazit/skrýt"
// button in the UI is a separate, explicit user action to reveal it.
function getApiKeyStatus() {
    const envKey = readEnvApiKey();
    const key = envKey || BAKED_TOKEN;
    if (!key) return { isSet: false, masked: '', source: 'none' };
    return {
        isSet: true,
        masked: key.length > 4 ? `${'•'.repeat(key.length - 4)}${key.slice(-4)}` : '••••',
        // 'env' = vlastní hodnota od uživatele, 'baked' = zapečená z buildu.
        source: envKey ? 'env' : 'baked'
    };
}

function setApiKey(newValue) {
    const value = (newValue || '').trim();
    if (!value) throw new Error('API klíč nesmí být prázdný.');

    const lines = readEnvLines();
    let replaced = false;
    const nextLines = lines.map((line) => {
        if (line.trim().startsWith(`${KEY_NAME}=`)) {
            replaced = true;
            return `${KEY_NAME}=${value}`;
        }
        return line;
    });
    if (!replaced) {
        if (nextLines.length && nextLines[nextLines.length - 1].trim() === '') nextLines.pop();
        nextLines.push(`${KEY_NAME}=${value}`);
    }
    fs.writeFileSync(ENV_PATH, nextLines.join('\n').replace(/\n*$/, '\n'), 'utf8');
}

module.exports = { getApiKeyStatus, setApiKey, readApiKey };
