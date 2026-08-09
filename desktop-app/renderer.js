'use strict';

// Compact single-line status strip -- shows only the latest message, right-aligned
// next to the "AKTIVITA" label, instead of a scrolling history block.
const logEl = document.getElementById('log');
const splashStatusEl = document.getElementById('splashStatus');
window.api.onLog((line) => {
    logEl.textContent = line;
    // Same log stream doubles as the splash screen's live status text while
    // the window is still small/pre-ready (see startUpSequence below) -- once
    // splashScreen is hidden this element no longer exists to update.
    if (splashStatusEl) splashStatusEl.textContent = line.replace(/^\[\d{1,2}:\d{2}:\d{2}\]\s*/, '');
});

// Sidebar logo intro: draw segment 1, then segment 2, then flash, then hand off to
// the continuous 3D spin + shine loop (CSS class "spinning") and fade in the wordmark.
(function animateLogoIntro() {
    const seg1 = document.getElementById('logoSeg1');
    const seg2 = document.getElementById('logoSeg2');
    const flash = document.getElementById('logoFlash');
    const spin = document.getElementById('logoSpin');
    const glow = document.getElementById('logoGlow');
    const brandText = document.getElementById('logoBrandText');
    if (!seg1 || !seg2) return;

    [seg1, seg2].forEach((seg) => {
        const len = seg.getTotalLength();
        seg.style.strokeDasharray = String(len);
        seg.style.strokeDashoffset = String(len);
        seg.style.transition = 'stroke-dashoffset 0.55s cubic-bezier(0.22, 1, 0.36, 1)';
    });

    requestAnimationFrame(() => {
        setTimeout(() => { seg1.style.strokeDashoffset = '0'; }, 150);
        setTimeout(() => { seg2.style.strokeDashoffset = '0'; }, 650);
        setTimeout(() => { flash.classList.add('flash'); }, 1150);
        setTimeout(() => {
            spin.classList.add('spinning');
            glow.classList.add('spinning');
            brandText.classList.add('visible');
        }, 1350);
    });
})();

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    });
});

// Pravidla's submenu jumps straight to a rule section instead of making Pavol
// scroll through the whole (long) page to find e.g. "Kupóny".
document.querySelectorAll('.subtab').forEach((sub) => {
    sub.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        document.querySelector('.tab[data-tab="rules"]').classList.add('active');
        document.getElementById('panel-rules').classList.add('active');
        document.getElementById(sub.dataset.scrollTo)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
});

// --- Produkty ---
let productPath = null;
document.getElementById('pickProductFile').addEventListener('click', async () => {
    const path = await window.api.pickFile([{ name: 'Excel', extensions: ['xlsx'] }]);
    if (path) {
        productPath = path;
        document.getElementById('productPath').value = path;
        document.getElementById('runProducts').disabled = false;
    }
});

document.getElementById('runProducts').addEventListener('click', async () => {
    const btn = document.getElementById('runProducts');
    const resultEl = document.getElementById('productResult');
    const syncWorker = document.getElementById('productSyncWorker').checked;
    btn.disabled = true;
    resultEl.innerHTML = '';
    document.getElementById('openProductOutput').style.display = 'none';

    const result = await window.api.processProducts(productPath, syncWorker);

    btn.disabled = false;
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = `Hotovo — ${result.rowCount} produktů, ${result.changedCells} přepočtených buněk.`;
        const openBtn = document.getElementById('openProductOutput');
        openBtn.style.display = '';
        openBtn.onclick = () => window.api.revealFile(result.outputPath);
    } else {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
    }
});

// --- Zákazníci ---
let customerPath = null;
document.getElementById('pickCustomerFile').addEventListener('click', async () => {
    const path = await window.api.pickFile([{ name: 'CSV', extensions: ['csv'] }]);
    if (path) {
        customerPath = path;
        document.getElementById('customerPath').value = path;
        document.getElementById('runCustomers').disabled = false;
    }
});

// --- Pravidla ---
let policies = null; // { brandLimits, categoryLimits, productOverrides, zeroDiscount: [...], clearance }
let catalog = { brands: [], products: [] };
let productByCode = new Map();
// In-flight fetch, shared by every call site that needs the catalog loaded --
// on startup, renderDashboard() and ensureRulesLoaded() both used to check
// "is catalog empty?" and each independently kick off window.api.loadCatalog(),
// firing the master-feed fetch twice concurrently (confirmed live: duplicate
// "Stahuji aktuální katalog produktů" log lines on every launch). Memoizing the
// promise here means every caller awaits the SAME in-flight fetch instead of
// starting a new one.
let catalogLoadPromise = null;

function productLabel(code) {
    const p = productByCode.get(code);
    return p ? p.name : '(neznámý produkt, katalog ještě nenačten)';
}

// A single validator used everywhere a % gets typed in, so "0", "100" and
// out-of-range or non-numeric junk are all rejected the same way instead of
// each add/edit handler silently accepting garbage.
function validPercent(raw) {
    const n = Number(String(raw).trim().replace(',', '.'));
    if (Number.isNaN(n) || n < 0 || n > 100) return null;
    return n;
}

