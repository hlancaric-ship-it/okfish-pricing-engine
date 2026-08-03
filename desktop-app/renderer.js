'use strict';

const logEl = document.getElementById('log');
window.api.onLog((line) => {
    logEl.textContent += line + '\n';
    logEl.scrollTop = logEl.scrollHeight;
});

document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
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

// --- Max. sleva podle značky ---
let maxDiscountPath = null;
document.getElementById('pickMaxDiscountFile').addEventListener('click', async () => {
    const path = await window.api.pickFile([{ name: 'Excel', extensions: ['xlsx'] }]);
    if (path) {
        maxDiscountPath = path;
        document.getElementById('maxDiscountPath').value = path;
        document.getElementById('runMaxDiscount').disabled = false;
    }
});

document.getElementById('runMaxDiscount').addEventListener('click', async () => {
    const btn = document.getElementById('runMaxDiscount');
    const resultEl = document.getElementById('maxDiscountResult');
    const rulesText = document.getElementById('brandRules').value;
    btn.disabled = true;
    resultEl.innerHTML = '';
    document.getElementById('openMaxDiscountOutput').style.display = 'none';

    const result = await window.api.setMaxDiscount(maxDiscountPath, rulesText);

    btn.disabled = false;
    if (result.ok) {
        resultEl.className = 'result ok';
        resultEl.textContent = `Hotovo — nalezeno ${result.matchedCount} produktů podle značky, upraveno ${result.changedCount}. Detaily v logu dole.`;
        const openBtn = document.getElementById('openMaxDiscountOutput');
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
