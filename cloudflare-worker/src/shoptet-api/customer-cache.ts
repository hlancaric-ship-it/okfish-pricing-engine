export interface ICustomerCache {
    /**
     * Uloží slevu zákazníka pod zahashovaným emailem.
     */
    setCustomerDiscount(email: string, discount: number): Promise<void>;
    
    /**
     * Provádí dávkový zápis na konci zpracování.
     */
    commit(version: string, isFullSync: boolean): Promise<void>;
}

async function sha256(message: string): Promise<string> {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export class FileCustomerCache implements ICustomerCache {
    private cache: Record<string, number> = {};

    public async setCustomerDiscount(email: string, discount: number): Promise<void> {
        const hash = await sha256(email.trim().toLowerCase());
        this.cache[hash] = discount;
    }

    public async commit(version: string, isFullSync: boolean): Promise<void> {
        // V lokálním prostředí jen zapíšeme JSON soubor (simulace KV)
        const fs = await import('fs');
        const path = await import('path');
        const filePath = path.resolve(process.cwd(), '.customers_cache.json');
        
        let existing: Record<string, any> = {};
        if (fs.existsSync(filePath)) {
            try {
                existing = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            } catch (e) {
                // ignore
            }
        }
        
        existing[version] = {
            ...existing[version],
            ...this.cache
        };
        
        fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
        console.log(`[FileCustomerCache] Uloženo ${Object.keys(this.cache).length} zákazníků do verze ${version}`);
        this.cache = {};
    }
}

export class KvCustomerCache implements ICustomerCache {
    private cache: Record<string, number> = {};

    constructor(private readonly kv: any) {}

    public async setCustomerDiscount(email: string, discount: number): Promise<void> {
        const hash = await sha256(email.trim().toLowerCase());
        this.cache[hash] = discount;
    }

    public async commit(version: string, isFullSync: boolean): Promise<void> {
        const entries = Object.entries(this.cache);
        if (entries.length === 0) return;

        // Zapíšeme všechny zákazníky do KV s prefixem verze
        await Promise.all(
            entries.map(([hash, discount]) => 
                this.kv.put(`customer:${version}:${hash}`, String(discount))
            )
        );

        if (isFullSync) {
            // Následně atomicky přepneme aktivní verzi
            await this.kv.put('active_customer_version', version);
            console.log(`[KvCustomerCache] Uloženo ${entries.length} zákazníků do KV a nastavena active_customer_version na ${version}`);
        } else {
            console.log(`[KvCustomerCache] Uloženo ${entries.length} zákazníků do aktivní verze KV (${version})`);
        }
        
        this.cache = {};
    }
}

export class RemoteCustomerCache implements ICustomerCache {
    private cache: Record<string, number> = {};

    constructor(
        private readonly baseUrl: string,
        private readonly token: string
    ) {}

    public async setCustomerDiscount(email: string, discount: number): Promise<void> {
        const hash = await sha256(email.trim().toLowerCase());
        this.cache[hash] = discount;
    }

    public async commit(version: string, isFullSync: boolean): Promise<void> {
        const allItems = Object.entries(this.cache).map(([hash, discount]) => ({
            hash,
            discount
        }));

        if (allItems.length === 0) return;

        let targetVersion = version;
        
        if (!isFullSync) {
            // Pro inkrement zjistíme aktivní verzi z Workeru
            const activeRes = await fetch(`${this.baseUrl}/v1/import/active`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (activeRes.ok) {
                const activeData = await activeRes.json();
                if (activeData.version) {
                    targetVersion = activeData.version;
                }
            }
        }

        console.log(`[RemoteCustomerCache] Odesílám ${allItems.length} zákazníků do Workeru (verze: ${targetVersion}, isFullSync: ${isFullSync})...`);

        const BATCH_SIZE = 250;
        const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);

        for (let i = 0; i < totalBatches; i++) {
            const batchItems = allItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            const payload = { version: targetVersion, customers: batchItems };

            let attempts = 0;
            let success = false;
            while (attempts < 3 && !success) {
                try {
                    const res = await fetch(`${this.baseUrl}/v1/import/chunk`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.token}`
                        },
                        body: JSON.stringify(payload)
                    });
                    if (!res.ok) throw new Error(`HTTP Error: ${res.status}`);
                    success = true;
                } catch (err: any) {
                    attempts++;
                    if (attempts === 3) throw err;
                    await new Promise(r => setTimeout(r, 1000 * attempts));
                }
            }
        }

        if (isFullSync) {
            const finishRes = await fetch(`${this.baseUrl}/v1/import/finish`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ version: targetVersion, customers: allItems.length })
            });
            if (!finishRes.ok) throw new Error(`Finish failed: ${finishRes.status}`);
            
            const finalData = await finishRes.json();
            const oldVersion = finalData.oldVersion;

            if (oldVersion && oldVersion !== targetVersion) {
                try {
                    await fetch(`${this.baseUrl}/v1/import/cleanup`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${this.token}`
                        },
                        body: JSON.stringify({ version: oldVersion })
                    });
                } catch (err) {
                    // Ignore cleanup errors
                }
            }
        }

        console.log(`[RemoteCustomerCache] Úspěšně zapsáno ${allItems.length} zákazníků přes API Workeru pod verzí ${targetVersion}.`);
        this.cache = {};
    }
}
