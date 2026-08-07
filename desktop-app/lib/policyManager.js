'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { stringify } = require('csv-stringify/sync');

// desktop-app/ lives one level inside the repo root -- policies live at
// <repo-root>/src/config/policies/*.json, the exact same files the engine and
// the Worker both import directly (see cloudflare-worker/src/engine/config.ts).
const REPO_ROOT = path.join(__dirname, '..', '..');
const POLICIES_DIR = path.join(REPO_ROOT, 'src', 'config', 'policies');

const FILES = {
    policy: path.join(POLICIES_DIR, 'policy-v1.json'),
    productOverrides: path.join(POLICIES_DIR, 'product-max-discount-overrides.json'),
    zeroDiscount: path.join(POLICIES_DIR, 'zero-discount-products.json'),
    clearance: path.join(POLICIES_DIR, 'clearance-sale-products.json'),
    couponPolicy: path.join(POLICIES_DIR, 'coupon-policy.json')
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

function git(args) {
    return new Promise((resolve, reject) => {
        execFile('git', args, { cwd: REPO_ROOT }, (err, stdout, stderr) => {
            if (err) {
                reject(new Error(stderr || stdout || err.message));
            } else {
                resolve(stdout);
            }
        });
    });
}

// Commits every changed policy file and pushes to origin/main -- the same
// hourly sync.yml GitHub Action that already runs picks the new rules up on
// its next scheduled/dispatched run, no separate deploy step needed.
async function commitAndPush(message, log) {
    log('Kontroluji, zda je repozitář aktuální (git pull)...');
    await git(['pull', '--ff-only']);

    const relFiles = Object.values(FILES).map((f) => path.relative(REPO_ROOT, f));
    log(`Ukládám změny do gitu: ${relFiles.join(', ')}`);
    await git(['add', ...relFiles]);

    const status = await git(['status', '--porcelain', ...relFiles]);
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
    saveCategoryLimits,
    saveProductOverrides,
    saveZeroDiscount,
    saveClearance,
    saveCouponPolicy,
    exportRuleCsv,
    commitAndPush
};
