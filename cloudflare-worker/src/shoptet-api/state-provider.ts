import * as fs from 'fs';
import * as path from 'path';

export interface ISyncStateProvider {
    /** Vrátí timestamp poslední úspěšné synchronizace (ISO format), nebo null při prvním běhu. */
    getLastSync(): Promise<string | null>;
    
    /** Zapíše nový timestamp (ISO format). */
    setLastSync(timestamp: string): Promise<void>;
}

export class FileStateProvider implements ISyncStateProvider {
    private readonly filePath: string;

    constructor(filePath?: string) {
        // Výchozí umístění v kořenu projektu
        this.filePath = filePath || path.join(process.cwd(), '.sync_state.json');
    }

    public async getLastSync(): Promise<string | null> {
        try {
            if (fs.existsSync(this.filePath)) {
                const data = fs.readFileSync(this.filePath, 'utf8');
                const parsed = JSON.parse(data);
                return parsed.lastSync || null;
            }
        } catch (error) {
            console.warn(`[FileStateProvider] Chyba při čtení state:`, error);
        }
        return null;
    }

    public async setLastSync(timestamp: string): Promise<void> {
        try {
            const data = JSON.stringify({ lastSync: timestamp }, null, 2);
            fs.writeFileSync(this.filePath, data, 'utf8');
        } catch (error) {
            console.error(`[FileStateProvider] Chyba při zápisu state:`, error);
        }
    }
}
