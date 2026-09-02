'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { stringify } = require('csv-stringify/sync');

// Packaged app can't resolve a repo-relative path (there is no repo inside
// the .app bundle) -- Pavol needs an actual git clone on disk for both
// reading policy JSON and git commit/push to work, so this points at a
// fixed clone location instead. See README_PAVOL.txt for the one-time
// git clone setup.
const REPO_ROOT = path.join(os.homedir(), 'okfish-pricing-engine');
const POLICIES_DIR = path.join(REPO_ROOT, 'src', 'config', 'policies');

const FILES = {
    policy: path.join(POLICIES_DIR, 'policy-v1.json'),
    productOverrides: path.join(POLICIES_DIR, 'product-max-discount-overrides.json'),
    zeroDiscount: path.join(POLICIES_DIR, 'zero-discount-products.json'),
    clearance: path.join(POLICIES_DIR, 'clearance-sale-products.json'),
    couponPolicy: path.join(POLICIES_DIR, 'coupon-policy.json')
};

// Maps the UI "section" name (what actually got written to disk this save) to
// the one FILES key it touches -- brandLimits/categoryLimits both live inside
// policy-v1.json, everything else is 1:1. Used by commitAndPush so a save only
// ever stages/commits the file it just wrote, never the other policy files --
// see commitAndPush's own comment for why that matters.
const SECTION_TO_FILE_KEY = {
    brandLimits: 'policy',
    brandSaleDiscounts: 'policy',
    categoryLimits: 'policy',
    productOverrides: 'productOverrides',
    zeroDiscount: 'zeroDiscount',
    clearance: 'clearance',
    couponPolicy: 'couponPolicy'
};

const ALL_TIERS = ['ZR4', 'ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14', 'ZR16', 'ZR18', 'ZR20', 'ZR25'];

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function loadAll() {
    const policy = readJson(FILES.policy);
    return {
        brandLimits: policy.brandLimits || {},
        // Celoroční brandová akční cena -- zcela oddělené pravidlo od brandLimits
        // výše (maxDiscount strop). MIVARDI má typicky obě hodnoty vyplněné
        // stejným číslem, ale jsou to dvě samostatná pole v policy-v1.json, ne
        // jedno odvozené od druhého. Viz cloudflare-worker/src/engine/config.ts
        // (BRAND_SALE_DISCOUNTS) a docs/CORE_LOGIC_AND_VALIDATION.md.
        brandSaleDiscounts: policy.brandSaleDiscounts || {},
        categoryLimits: policy.categoryLimits || {},
        loyaltyTiers: policy.loyaltyTiers || {},
        productOverrides: readJson(FILES.productOverrides),
        zeroDiscount: readJson(FILES.zeroDiscount),
        clearance: readJson(FILES.clearance),
        couponPolicy: readJson(FILES.couponPolicy),
        allTiers: ALL_TIERS
    };
}

function saveBrandLimits(brandLimits) {
    const policy = readJson(FILES.policy);
    policy.brandLimits = brandLimits;
    writeJson(FILES.policy, policy);
}

function saveBrandSaleDiscounts(brandSaleDiscounts) {
    const policy = readJson(FILES.policy);
    policy.brandSaleDiscounts = brandSaleDiscounts;
    writeJson(FILES.policy, policy);
}

function saveCategoryLimits(categoryLimits) {
    const policy = readJson(FILES.policy);
    policy.categoryLimits = categoryLimits;
    writeJson(FILES.policy, policy);
}

function saveProductOverrides(overrides) {
    writeJson(FILES.productOverrides, overrides);
}

function saveZeroDiscount(codes) {
    writeJson(FILES.zeroDiscount, codes);
}

function saveClearance(clearance) {
    writeJson(FILES.clearance, clearance);
}

function saveCouponPolicy(couponPolicy) {
    writeJson(FILES.couponPolicy, couponPolicy);
}

function git(args, cwd = REPO_ROOT) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || stdout || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

// The app ships its own copy of .env (see package.json's build.files) so it
// never needs a network round-trip for it -- but .env is deliberately NOT in
// git (it holds MASTER_FEED_URL + the Shoptet API token), so a fresh
// `git clone` into REPO_ROOT never brings one along. Used to mean manually
// copying .env onto every new machine by hand; seeding it from the app's own
// bundled copy the first time it's missing closes that gap.
const BUNDLED_ENV_PATH = path.join(__dirname, '..', '.env');