function renderBrandLimitsTable() {
    const tbody = document.querySelector('#table-brandLimits tbody');
    tbody.innerHTML = '';
    Object.entries(policies.brandLimits).sort(([a], [b]) => a.localeCompare(b, 'sk')).forEach(([brand, ratio]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${brand}</td>
            <td><input type="text" data-key="${brand}" class="edit-brandLimits pct-input" value="${Math.round(ratio * 100)}"></td>
            <td class="col-remove"><button data-key="${brand}" class="remove-brandLimits">✕</button></td>`;
        tbody.appendChild(tr);
    });

    // dropdown of brands not yet configured
    const select = document.getElementById('new-brandLimits-key');
    select.innerHTML = '<option value="">Vyber značku…</option>';
    catalog.brands.filter((b) => !(b in policies.brandLimits)).forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        select.appendChild(opt);
    });
}

function renderCategoryLimitsTable() {
    const tbody = document.querySelector('#table-categoryLimits tbody');
    tbody.innerHTML = '';
    Object.entries(policies.categoryLimits).sort(([a], [b]) => a.localeCompare(b, 'sk')).forEach(([cat, ratio]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${cat}</td>
            <td><input type="text" data-key="${cat}" class="edit-categoryLimits pct-input" value="${Math.round(ratio * 100)}"></td>
            <td class="col-remove"><button data-key="${cat}" class="remove-categoryLimits">✕</button></td>`;
        tbody.appendChild(tr);
    });

    const select = document.getElementById('new-categoryLimits-key');
    select.innerHTML = '<option value="">Vyber kategorii…</option>';
    (catalog.categories || []).filter((c) => !(c in policies.categoryLimits)).forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c;
        opt.textContent = c;
        select.appendChild(opt);
    });
}

function renderProductOverridesTable() {
    const tbody = document.querySelector('#table-productOverrides tbody');
    tbody.innerHTML = '';
    Object.entries(policies.productOverrides).forEach(([code, pct]) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${code}</td>
            <td>${productLabel(code)}</td>
            <td><input type="text" data-key="${code}" class="edit-productOverrides pct-input" value="${pct}"></td>
            <td class="col-remove"><button data-key="${code}" class="remove-productOverrides">✕</button></td>`;
        tbody.appendChild(tr);
    });
}

function renderZeroDiscountTable() {
    const tbody = document.querySelector('#table-zeroDiscount tbody');
    tbody.innerHTML = '';
    policies.zeroDiscount.forEach((code) => {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${code}</td>
            <td>${productLabel(code)}</td>
            <td class="col-remove"><button data-key="${code}" class="remove-zeroDiscount">✕</button></td>`;
        tbody.appendChild(tr);
    });
}

// clearance-sale-products.json entries can be a plain number (pct, no date limit)
// or { pct, validFrom?, validTo? } -- these helpers read/write both shapes so the
// table doesn't care which one a given product currently has.
function clearancePct(entry) { return typeof entry === 'number' ? entry : entry.pct; }
function clearanceDates(entry) {
    return typeof entry === 'number' ? { validFrom: '', validTo: '' } : { validFrom: entry.validFrom || '', validTo: entry.validTo || '' };
}
function makeClearanceEntry(pct, validFrom, validTo) {
    if (!validFrom && !validTo) return pct;
    const entry = { pct };
    if (validFrom) entry.validFrom = validFrom;
    if (validTo) entry.validTo = validTo;
    return entry;
}

