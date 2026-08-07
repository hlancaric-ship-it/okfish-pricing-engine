'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { processProductXlsx } = require('./lib/xlsxProductProcessor');
const { processCustomersCsv } = require('./lib/customerProcessor');
const { syncCustomers, syncProducts } = require('./lib/workerSync');
const policyManager = require('./lib/policyManager');
const { fetchCatalog } = require('./lib/catalogFetcher');
const shoptetApi = require('./lib/shoptetApi');
const { computeDashboard } = require('./lib/dashboardCalculator');

let mainWindow;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    mainWindow.loadFile('index.html');
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function log(msg) {
    const line = `[${new Date().toLocaleTimeString('sk-SK')}] ${msg}`;
    console.log(line);
    if (mainWindow) mainWindow.webContents.send('log', line);
}

ipcMain.handle('pick-file', async (event, filters) => {
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('reveal-file', async (event, filePath) => {
    shell.showItemInFolder(filePath);
});

ipcMain.handle('process-products', async (event, inputPath, alsoSyncWorker) => {
    try {
        const outputPath = inputPath.replace(/\.xlsx$/i, '_recalculated.xlsx');
        log(`=== Zpracování produktů: ${inputPath} ===`);
        const result = processProductXlsx(inputPath, outputPath, log);

        if (alsoSyncWorker) {
            await syncProducts(result.productsForSync, log);
        }

        log(`Výstupní soubor: ${outputPath}`);
        return { ok: true, outputPath, ...result };
    } catch (e) {
        log(`CHYBA: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('compute-dashboard', async (event, { catalog, policies }) => {
    try {
        return { ok: true, data: computeDashboard(catalog, policies) };
    } catch (e) {
        log(`CHYBA při výpočtu dashboardu: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('load-catalog', async () => {
    try {
        const data = await fetchCatalog(log);
        return { ok: true, data };
    } catch (e) {
        log(`CHYBA při načítání katalogu: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('load-policies', async () => {
    try {
        return { ok: true, data: policyManager.loadAll() };
    } catch (e) {
        log(`CHYBA při načítání pravidel: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('save-policies', async (event, { section, data, commitMessage }) => {
    try {
        log(`=== Ukládám pravidla: ${section} ===`);
        if (section === 'brandLimits') policyManager.saveBrandLimits(data);
        else if (section === 'categoryLimits') policyManager.saveCategoryLimits(data);
        else if (section === 'productOverrides') policyManager.saveProductOverrides(data);
        else if (section === 'zeroDiscount') policyManager.saveZeroDiscount(data);
        else if (section === 'clearance') policyManager.saveClearance(data);
        else if (section === 'couponPolicy') policyManager.saveCouponPolicy(data);
        else throw new Error(`Neznámá sekce pravidel: ${section}`);

        const result = await policyManager.commitAndPush(commitMessage, log);
        return { ok: true, pushed: result.pushed };
    } catch (e) {
        log(`CHYBA při ukládání pravidel: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('export-rule-csv', async (event, { section, data }) => {
    try {
        log(`=== Exportuji seznam do Downloads: ${section} ===`);
        const result = policyManager.exportRuleCsv(section, data);
        log(`Uloženo: ${result.outputPath} (${result.rowCount} řádků). Nahraj tento soubor v Shoptetu přes Produkty -> Import.`);
        return { ok: true, ...result };
    } catch (e) {
        log(`CHYBA při exportu: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('load-customer-index', async () => {
    try {
        log('=== Načítám index zákazníků (jméno) pro vyhledávání ===');
        const customers = await shoptetApi.fetchAllCustomersIndex(log);
        log(`Hotovo — ${customers.length} zákazníků.`);
        return { ok: true, customers };
    } catch (e) {
        log(`CHYBA při načítání zákazníků: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('get-customer-detail', async (event, guid) => {
    try {
        const customer = await shoptetApi.getCustomerDetail(guid);
        return { ok: true, customer };
    } catch (e) {
        log(`CHYBA při načítání detailu zákazníka: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('get-availabilities', async () => {
    try {
        const availabilities = await shoptetApi.getAvailabilities();
        return { ok: true, availabilities };
    } catch (e) {
        log(`CHYBA při načítání dostupností: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('set-product-availability', async (event, { code, availabilityId }) => {
    try {
        log(`=== Nastavuji dostupnost produktu ${code} na ID ${availabilityId} ===`);
        const result = await shoptetApi.setProductAvailability(code, availabilityId);
        log(`Hotovo (HTTP ${result.status}).`);
        return { ok: true };
    } catch (e) {
        log(`CHYBA při nastavování dostupnosti: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('find-customers', async (event, email) => {
    try {
        log(`Hledám zákazníka podle e-mailu: ${email}`);
        const customers = await shoptetApi.findCustomersByEmail(email);
        log(`Nalezeno: ${customers.length}`);
        return { ok: true, customers };
    } catch (e) {
        log(`CHYBA při hledání zákazníka: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('set-customer-tier', async (event, { guid, tier }) => {
    try {
        log(`=== Nastavuji tier ${tier} zákazníkovi ${guid} ===`);
        const result = await shoptetApi.setCustomerTier(guid, tier);
        log(`Hotovo (HTTP ${result.status}).`);
        return { ok: true };
    } catch (e) {
        log(`CHYBA při nastavování tieru: ${e.message}`);
        return { ok: false, error: e.message };
    }
});

ipcMain.handle('process-customers', async (event, inputPath, alsoSyncWorker) => {
    try {
        const outputPath = inputPath.replace(/\.csv$/i, '_import.csv');
        log(`=== Zpracování zákazníků: ${inputPath} ===`);
        const result = await processCustomersCsv(inputPath, outputPath, log);

        if (alsoSyncWorker) {
            await syncCustomers(result.vipDiscountsMap, log);
        }

        log(`Výstupní soubor: ${outputPath}`);
        return { ok: true, outputPath, ...result };
    } catch (e) {
        log(`CHYBA: ${e.message}`);
        return { ok: false, error: e.message };
    }
});
