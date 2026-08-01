const fs = require('fs');
const content = fs.readFileSync('cloudflare-worker/src/shoptet-api/customer-adapter.ts', 'utf8');

const targetStart = "        if (lastSync) {\n            console.log(`[CustomerAdapter] INKREMENTÁLNÍ REŽIM";
const targetEnd = "GlobalStats.ordersLoaded = orders.length;\n";

const idxStart = content.indexOf(targetStart);
const idxEnd = content.indexOf(targetEnd) + targetEnd.length;

if (idxStart === -1 || idxEnd === -1) {
    console.error("Not found");
    process.exit(1);
}

const replacement = `        if (lastSync) {
            console.log(\`[CustomerAdapter] INKREMENTÁLNÍ REŽIM - Hledám změněné zákazníky od \${lastSync}...\`);
            
            const customerChanges = await this.apiClient.getCustomerChanges(lastSync);
            for (const c of customerChanges) affectedCustomerGuids.add(c.guid);
            
            const orderChanges = await this.apiClient.getOrderChanges(lastSync);
            
            // Krok optimalizace: získání dotčených zákazníků ze změn objednávek (bez stahování všech objednávek)
            const changedOrderCodes = orderChanges.map(c => c.code).filter(Boolean) as string[];
            
            if (changedOrderCodes.length > 0) {
                console.log(\`[CustomerAdapter] Zjišťuji customerGuid pro \${changedOrderCodes.length} změněných objednávek dávkově...\`);
                
                // Rozdělit kódy do dávek po max 50 kusech
                for (let i = 0; i < changedOrderCodes.length; i += 50) {
                    const chunk = changedOrderCodes.slice(i, i + 50);
                    const chunkOrders = await this.apiClient.getOrdersByCodes(chunk);
                    for (const o of chunkOrders) {
                        if (o.customerGuid) {
                            affectedCustomerGuids.add(o.customerGuid);
                        }
                    }
                }
            }
            
            console.log(\`[CustomerAdapter] Po spojení máme \${affectedCustomerGuids.size} dotčených zákazníků k přepočtu.\`);
            
            if (affectedCustomerGuids.size === 0) {
                console.log(\`[CustomerAdapter] Žádné změny u zákazníků ani objednávek od \${lastSync}.\`);
                return [];
            }
            
            console.log('[CustomerAdapter] Stahuji celoživotní historii objednávek POUZE pro dotčené zákazníky...');
            // Stáhneme celoživotní historii POUZE pro tyto zákazníky
            for (const guid of affectedCustomerGuids) {
                const customerOrders = await this.apiClient.getCustomerOrders(guid);
                orders.push(...customerOrders);
            }
            
        } else {
             console.log('[CustomerAdapter] FULL SYNC - Stahuji všechny objednávky...');
             orders = await this.apiClient.getAllOrders(maxPages);
        }
        GlobalStats.ordersLoaded = orders.length;
`;

const newContent = content.substring(0, idxStart) + replacement + content.substring(idxEnd);
fs.writeFileSync('cloudflare-worker/src/shoptet-api/customer-adapter.ts', newContent);
console.log("Updated");
