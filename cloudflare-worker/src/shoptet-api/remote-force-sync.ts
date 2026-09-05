export interface ForceSyncEntry {
    code: string;
    guid: string;
}

export class RemoteForceSync {
    constructor(
        private readonly baseUrl: string,
        private readonly token: string
    ) {}

    public async getEntries(): Promise<ForceSyncEntry[]> {
        try {
            const res = await fetch(`${this.baseUrl}/v1/force-sync`, {
                headers: { 'Authorization': `Bearer ${this.token}` }
            });
            if (!res.ok) {
                console.warn(`[RemoteForceSync] Nepodařilo se načíst položky z KV (${res.status})`);
                return [];
            }
            const data = await res.json() as { entries: ForceSyncEntry[] };
            return Array.isArray(data.entries) ? data.entries : [];
        } catch (e) {
            console.warn(`[RemoteForceSync] Chyba při čtení z KV:`, e);
            return [];
        }
    }

    public async clearEntries(): Promise<void> {
        try {
            const res = await fetch(`${this.baseUrl}/v1/force-sync`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.token}`
                },
                body: JSON.stringify({ entries: [] })
            });
            if (!res.ok) {
                console.warn(`[RemoteForceSync] Nepodařilo se vyčistit KV frontu (${res.status})`);
            } else {
                console.log(`[RemoteForceSync] Fronta v KV úspěšně vyčištěna po úspěšném běhu.`);
            }
        } catch (e) {
            console.warn(`[RemoteForceSync] Chyba při čištění KV:`, e);
        }
    }
}
