import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator.ts';
import { ICacheProvider } from '../cloudflare-worker/src/shoptet-api/cache-provider.ts';
import * as fs from 'fs';

// Mock pro ISyncStateProvider
vi.mock('../cloudflare-worker/src/shoptet-api/state-provider.ts', () => {
    return {
        FileStateProvider: class {
            async getLastSync() { return '2026-08-01T00:00:00Z'; }
            async setLastSync() { return undefined; }
        }
    };
});

describe('Incremental Sync Optimization', () => {
    let mockCache: ICacheProvider;
    let originalConsoleLog: any;

    beforeEach(() => {
        mockCache = {
            getPrice: vi.fn().mockResolvedValue(null),
            setPrice: vi.fn().mockResolvedValue(undefined),
            commit: vi.fn().mockResolvedValue(undefined)
        };
        originalConsoleLog = console.log;
    });

    it('should skip Pricing Engine when no products are changed', async () => {
        const logs: string[] = [];
        console.log = vi.fn((msg: string) => {
            logs.push(msg);
        });

        const orchestrator = new SyncOrchestrator({
            dryRun: true,
            token: 'TEST_TOKEN',
            priceCache: mockCache,
            maxPages: 1
        });

        // Mockujeme API clienta uvnitř orchestrátoru
        (orchestrator as any).client.getPricelists = vi.fn().mockResolvedValue([
            { id: 1, name: 'Maloobchodný' },
            { id: 2, name: 'ZR4' }
        ]);
        (orchestrator as any).client.getCustomerGroups = vi.fn().mockResolvedValue([
            { customerGroupCode: 'maloobchod', name: 'Maloobchodný' },
            { customerGroupCode: 'zr4', name: 'ZR4' }
        ]);

        (orchestrator as any).client.getProductChanges = vi.fn().mockResolvedValue([]);
        (orchestrator as any).client.getCustomerChanges = vi.fn().mockResolvedValue([]);
        (orchestrator as any).client.getOrdersByChangeTime = vi.fn().mockResolvedValue([]);
        
        await orchestrator.runFullSync();

        console.log = originalConsoleLog;

        const hasPricingEngineLog = logs.some(l => l && l.includes('Spouštění výpočtu Pricing Engine'));
        const hasOptimizationLog = logs.some(l => l && l.includes('Optimalizace: Žádné produkty ke změně'));
        
        expect(hasPricingEngineLog).toBe(false);
        expect(hasOptimizationLog).toBe(true);
    });
});
