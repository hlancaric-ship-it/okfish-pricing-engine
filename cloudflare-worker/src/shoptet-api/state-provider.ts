import * as fs from 'fs';
import * as path from 'path';

export interface SyncConfigState {
    policyHash?: string;
    productOverrides?: Record<string, number>;
    zeroDiscountProducts?: string[];
    clearanceSaleProducts?: Record<string, any>;
}

export interface SyncStateData {
    lastSync: string | null;
    configFingerprint?: string;
    configState?: SyncConfigState;
}

export interface ISyncStateProvider {
    /** Vrátí timestamp poslední úspěšné synchronizace (ISO format), nebo null při prvním běhu. */
    getLastSync(): Promise<string | null>;
    
    /** Zapíše nový timestamp (ISO format), volitelně s fingerprintem konfigurace a stavem pravidel. */
    setLastSync(timestamp: string, configFingerprint?: string, configState?: SyncConfigState): Promise<void>;

    /** Vrátí kompletní uložený stav synchronizace včetně konfigurace. */
    getState?(): Promise<SyncStateData | null>;

    /** Uloží kompletní stav synchronizace. */
    saveState?(state: SyncStateData): Promise<void>;
}

export class FileStateProvider implements ISyncStateProvider {
    private readonly filePath: string;

    constructor(filePath?: string) {
        // Výchozí umístění v kořenu projektu
        this.filePath = filePath || path.join(process.cwd(), '.sync_state.json');
    }

    public async getState(): Promise<SyncStateData | null> {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.warn(`[FileStateProvider] Chyba při čtení state:`, error);
        }
        return null;
    }

    public async getLastSync(): Promise<string | null> {
        const state = await this.getState();
        return state?.lastSync || null;
    }

    public async setLastSync(timestamp: string, configFingerprint?: string, configState?: SyncConfigState): Promise<void> {
        const currentState = (await this.getState()) || { lastSync: null };
        const newState: SyncStateData = {
            ...currentState,
            lastSync: timestamp,
            ...(configFingerprint ? { configFingerprint } : {}),
            ...(configState ? { configState } : {})
        };
        await this.saveState(newState);
    }

    public async saveState(state: SyncStateData): Promise<void> {
        try {
            const data = JSON.stringify(state, null, 2);
            fs.writeFileSync(this.filePath, data, 'utf8');
        } catch (error) {
            console.error(`[FileStateProvider] Chyba při zápisu state:`, error);
        }
    }
}
