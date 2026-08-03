'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { processProductXlsx } = require('./lib/xlsxProductProcessor');
const { processCustomersCsv } = require('./lib/customerProcessor');
const { syncCustomers, syncProducts } = require('./lib/workerSync');
const { setMaxDiscountByBrand } = require('./lib/setMaxDiscountByBrand');

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

ipcMain.handle('set-max-discount', async (event, inputPath, rulesText) => {
    try {
        const brandRules = rulesText
            .split('\n')
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => {
                const [brand, percentStr] = line.split(';').map(s => s.trim());
                const percent = Number(percentStr);
                if (!brand || Number.isNaN(percent)) {
                    throw new Error(`Neplatný řádek "${line}" — čekám formát "Značka;Procento", např. "Mikado;25"`);
                }
                return { brand, percent };
            });
        if (brandRules.length === 0) throw new Error('Nezadal jsi žádnou značku.');

        const outputPath = inputPath.replace(/\.xlsx$/i, '_max_sleva.xlsx');
        log(`=== Nastavuji max. slevu podle značky: ${inputPath} ===`);
        const result = setMaxDiscountByBrand(inputPath, outputPath, brandRules, log);

        log(`Výstupní soubor: ${outputPath}`);
        return { ok: true, outputPath, ...result };
    } catch (e) {
        log(`CHYBA: ${e.message}`);
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