function renderClearanceTable() {
    const tbody = document.querySelector('#table-clearance tbody');
    tbody.innerHTML = '';
    Object.entries(policies.clearance).forEach(([code, entry]) => {
        const { validFrom, validTo } = clearanceDates(entry);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${code}</td>
            <td>${productLabel(code)}</td>
            <td><input type="text" data-key="${code}" class="edit-clearance-pct pct-input" value="${clearancePct(entry)}"></td>
            <td><input type="date" data-key="${code}" class="edit-clearance-from" value="${validFrom}"></td>
            <td><input type="date" data-key="${code}" class="edit-clearance-to" value="${validTo}"></td>
            <td class="col-remove"><button data-key="${code}" class="remove-clearance">✕</button></td>`;
        tbody.appendChild(tr);
    });
}

// coupon-policy.json's disabledBrands/disabledProducts entries can be a plain
// string (disabled indefinitely) or { value, validFrom?, validTo? } -- same
// pattern as clearance's date-window entries above.
function disabledValue(entry) { return typeof entry === 'string' ? entry : entry.value; }
function disabledDates(entry) {
    return typeof entry === 'string' ? { validFrom: '', validTo: '' } : { validFrom: entry.validFrom || '', validTo: entry.validTo || '' };
}
function makeDisabledEntry(value, validFrom, validTo) {
    if (!validFrom && !validTo) return value;
    const entry = { value };
    if (validFrom) entry.validFrom = validFrom;
    if (validTo) entry.validTo = validTo;
    return entry;
}

function renderCouponPolicy() {
    document.getElementById('coupon-defaultMaxDiscount').value = policies.couponPolicy.defaultMaxDiscount;

    const tiersRow = document.getElementById('coupon-lockedTiers-row');
    tiersRow.innerHTML = '';
    (policies.allTiers || []).forEach((tier) => {
        const id = `coupon-lockedTier-${tier}`;
        const wrap = document.createElement('label');
        wrap.className = 'checkbox';
        wrap.innerHTML = `<input type="checkbox" id="${id}" data-tier="${tier}" ${policies.couponPolicy.lockedTiers.includes(tier) ? 'checked' : ''}> ${tier}`;
        tiersRow.appendChild(wrap);
    });

    const tbodyBrands = document.querySelector('#table-coupon-disabledBrands tbody');
    tbodyBrands.innerHTML = '';
    policies.couponPolicy.disabledBrands.forEach((entry, idx) => {
        const brand = disabledValue(entry);
        const { validFrom, validTo } = disabledDates(entry);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${brand}</td>
            <td>${validFrom || '—'}</td>
            <td>${validTo || '—'}</td>
            <td class="col-remove"><button data-idx="${idx}" class="remove-coupon-disabledBrands">✕</button></td>`;
        tbodyBrands.appendChild(tr);
    });
    const disabledBrandNames = policies.couponPolicy.disabledBrands.map(disabledValue);
    const brandSelect = document.getElementById('new-coupon-disabledBrands');
    brandSelect.innerHTML = '<option value="">Vyber značku…</option>';
    catalog.brands.filter((b) => !disabledBrandNames.includes(b)).forEach((b) => {
        const opt = document.createElement('option');
        opt.value = b;
        opt.textContent = b;
        brandSelect.appendChild(opt);
    });

    const tbodyProducts = document.querySelector('#table-coupon-disabledProducts tbody');
    tbodyProducts.innerHTML = '';
    policies.couponPolicy.disabledProducts.forEach((entry, idx) => {
        const code = disabledValue(entry);
        const { validFrom, validTo } = disabledDates(entry);
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${code}</td>
            <td>${productLabel(code)}</td>
            <td>${validFrom || '—'}</td>
            <td>${validTo || '—'}</td>
            <td class="col-remove"><button data-idx="${idx}" class="remove-coupon-disabledProducts">✕</button></td>`;
        tbodyProducts.appendChild(tr);
    });
}

function renderAllRuleTables() {
    renderBrandLimitsTable();
    renderCategoryLimitsTable();
    renderProductOverridesTable();
    renderZeroDiscountTable();
    renderClearanceTable();
    renderCouponPolicy();
}

function renderProductDatalist() {
    const dl = document.getElementById('product-datalist');
    dl.innerHTML = '';
    // Capped to keep the datalist responsive -- typing narrows results as the
    // browser filters, so this is plenty for a human typing a code or name.
    catalog.products.slice(0, 5000).forEach((p) => {
        const opt = document.createElement('option');
        opt.value = `${p.code} — ${p.name}`;
        dl.appendChild(opt);
    });
}

function extractCodeFromInput(value) {
    const trimmed = value.trim();
    const dashIdx = trimmed.indexOf(' — ');
    if (dashIdx !== -1) return trimmed.slice(0, dashIdx).trim();
    // allow pasting a bare code too
    if (productByCode.has(trimmed)) return trimmed;
    // or a bare name -- try to resolve it
    const match = catalog.products.find((p) => p.name === trimmed);
    return match ? match.code : trimmed;
}

async function loadPoliciesAndRender() {
    const result = await window.api.loadPolicies();
    if (!result.ok) {
        alert(`Chyba při načítání pravidel: ${result.error}`);
        return;
    }
    policies = result.data;
    renderAllRuleTables();
}

// Forces a fresh fetch regardless of whether the catalog is already loaded --
// used by the explicit "refresh" button. Also drives the shared memoized
// loader below, so a manual refresh mid-flight replaces any in-flight startup
// fetch instead of racing it.
// forceRefresh=true bypasses BOTH the in-memory `catalog` state AND main
// process's 10-minute on-disk cache (catalogFetcher.js) -- only the manual
// "Obnovit" button should ever pass true. Startup code must pass false (the
// default) so it uses the disk cache when available, instead of re-downloading
// the ~58MB feed on every launch/tab-switch.
async function loadCatalogFresh(forceRefresh = false) {
    const promise = window.api.loadCatalog(forceRefresh).then((result) => {
        if (!result.ok) throw new Error(result.error);
        catalog = result.data;
        productByCode = new Map(catalog.products.map((p) => [p.code, p]));
        renderProductDatalist();
        return catalog;
    });
    catalogLoadPromise = promise;
    try {
        return await promise;
    } finally {
        if (catalogLoadPromise === promise) catalogLoadPromise = null;
    }
}

// Loads the catalog only if it isn't already loaded (or already loading) --
// this is what startup code should call, never window.api.loadCatalog() directly.
async function ensureCatalogLoaded() {
    if (catalog.products.length > 0) return catalog;
    if (catalogLoadPromise) return catalogLoadPromise;
    return loadCatalogFresh(false);
}

document.getElementById('refreshCatalog').addEventListener('click', async () => {
    const statusEl = document.getElementById('catalogStatus');
    statusEl.textContent = 'Načítám…';
    try {
        await loadCatalogFresh(true);
        statusEl.textContent = `${catalog.brands.length} značek, ${catalog.products.length} produktů (načteno ${new Date().toLocaleTimeString('sk-SK')})`;
        if (policies) renderAllRuleTables();
    } catch (e) {
        statusEl.textContent = `Chyba: ${e.message}`;
    }
});

async function renderDashboard() {
    const statusEl = document.getElementById('dashboardStatus');
    statusEl.textContent = 'Počítám…';
    if (!policies) await loadPoliciesAndRender();
    await ensureCatalogLoaded();

    const result = await window.api.computeDashboard({ catalog, policies });
    if (!result.ok) {
        statusEl.textContent = `Chyba: ${result.error}`;
        return;
    }
    const d = result.data;
    statusEl.textContent = `Aktualizováno ${new Date().toLocaleTimeString('sk-SK')} — ${d.totalCatalogProducts} produktů v katalogu.`;

    const eur = (n) => n.toLocaleString('sk-SK', { maximumFractionDigits: 0 }) + ' €';
    const pct = (n) => n.toLocaleString('sk-SK', { maximumFractionDigits: 1 }) + ' %';

    document.getElementById('dashboard-stats').innerHTML = `
        <div class="stat-card">
            <div class="stat-label">Celková sleva na katalogu</div>
            <div class="stat-value">${eur(d.totalDiscountEur)}</div>
            <div class="stat-sub">${pct(d.overallDiscountPct)} z ceny (teoreticky, celý katalog)</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Marže při současných pravidlech</div>
            <div class="stat-value">${pct(d.overallMarginPct)}</div>
            <div class="stat-sub">${eur(d.totalMarginEur)} celkem (${d.productsWithPurchasePrice} produktů má nákupní cenu)</div>
        </div>
        <div class="stat-card">
            <div class="stat-label">Produkty s vlastním pravidlem</div>
            <div class="stat-value">${d.productsWithRule.toLocaleString('sk-SK')}</div>
            <div class="stat-sub">z ${d.totalCatalogProducts.toLocaleString('sk-SK')} produktů celkem</div>
        </div>`;

    const tbody = document.querySelector('#table-dashboard-breakdown tbody');
    tbody.innerHTML = `
        <tr><td>Individuální pravidlo na produkt (max. sleva)</td><td>${d.breakdown.productOverrides}</td></tr>
        <tr><td>Produkty bez slevy (0 %)</td><td>${d.breakdown.zeroDiscount}</td></tr>
        <tr><td>Výprodej / clearance</td><td>${d.breakdown.clearance}</td></tr>
        <tr><td>Značky s vlastním stropem</td><td>${d.breakdown.brandLimits}</td></tr>
        <tr><td>Kategorie s vlastním stropem</td><td>${d.breakdown.categoryLimits}</td></tr>`;
}
document.getElementById('refreshDashboard').addEventListener('click', renderDashboard);

async function ensureRulesLoaded() {
    if (!policies) await loadPoliciesAndRender();
    await ensureCatalogLoaded();
}
document.querySelectorAll('.tab[data-tab="rules"]').forEach((tab) => {
    tab.addEventListener('click', ensureRulesLoaded, { once: true });
});

// Runs once on launch, while the small splash window is showing: loads
// policies + the (possibly cached) product catalog BEFORE any tab content is
// revealed, then tells main.js to grow the window to its working size. Avoids
// ever showing the admin UI half-populated with "(neznámý produkt, katalog
// ještě nenačten)" placeholders while a cold-start fetch is still in flight.
async function startUpSequence() {
    // First-ever launch on a machine (no ~/okfish-pricing-engine yet) clones it
    // here instead of requiring a separate setup script to be run by hand first
    // -- see policyManager.ensureRepoCloned. A missing git install is the only
    // way this can fail, so surface that directly on the splash and stop instead
    // of letting every step after it fail with a confusing "ENOENT" further down.
    const repoResult = await window.api.ensureRepo();
    if (!repoResult.ok) {
        if (splashStatusEl) splashStatusEl.textContent = repoResult.error;
        return;
    }
    await ensureRulesLoaded();
    await renderDashboard();
    document.body.classList.remove('app-loading');
    document.getElementById('splashScreen')?.classList.add('hidden');
    window.api.notifyAppReady();
}
startUpSequence();

// Live filter for the product-code rule tables (data-filter-table="table-X") -- lets
// Pavol type a code/name and immediately see whether that product already has a rule,
// instead of scrolling a long always-visible list.
document.querySelectorAll('.table-filter').forEach((input) => {
    input.addEventListener('input', () => {
        const q = input.value.trim().toLowerCase();
        const table = document.getElementById(input.dataset.filterTable);
        table.querySelectorAll('tbody tr').forEach((tr) => {
            const text = tr.textContent.toLowerCase();
            tr.style.display = (!q || text.includes(q)) ? '' : 'none';
        });
    });
});

// --- Brand limits ---
document.getElementById('add-brandLimits').addEventListener('click', () => {
    const brand = document.getElementById('new-brandLimits-key').value;
    const pct = validPercent(document.getElementById('new-brandLimits-value').value);
    if (!brand || pct === null) return alert('Vyber značku a zadej platné procento (0–100).');
    policies.brandLimits[brand] = pct / 100;
    document.getElementById('new-brandLimits-value').value = '';
    renderBrandLimitsTable();
});
document.querySelector('#table-brandLimits tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-brandLimits')) {
        delete policies.brandLimits[e.target.dataset.key];
        renderBrandLimitsTable();
    }
});
document.querySelector('#table-brandLimits tbody').addEventListener('change', (e) => {
    if (e.target.classList.contains('edit-brandLimits')) {
        const pct = validPercent(e.target.value);
        if (pct === null) { alert('Neplatné procento (0–100).'); renderBrandLimitsTable(); return; }
        policies.brandLimits[e.target.dataset.key] = pct / 100;
    }
});
document.getElementById('save-brandLimits').addEventListener('click', () => saveSection('brandLimits', policies.brandLimits, 'Aktualizace max. slevy podle značky'));

// --- Category limits ---
document.getElementById('add-categoryLimits').addEventListener('click', () => {
    const cat = document.getElementById('new-categoryLimits-key').value;
    const pct = validPercent(document.getElementById('new-categoryLimits-value').value);
    if (!cat || pct === null) return alert('Vyber kategorii a zadej platné procento (0–100).');
    policies.categoryLimits[cat] = pct / 100;
    document.getElementById('new-categoryLimits-value').value = '';
    renderCategoryLimitsTable();
});
document.querySelector('#table-categoryLimits tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-categoryLimits')) {
        delete policies.categoryLimits[e.target.dataset.key];
        renderCategoryLimitsTable();
    }
});
document.querySelector('#table-categoryLimits tbody').addEventListener('change', (e) => {
    if (e.target.classList.contains('edit-categoryLimits')) {
        const pct = validPercent(e.target.value);
        if (pct === null) { alert('Neplatné procento (0–100).'); renderCategoryLimitsTable(); return; }
        policies.categoryLimits[e.target.dataset.key] = pct / 100;
    }
});
document.getElementById('save-categoryLimits').addEventListener('click', () => saveSection('categoryLimits', policies.categoryLimits, 'Aktualizace max. slevy podle kategorie'));

// --- Product overrides ---
document.getElementById('add-productOverrides').addEventListener('click', () => {
    const code = extractCodeFromInput(document.getElementById('new-productOverrides-key').value);
    const pct = validPercent(document.getElementById('new-productOverrides-value').value);
    if (!code || pct === null) return alert('Vyber produkt ze seznamu a zadej platné procento (0–100).');
    if (!productByCode.has(code)) return alert(`Kód "${code}" nebyl nalezen v katalogu. Vyber produkt ze seznamu (napovídání), ne volný text.`);
    policies.productOverrides[code] = pct;
    document.getElementById('new-productOverrides-key').value = '';
    document.getElementById('new-productOverrides-value').value = '';
    renderProductOverridesTable();
});
document.querySelector('#table-productOverrides tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-productOverrides')) {
        delete policies.productOverrides[e.target.dataset.key];
        renderProductOverridesTable();
    }
});
document.querySelector('#table-productOverrides tbody').addEventListener('change', (e) => {
    if (e.target.classList.contains('edit-productOverrides')) {
        const pct = validPercent(e.target.value);
        if (pct === null) { alert('Neplatné procento (0–100).'); renderProductOverridesTable(); return; }
        policies.productOverrides[e.target.dataset.key] = pct;
    }
});
document.getElementById('save-productOverrides').addEventListener('click', () => saveSection('productOverrides', policies.productOverrides, 'Aktualizace max. slevy podle produktu'));

// --- Zero discount ---
document.getElementById('add-zeroDiscount').addEventListener('click', () => {
    const code = extractCodeFromInput(document.getElementById('new-zeroDiscount-key').value);
    if (!code) return alert('Vyber produkt ze seznamu.');
    if (!productByCode.has(code)) return alert(`Kód "${code}" nebyl nalezen v katalogu. Vyber produkt ze seznamu (napovídání), ne volný text.`);
    if (policies.zeroDiscount.includes(code)) return alert('Tento produkt už v seznamu je.');
    policies.zeroDiscount.push(code);
    document.getElementById('new-zeroDiscount-key').value = '';
    renderZeroDiscountTable();
});
document.querySelector('#table-zeroDiscount tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-zeroDiscount')) {
        policies.zeroDiscount = policies.zeroDiscount.filter((c) => c !== e.target.dataset.key);
        renderZeroDiscountTable();
    }
});
document.getElementById('save-zeroDiscount').addEventListener('click', () => saveSection('zeroDiscount', policies.zeroDiscount, 'Aktualizace produktů bez slevy'));

// --- Clearance ---
document.getElementById('add-clearance').addEventListener('click', () => {
    const code = extractCodeFromInput(document.getElementById('new-clearance-key').value);
    const pct = validPercent(document.getElementById('new-clearance-value').value);
    const validFrom = document.getElementById('new-clearance-validFrom').value;
    const validTo = document.getElementById('new-clearance-validTo').value;
    if (!code || pct === null) return alert('Vyber produkt ze seznamu a zadej platné procento (0–100).');
    if (!productByCode.has(code)) return alert(`Kód "${code}" nebyl nalezen v katalogu. Vyber produkt ze seznamu (napovídání), ne volný text.`);
    policies.clearance[code] = makeClearanceEntry(pct, validFrom, validTo);
    document.getElementById('new-clearance-key').value = '';
    document.getElementById('new-clearance-value').value = '';
    document.getElementById('new-clearance-validFrom').value = '';
    document.getElementById('new-clearance-validTo').value = '';
    renderClearanceTable();
});
document.querySelector('#table-clearance tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-clearance')) {
        delete policies.clearance[e.target.dataset.key];
        renderClearanceTable();
    }
});
document.querySelector('#table-clearance tbody').addEventListener('change', (e) => {
    const code = e.target.dataset.key;
    if (!code) return;
    const row = e.target.closest('tr');
    const pct = validPercent(row.querySelector('.edit-clearance-pct').value);
    if (pct === null) { alert('Neplatné procento (0–100).'); renderClearanceTable(); return; }
    const validFrom = row.querySelector('.edit-clearance-from').value;
    const validTo = row.querySelector('.edit-clearance-to').value;
    policies.clearance[code] = makeClearanceEntry(pct, validFrom, validTo);
});
document.getElementById('save-clearance').addEventListener('click', () => saveSection('clearance', policies.clearance, 'Aktualizace výprodejových cen'));

// --- Kupóny ---
document.getElementById('add-coupon-disabledBrands').addEventListener('click', () => {
    const brand = document.getElementById('new-coupon-disabledBrands').value;
    const validFrom = document.getElementById('new-coupon-disabledBrands-validFrom').value;
    const validTo = document.getElementById('new-coupon-disabledBrands-validTo').value;
    if (!brand) return alert('Vyber značku.');
    if (policies.couponPolicy.disabledBrands.map(disabledValue).includes(brand)) return alert('Tato značka už v seznamu je.');
    policies.couponPolicy.disabledBrands.push(makeDisabledEntry(brand, validFrom, validTo));
    document.getElementById('new-coupon-disabledBrands-validFrom').value = '';
    document.getElementById('new-coupon-disabledBrands-validTo').value = '';
    renderCouponPolicy();
});
document.querySelector('#table-coupon-disabledBrands tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-coupon-disabledBrands')) {
        policies.couponPolicy.disabledBrands.splice(Number(e.target.dataset.idx), 1);
        renderCouponPolicy();
    }
});

document.getElementById('add-coupon-disabledProducts').addEventListener('click', () => {
    const code = extractCodeFromInput(document.getElementById('new-coupon-disabledProducts').value);
    const validFrom = document.getElementById('new-coupon-disabledProducts-validFrom').value;
    const validTo = document.getElementById('new-coupon-disabledProducts-validTo').value;
    if (!code) return alert('Vyber produkt ze seznamu.');
    if (!productByCode.has(code)) return alert(`Kód "${code}" nebyl nalezen v katalogu. Vyber produkt ze seznamu (napovídání), ne volný text.`);
    if (policies.couponPolicy.disabledProducts.map(disabledValue).includes(code)) return alert('Tento produkt už v seznamu je.');
    policies.couponPolicy.disabledProducts.push(makeDisabledEntry(code, validFrom, validTo));
    document.getElementById('new-coupon-disabledProducts').value = '';
    document.getElementById('new-coupon-disabledProducts-validFrom').value = '';
    document.getElementById('new-coupon-disabledProducts-validTo').value = '';
    renderCouponPolicy();
});
document.querySelector('#table-coupon-disabledProducts tbody').addEventListener('click', (e) => {
    if (e.target.classList.contains('remove-coupon-disabledProducts')) {
        policies.couponPolicy.disabledProducts.splice(Number(e.target.dataset.idx), 1);
        renderCouponPolicy();
    }
});

document.getElementById('save-couponPolicy').addEventListener('click', () => {
    const pct = validPercent(document.getElementById('coupon-defaultMaxDiscount').value);
    if (pct === null) return alert('Neplatné výchozí procento (0–100).');
    policies.couponPolicy.defaultMaxDiscount = pct;
    policies.couponPolicy.lockedTiers = (policies.allTiers || [])
        .filter((tier) => document.getElementById(`coupon-lockedTier-${tier}`).checked);
    saveSection('couponPolicy', policies.couponPolicy, 'Aktualizace kupónových pravidel');
});

// --- Zakázat/povolit vložení do košíku ---
let availabilitiesLoaded = false;
async function loadAvailabilitiesOnce() {
    if (availabilitiesLoaded) return;
    const result = await window.api.getAvailabilities();
    const select = document.getElementById('availabilitySelect');
    if (!result.ok) {
        select.innerHTML = `<option value="">Chyba: ${result.error}</option>`;
        return;
    }
    availabilitiesLoaded = true;
    select.innerHTML = result.availabilities
        .map((a) => `<option value="${a.id}">${a.name}${a.indexName === 'soldout' || a.indexName === 'unavailable' ? ' — SKRYJE KOŠÍK' : ''}</option>`)
        .join('');
}
document.querySelectorAll('.tab[data-tab="importexport"]').forEach((tab) => {
    tab.addEventListener('click', loadAvailabilitiesOnce, { once: true });
});

document.getElementById('applyAvailability').addEventListener('click', async () => {
    const code = extractCodeFromInput(document.getElementById('availabilityProductKey').value);
    const availabilityId = document.getElementById('availabilitySelect').value;
    const resultEl = document.getElementById('result-availability');
    resultEl.textContent = '';
    if (!code) return alert('Vyber produkt ze seznamu.');
    if (!productByCode.has(code)) return alert(`Kód "${code}" nebyl nalezen v katalogu. Vyber produkt ze seznamu (napovídání), ne volný text.`);
    if (!availabilityId) return alert('Vyber dostupnost.');

    const result = await window.api.setProductAvailability({ code, availabilityId: Number(availabilityId) });
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = `Hotovo — nastaveno u produktu ${code}.`;
    } else {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
    }
});

async function exportSection(section, data) {
    const result = await window.api.exportRuleCsv({ section, data });
    if (!result.ok) return alert(`Chyba při exportu: ${result.error}`);
    alert(`Uloženo do Downloads (${result.rowCount} řádků): ${result.outputPath}\n\nTento soubor nahraj v Shoptetu: Produkty -> Import.`);
}
document.getElementById('export-productOverrides').addEventListener('click', () => exportSection('productOverrides', policies.productOverrides));
document.getElementById('export-zeroDiscount').addEventListener('click', () => exportSection('zeroDiscount', policies.zeroDiscount));
document.getElementById('export-clearance').addEventListener('click', () => exportSection('clearance', policies.clearance));

// --- Ruční změna tieru zákazníka ---
const ALL_TIERS_LOCAL = ['ZR4', 'ZR6', 'ZR8', 'ZR10', 'ZR12', 'ZR14', 'ZR16', 'ZR18', 'ZR20', 'ZR25'];
let customerIndex = []; // [{guid, name}] -- loaded on demand, used for the name typeahead

function renderCustomerRow(c) {
    const tbody = document.querySelector('#table-customerSearch tbody');
    const tr = document.createElement('tr');
    const currentTier = c.tier || '(žádný)';
    const tierOptions = ALL_TIERS_LOCAL.map((t) => `<option value="${t}" ${t === currentTier ? 'selected' : ''}>${t}</option>`).join('');
    tr.innerHTML = `
        <td>${c.name || '(bez jména)'}</td>
        <td>${c.email || '(bez e-mailu)'}</td>
        <td>${currentTier}</td>
        <td><select class="new-tier-select">${tierOptions}</select></td>
        <td><button class="apply-tier-btn" data-guid="${c.guid}">Nastavit</button></td>`;
    tbody.appendChild(tr);
}

document.getElementById('loadCustomerIndex').addEventListener('click', async () => {
    const statusEl = document.getElementById('customerIndexStatus');
    statusEl.textContent = 'Načítám… (může to chvíli trvat, tisíce zákazníků)';
    const result = await window.api.loadCustomerIndex();
    if (!result.ok) {
        statusEl.textContent = `Chyba: ${result.error}`;
        return;
    }
    customerIndex = result.customers;
    statusEl.textContent = `${customerIndex.length} zákazníků načteno (${new Date().toLocaleTimeString('sk-SK')}) — teď našeptává i podle jména.`;
});

const customerSearchInput = document.getElementById('customerSearch');
const customerSuggestionsEl = document.getElementById('customerSuggestions');

customerSearchInput.addEventListener('input', () => {
    const q = customerSearchInput.value.trim().toLowerCase();
    customerSuggestionsEl.innerHTML = '';
    if (q.length < 2 || q.includes('@') || customerIndex.length === 0) {
        customerSuggestionsEl.style.display = 'none';
        return;
    }
    const matches = customerIndex.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 20);
    if (matches.length === 0) {
        customerSuggestionsEl.style.display = 'none';
        return;
    }
    matches.forEach((c) => {
        const div = document.createElement('div');
        div.textContent = c.name;
        div.addEventListener('click', async () => {
            customerSearchInput.value = c.name;
            customerSuggestionsEl.style.display = 'none';
            await loadAndShowCustomerDetail(c.guid);
        });
        customerSuggestionsEl.appendChild(div);
    });
    customerSuggestionsEl.style.display = 'block';
});
document.addEventListener('click', (e) => {
    if (!e.target.closest('.autocomplete-wrap')) customerSuggestionsEl.style.display = 'none';
});

async function loadAndShowCustomerDetail(guid) {
    const resultEl = document.getElementById('result-customerTier');
    resultEl.textContent = '';
    document.querySelector('#table-customerSearch tbody').innerHTML = '';
    const result = await window.api.getCustomerDetail(guid);
    if (!result.ok) {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
        return;
    }
    renderCustomerRow(result.customer);
}

document.getElementById('searchCustomer').addEventListener('click', async () => {
    const query = customerSearchInput.value.trim();
    const resultEl = document.getElementById('result-customerTier');
    resultEl.textContent = '';
    if (!query) return alert('Zadej jméno nebo e-mail.');

    const tbody = document.querySelector('#table-customerSearch tbody');
    tbody.innerHTML = '';
    customerSuggestionsEl.style.display = 'none';

    if (query.includes('@')) {
        const result = await window.api.findCustomers(query);
        if (!result.ok) {
            resultEl.className = 'result error';
            resultEl.textContent = `Chyba: ${result.error}`;
            return;
        }
        if (result.customers.length === 0) {
            resultEl.className = 'result error';
            resultEl.textContent = 'Zákazník nenalezen.';
            return;
        }
        result.customers.forEach(renderCustomerRow);
        return;
    }

    if (customerIndex.length === 0) {
        return alert('Nejdřív klikni na "Načíst zákazníky", pak lze hledat podle jména.');
    }
    const q = query.toLowerCase();
    const matches = customerIndex.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 15);
    if (matches.length === 0) {
        resultEl.className = 'result error';
        resultEl.textContent = 'Zákazník nenalezen.';
        return;
    }
    const details = await Promise.all(matches.map((c) => window.api.getCustomerDetail(c.guid)));
    details.forEach((result) => {
        if (result.ok) renderCustomerRow(result.customer);
    });
});

document.querySelector('#table-customerSearch tbody').addEventListener('click', async (e) => {
    if (!e.target.classList.contains('apply-tier-btn')) return;
    const guid = e.target.dataset.guid;
    const tr = e.target.closest('tr');
    const tier = tr.querySelector('.new-tier-select').value;
    const resultEl = document.getElementById('result-customerTier');
    resultEl.textContent = '';

    const result = await window.api.setCustomerTier({ guid, tier });
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = `Hotovo — tier nastaven na ${tier}.`;
        tr.children[2].textContent = tier;
    } else {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
    }
});

async function saveSection(section, data, commitMessage) {
    const resultEl = document.getElementById(`result-${section}`);
    resultEl.textContent = '';
    const result = await window.api.savePolicies({ section, data, commitMessage });
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = result.pushed
            ? 'Uloženo a nahráno — projeví se při další synchronizaci (do cca hodiny).'
            : 'Žádná změna k uložení.';
    } else {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
    }
}

document.getElementById('runCustomers').addEventListener('click', async () => {
    const btn = document.getElementById('runCustomers');
    const resultEl = document.getElementById('customerResult');
    const syncWorker = document.getElementById('customerSyncWorker').checked;
    btn.disabled = true;
    resultEl.innerHTML = '';
    document.getElementById('openCustomerOutput').style.display = 'none';

    const result = await window.api.processCustomers(customerPath, syncWorker);

    btn.disabled = false;
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = `Hotovo — ${result.totalCustomers} zákazníků, ${result.upgradedCustomers} změněno.`;
        const openBtn = document.getElementById('openCustomerOutput');
        openBtn.style.display = '';
        openBtn.onclick = () => window.api.revealFile(result.outputPath);
    } else {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
    }
});

// --- Nastavení (API klíč) ---------------------------------------------------
async function loadSettingsAndRender() {
    const result = await window.api.loadSettings();
    const input = document.getElementById('settings-apiKey');
    if (result.ok && result.data.isSet) {
        input.value = result.data.masked;
        input.dataset.masked = 'true';
    } else {
        input.value = '';
        input.dataset.masked = 'false';
    }
}
document.querySelectorAll('.tab[data-tab="settings"]').forEach((tab) => {
    tab.addEventListener('click', loadSettingsAndRender, { once: true });
});

document.getElementById('toggle-apiKey-visibility').addEventListener('click', () => {
    const input = document.getElementById('settings-apiKey');
    input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('save-settings').addEventListener('click', async () => {
    const input = document.getElementById('settings-apiKey');
    const resultEl = document.getElementById('result-settings');
    // The field shows a masked placeholder (••••1234) when a key is already
    // saved -- if the user didn't actually change it, re-saving that masked
    // string would overwrite the real key with garbage. Only save when the
    // field holds something other than the untouched mask.
    if (input.dataset.masked === 'true') {
        resultEl.className = 'result error';
        resultEl.textContent = 'Klíč je už nastavený (skrytý). Klikni na "Zobrazit/skrýt" a přepiš ho, jen pokud ho chceš změnit.';
        return;
    }
    if (!input.value.trim()) {
        resultEl.className = 'result error';
        resultEl.textContent = 'Zadej API klíč.';
        return;
    }
    const result = await window.api.saveSettings({ apiKey: input.value.trim() });
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = 'API klíč byl uložen.';
        await loadSettingsAndRender();
    } else {
        resultEl.className = 'result error';
        resultEl.textContent = `Chyba: ${result.error}`;
    }
});
// Typing into the field after a masked value was loaded means the user is
// intentionally replacing it -- clear the "masked" guard so Save works.
document.getElementById('settings-apiKey').addEventListener('input', (e) => {
    e.target.dataset.masked = 'false';
});
