'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
    revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
    processProducts: (inputPath, alsoSyncWorker) => ipcRenderer.invoke('process-products', inputPath, alsoSyncWorker),
    setMaxDiscount: (inputPath, rulesText) => ipcRenderer.invoke('set-max-discount', inputPath, rulesText),
    processCustomers: (inputPath, alsoSyncWorker) => ipcRenderer.invoke('process-customers', inputPath, alsoSyncWorker),
    onLog: (callback) => ipcRenderer.on('log', (event, line) => callback(line))
});