// Runs once per machine, on every app startup (cheap no-op after the first
// run): used to be a separate 1_NASTAVENI_spustit_jednou.bat/.command Pavol
// had to run by hand before ever opening the app -- moved in-app because he
// kept double-clicking it from inside the still-zipped folder, where Explorer
// tears the cmd window down before the "Hotovo" pause ever showed, making it
// look broken. Now the app itself is the only thing Pavol ever has to run.
async function ensureRepoCloned(log) {
    if (!fs.existsSync(REPO_ROOT)) {
        try {
            await git(['--version'], os.homedir());
        } catch {
            throw new Error(
                'Git není nainstalovaný. Stáhni a nainstaluj ho z https://git-scm.com/download/win, ' +
                'pak appku spusť znovu.'
            );
        }

        log('Poprvé na tomto počítači — stahuji repozitář s pravidly (jednorázově)...');
        await git(['clone', 'https://github.com/hlancaric-ship-it/okfish-pricing-engine.git', REPO_ROOT], os.homedir());
        log('Repozitář stažen.');
    }

    const envPath = path.join(REPO_ROOT, '.env');
    if (!fs.existsSync(envPath)) {
        if (!fs.existsSync(BUNDLED_ENV_PATH)) {
            throw new Error(`Chybí .env a appka nemá vlastní kopii k nastavení (${envPath}).`);
        }
        log('Nastavuji .env (API klíč, adresa katalogu)...');
        fs.copyFileSync(BUNDLED_ENV_PATH, envPath);
    }

    // Nastavit git konfiguraci pro aplikaci (jednoduše a bez přepisu globálních nastavení)
    log('Nastavuji git konfiguraci aplikace...');
    await git(['config', 'user.email', 'pricing-app@okfish-engine.local']);
    await git(['config', 'user.name', 'L-Code Pricing Engine App']);
    log('Git konfigurován pro práci s pravidly.');
}

// Commits and pushes ONLY the one policy file the current save actually wrote
// (via `section` -> SECTION_TO_FILE_KEY), never the other policy files. This
// used to `git add`/commit every FILES entry regardless of section, which meant
// a stray uncommitted change sitting in some OTHER policy file (e.g. left
// behind by an earlier save whose push failed) would get silently swept up and
// pushed under a commit message that only described the section the user
// actually meant to save -- the same class of "nobody knows why this changed"
// problem the repo cleanup was about. Same hourly sync.yml GitHub Action that
// already runs picks the new rules up on its next scheduled/dispatched run, no
// separate deploy step needed.
async function commitAndPush(section, message, log) {
    const fileKey = SECTION_TO_FILE_KEY[section];
    if (!fileKey) throw new Error(`Neznámá sekce pravidel: ${section}`);
    const relFile = path.relative(REPO_ROOT, FILES[fileKey]);

    log('Kontroluji, zda je repozitář aktuální (git pull)...');
    await git(['pull', '--ff-only']);

    log(`Ukládám změnu do gitu: ${relFile}`);
    await git(['add', relFile]);

    const status = await git(['status', '--porcelain', relFile]);
    if (!status.trim()) {
        log('Žádná změna oproti poslední verzi, není co commitovat.');
        return { pushed: false };
    }

    await git(['commit', '-m', message]);
    log('Pushuji na origin/main...');
    await git(['push', 'origin', 'main']);
    log('Hotovo — změna je v repozitáři, projeví se při dalším běhu synchronizace.');
    return { pushed: true };
}

// Writes a Shoptet-import-ready CSV (code;pairCode;maxDiscount) to Downloads for
// the given section, in the exact column format already confirmed working via
// Shoptet's own Import screen (see e.g. okfish_maxdiscount_final_import.csv) --
// Pavol uploads the file himself there, the same manual-but-reliable path already
// used for products/customers elsewhere in this app, instead of a raw API PATCH
// that (per past incidents) doesn't reliably propagate into Shoptet's own feed.
function exportRuleCsv(section, data) {
    let rows;
    if (section === 'productOverrides') {
        rows = Object.entries(data).map(([code, pct]) => ({ code, pairCode: '', maxDiscount: pct }));
    } else if (section === 'zeroDiscount') {
        rows = data.map((code) => ({ code, pairCode: '', maxDiscount: 0 }));
    } else if (section === 'clearance') {
        rows = Object.entries(data).map(([code, pct]) => ({ code, pairCode: '', maxDiscount: pct }));
    } else {
        throw new Error(`Export není podporován pro sekci: ${section}`);
    }

    const csv = stringify(rows, { header: true, delimiter: ';', columns: ['code', 'pairCode', 'maxDiscount'] });
    const fileName = `okfish_${section}_export_${new Date().toISOString().slice(0, 10)}.csv`;
    const outputPath = path.join(os.homedir(), 'Downloads', fileName);
    fs.writeFileSync(outputPath, csv, 'utf8');
    return { outputPath, rowCount: rows.length };
}

module.exports = {
    loadAll,
    saveBrandLimits,
    saveBrandSaleDiscounts,
    saveCategoryLimits,
    saveProductOverrides,
    saveZeroDiscount,
    saveClearance,
    saveCouponPolicy,
    exportRuleCsv,
    commitAndPush,
    ensureRepoCloned
};
