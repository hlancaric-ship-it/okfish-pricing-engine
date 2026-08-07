'use strict';

// Minimal, Node-native mirror of cloudflare-worker/src/shoptet-api/client.ts's
// customer methods -- duplicated rather than imported because the Worker code is
// TypeScript with its own build boundary and this Electron app has no TS build step.
// Only customer-group writes live here: price writes are deliberately NOT
// duplicated, because the project's own sync history found that raw API PATCH
// writes to prices/pricelists don't reliably propagate into Shoptet's own
// MASTER_FEED_URL export (the CSV-import pipeline is the only path confirmed
// live-verified for that) -- see clearance-sale-products.json section of
// project memory. Customer-group PATCH is not feed-mediated, so it's safe here.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const BASE_URL = 'https://api.myshoptet.com/api';

// Same tier -> pricelist ID mapping as cloudflare-worker/src/coupon/tier-pricelist-map.ts,
// duplicated for the same reason as that file states: separate build boundary.
const TIER_PRICELIST_MAP = {
    ZR4: 2, ZR6: 5, ZR8: 8, ZR10: 11, ZR12: 14,
    ZR14: 17, ZR16: 20, ZR18: 23, ZR20: 26, ZR25: 29
};

function readToken() {
    const envPath = path.join(REPO_ROOT, '.env');
    const content = fs.readFileSync(envPath, 'utf8');
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.startsWith('SHOPTET_PRIVATE_API_TOKEN=')) {
            return trimmed.slice('SHOPTET_PRIVATE_API_TOKEN='.length).trim().replace(/^['"]|['"]$/g, '');
        }
    }
    throw new Error('SHOPTET_PRIVATE_API_TOKEN nenalezen v .env');
}

function headers() {
    return {
        'Shoptet-Private-API-Token': readToken(),
        'Content-Type': 'application/vnd.shoptet.v1.0'
    };
}

// The LIST endpoint (GET /customers) only ever returns guid/name/dates -- no
// email, confirmed against shoptet_openapi.json's response schema (it's a
// deliberately light listing shape). Email only exists on the DETAIL endpoint
// (accounts[0].email), same field cloudflare-worker/src/shoptet-api/customer-adapter.ts
// already reads. So: name-search works off the light list; email always requires
// one extra detail fetch per candidate to actually display it.
function normalizeListItem(c) {
    return { guid: c.guid, name: c.billFullName || c.billCompany || '' };
}

function normalizeDetail(c) {
    return {
        guid: c.guid,
        name: c.billingAddress?.fullName || '',
        email: c.accounts?.[0]?.email || '',
        tier: c.customerGroup?.name || c.priceList?.name || ''
    };
}

async function getCustomerDetail(guid) {
    const res = await fetch(`${BASE_URL}/customers/${guid}`, { headers: headers() });
    const json = await res.json();
    if (json.errors && json.errors.length > 0) throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
    return normalizeDetail(json.data.customer);
}

// Server-side email filter (exact match) -- narrows to (usually) one candidate,
// then fetches its detail so the result actually has name+email+tier to show.
async function findCustomersByEmail(email) {
    const url = `${BASE_URL}/customers?email=${encodeURIComponent(email)}`;
    const res = await fetch(url, { headers: headers() });
    const json = await res.json();
    if (json.errors && json.errors.length > 0) throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
    const candidates = json.data.customers || [];
    return Promise.all(candidates.map((c) => getCustomerDetail(c.guid)));
}

// Shoptet's Private API has no name-search query param (only exact email/phone
// match) -- so "search by name" means loading the full (light) customer list once
// and filtering locally, same pattern as catalogFetcher.js uses for products/brands.
async function fetchAllCustomersIndex(log) {
    const itemsPerPage = 1000;
    let page = 1;
    let totalPages = 1;
    const customers = [];
    do {
        const url = `${BASE_URL}/customers?page=${page}&itemsPerPage=${itemsPerPage}`;
        const res = await fetch(url, { headers: headers() });
        const json = await res.json();
        if (json.errors && json.errors.length > 0) throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
        for (const c of json.data.customers || []) customers.push(normalizeListItem(c));
        totalPages = json.data.paginator?.pageCount || 1;
        if (log && (page === 1 || page % 10 === 0 || page === totalPages)) {
            log(`...načteno ${customers.length} zákazníků (stránka ${page}/${totalPages})`);
        }
        page++;
    } while (page <= totalPages);
    return customers;
}

async function setCustomerTier(guid, tier) {
    const pricelistId = TIER_PRICELIST_MAP[tier];
    if (!pricelistId) throw new Error(`Neznámý tier: ${tier}`);
    const url = `${BASE_URL}/customers/${guid}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ data: { pricelistId, customerGroupCode: tier } })
    });
    const json = await res.json();
    if (json.errors && json.errors.length > 0) throw new Error(`API chyba při zápisu: ${JSON.stringify(json.errors)}`);
    return { ok: true, status: res.status };
}

// "Nedostupné"/"Momentálne nedostupné" (system availabilities, id -2/-3) is
// Shoptet's own mechanism for "product page stays visible, but the add-to-cart
// button disappears" -- not a visibility/hide flag, which would remove the
// product from the site entirely. Pavol picks from the live list rather than a
// hardcoded id, since custom (non-system) availabilities also exist (see id 2/5
// above) and could change.
async function getAvailabilities() {
    const res = await fetch(`${BASE_URL}/products/availabilities`, { headers: headers() });
    const json = await res.json();
    if (json.errors && json.errors.length > 0) throw new Error(`API chyba: ${JSON.stringify(json.errors)}`);
    return json.data.availabilities || [];
}

async function setProductAvailability(code, availabilityId) {
    const url = `${BASE_URL}/products/code/${encodeURIComponent(code)}`;
    const res = await fetch(url, {
        method: 'PATCH',
        headers: headers(),
        body: JSON.stringify({ data: { variants: [{ code, availabilityId }] } })
    });
    const json = await res.json();
    if (json.errors && json.errors.length > 0) throw new Error(`API chyba při zápisu dostupnosti: ${JSON.stringify(json.errors)}`);
    return { ok: true, status: res.status };
}

module.exports = {
    findCustomersByEmail, fetchAllCustomersIndex, getCustomerDetail, setCustomerTier, TIER_PRICELIST_MAP,
    getAvailabilities, setProductAvailability
};
