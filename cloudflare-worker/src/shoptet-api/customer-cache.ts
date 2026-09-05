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

        console.log(`[RemoteCustomerCache] Odesílám ${allItems.length} zákazníků do Workeru (diff-aware zápis)...`);

        const BATCH_SIZE = 250;
        const totalBatches = Math.ceil(allItems.length / BATCH_SIZE);
        
        let totalWritten = 0, totalSkipped = 0;

        for (let i = 0; i < totalBatches; i++) {
            const batchItems = allItems.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
            // Verze už se neposílá (změna na stabilní klíče, 2026-08-25)
            const payload = { customers: batchItems };

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
                    
                    const resData = await res.json();
                    if (resData.written) totalWritten += resData.written;
                    if (resData.skipped) totalSkipped += resData.skipped;
                    
                    success = true;
                } catch (err: any) {
                    attempts++;
                    if (attempts === 3) throw err;
                    await new Promise(r => setTimeout(r, 1000 * attempts));
                }
            }
        }

        console.log(`[RemoteCustomerCache] Úspěšně zpracováno: ${totalWritten} zapsáno (nové/změněné), ${totalSkipped} přeskočeno (beze změny).`);
        this.cache = {};
    }
}
