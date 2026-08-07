'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    pickFile: (filters) => ipcRenderer.invoke('pick-file', filters),
    revealFile: (filePath) => ipcRenderer.invoke('reveal-file', filePath),
    processProducts: (inputPath, alsoSyncWorker) => ipcRenderer.invoke('process-products', inputPath, alsoSyncWorker),
    processCustomers: (inputPath, alsoSyncWorker) => ipcRenderer.invoke('process-customers', inputPath, alsoSyncWorker),
    loadCatalog: () => ipcRenderer.invoke('load-catalog'),
    computeDashboard: (payload) => ipcRenderer.invoke('compute-dashboard', payload),
    loadPolicies: () => ipcRenderer.invoke('load-policies'),
    savePolicies: (payload) => ipcRenderer.invoke('save-policies', payload),
    exportRuleCsv: (payload) => ipcRenderer.invoke('export-rule-csv', payload),
    loadCustomerIndex: () => ipcRenderer.invoke('load-customer-index'),
    getCustomerDetail: (guid) => ipcRenderer.invoke('get-customer-detail', guid),
    getAvailabilities: () => ipcRenderer.invoke('get-availabilities'),
    setProductAvailability: (payload) => ipcRenderer.invoke('set-product-availability', payload),
    findCustomers: (email) => ipcRenderer.invoke('find-customers', email),
    setCustomerTier: (payload) => ipcRenderer.invoke('set-customer-tier', payload),
    onLog: (callback) => ipcRenderer.on('log', (event, line) => callback(line))
});
