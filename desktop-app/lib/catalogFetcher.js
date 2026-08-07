'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const REPO_ROOT = path.join(__dirname, '..', '..');

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
async function fetchCatalog(log) {
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
    return { brands, categories, products };
}

module.exports = { fetchCatalog };
