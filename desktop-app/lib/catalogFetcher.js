'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const os = require('os');
// Packaged app can't resolve a repo-relative path (there is no repo inside
// the .app bundle) -- Pavol needs an actual git clone on disk for both
// reading policy JSON and git commit/push to work, so this points at a
// fixed clone location instead. See README_PAVOL.txt for the one-time
// git clone setup.
const REPO_ROOT = path.join(os.homedir(), 'okfish-pricing-engine');

// The master feed is a ~58MB CSV (confirmed live: 57.8MB, ~20s over a normal
// connection) -- fetching it fresh on every app start AND on every switch to
// the Pravidla tab (see renderer.js's ensureRulesLoaded) is what made the app
// "feel like everything takes forever to load". Shoptet regenerates the feed
// on its own schedule, not instantly on every product change (see the
// "feed lag" lesson elsewhere in this codebase's sync jobs), so serving a
// locally-cached copy for a few minutes is never meaningfully stale -- it's
// bounded by the same lag the live feed already has. 10 minutes matches half
// of the main engine's 15-minute sync cadence (sync.yml), so the catalog here
// is never more than one sync cycle behind what the engine itself just wrote.
const CACHE_PATH = path.join(__dirname, '..', '.catalog-cache.json');
const CACHE_TTL_MS = 10 * 60 * 1000;

function readCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
        if (Date.now() - raw.fetchedAt < CACHE_TTL_MS) return raw.data;
    } catch {
        // No cache yet, or unreadable/corrupt -- fall through to a fresh fetch.
    }
    return null;
}

function writeCache(data) {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify({ fetchedAt: Date.now(), data }), 'utf8');
    } catch {
        // Cache write failing (e.g. read-only disk) must never break the actual
        // catalog load -- it only means the next call re-fetches, same as today.
    }
}

function readMasterFeedUrl() {
    const envPath = path.join(REPO_ROOT, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('MASTER_FEED_URL=')) {
            return trimmed.slice('MASTER_FEED_URL='.length).trim().replace(/^['"]|['"]$/g, '');
        }
    }
    throw new Error('MASTER_FEED_URL nenalezen v .env');
}

// Pulls the same master feed the pricing engine itself reads, so "všechny značky
// co má na eshopu" always matches what the engine actually sees -- no separate,
// potentially stale, brand list to maintain.
async function fetchCatalog(log, forceRefresh = false) {
    if (!forceRefresh) {
        const cached = readCache();
        if (cached) {
            if (log) log(`Katalog načten z mezipaměti (${cached.products.length} produktů, max. 10 min staré).`);
            return cached;
        }
    }

    const url = readMasterFeedUrl();
    if (log) log('Stahuji aktuální katalog produktů (pro seznam značek a produktů)...');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Feed fetch selhal: HTTP ${res.status}`);
    const text = await res.text();

    const rows = parse(text, {
        delimiter: ';',
        columns: true,
        skip_empty_lines: true,
        relax_column_count: true,
        bom: true
    });

    const brandsSet = new Set();
    const categoriesSet = new Set();
    const products = [];
    for (const row of rows) {
        const code = row.code;
        const name = row.name;
        const brand = row.manufacturer;
        const category = row.defaultCategory;
        if (brand) brandsSet.add(brand.trim());
        if (category) categoriesSet.add(category.trim());
        if (code && name) {
            products.push({
                code: code.trim(),
                name: name.trim(),
                brand: (brand || '').trim(),
                category: (category || '').trim(),
                // Used by the Dashboard's discount-€/margin totals -- Shoptet's own feed
                // already computes these (see purchasePrice/standardPrice columns), no
                // separate lookup needed.
                standardPrice: parseFloat((row.standardPrice || row.price || '0').replace(',', '.')) || 0,
                purchasePrice: parseFloat((row.purchasePrice || '0').replace(',', '.')) || 0
            });
        }
    }

    const brands = Array.from(brandsSet).filter(Boolean).sort((a, b) => a.localeCompare(b, 'sk'));
    const categories = Array.from(categoriesSet).filter(Boolean).sort((a, b) => a.localeCompare(b, 'sk'));
    if (log) log(`Katalog načten: ${brands.length} značek, ${categories.length} kategorií, ${products.length} produktů.`);
    const result = { brands, categories, products };
    writeCache(result);
    return result;
}

module.exports = { fetchCatalog };
