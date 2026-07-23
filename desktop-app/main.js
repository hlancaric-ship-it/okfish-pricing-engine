'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const { processProductXlsx } = require('./lib/xlsxProductProcessor');
const { processCustomersCsv } = require('./lib/customerProcessor');
const { syncCustomers, syncProducts } = require('./lib/workerSync');

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
