import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator';
import { GlobalStats } from '../cloudflare-worker/src/shoptet-api/client';

describe('Kontrolovaný produkční běh (Simulace)', () => {
    let orchestrator: SyncOrchestrator;
    let mockCacheProvider: any;

    beforeEach(() => {
        // Reset globálních metrik před každým během
        GlobalStats.apiRequests = { GET: 0, PATCH: 0 };
        GlobalStats.httpResponses = {};
        GlobalStats.retries = {};
        GlobalStats.auditLogs = 0;
        GlobalStats.rollbackSnapshots = 0;
        GlobalStats.turnoverCalculated = 0;
        GlobalStats.ordersLoaded = 0;

        mockCacheProvider = {
            getPrice: vi.fn(),
            setPrice: vi.fn(),
            commit: vi.fn()
        };

        orchestrator = new SyncOrchestrator({
            dryRun: true, // v testu pustíme DRY RUN, abychom viděli logy a průběh
            token: 'test-token',
            priceCache: mockCacheProvider,
            maxPages: 1
        });
    });

    it('Scénář: 1 změněný produkt, 1 změněný zákazník, 1 změněná objednávka', async () => {
        // Zafixujeme čas začátku testu
        const now = Date.now();
        const mockLastSync = new Date(now - 10 * 60 * 1000).toISOString(); // 10 minut zpět

        // Mockujeme getLastSync
        const mockStateProvider = {
            getLastSync: vi.fn().mockResolvedValue(mockLastSync),
            setLastSync: vi.fn().mockResolvedValue(undefined)
        };
        // Dependency Injection pro stateProvider by bylo hezčí, ale orchestrator instanciuje FileStateProvider napřímo.
        // Obejdeme to zafixováním vnitřních metod apiClienta.

        // MOCK API CLIENTA (První běh)
        (orchestrator as any).client.getPricelists = vi.fn().mockResolvedValue([
            { id: 1, name: 'Maloobchodný' },
            { id: 2, name: 'Velkoobchod' },
            { id: 3, name: 'ZR10' },
            { id: 4, name: 'ZR14' }
        ]);
        (orchestrator as any).client.getCustomerGroups = vi.fn().mockResolvedValue([
            { customerGroupCode: 'maloobchod', name: 'Maloobchodný' },
            { customerGroupCode: 'velkoobchod', name: 'Velkoobchod' },
            { customerGroupCode: 'ZR10', name: 'ZR10' },
            { customerGroupCode: 'ZR14', name: 'ZR14' }
        ]);

        // MOCK: Produkty (1 změněný produkt)
        (orchestrator as any).client.getProductChanges = vi.fn().mockResolvedValue([
            { guid: 'prod-guid-1', changeTime: 'now' }
        ]);
        (orchestrator as any).client.getProducts = vi.fn().mockResolvedValue([
            { code: 'PROD1', price: '100' }
        ]);
        (orchestrator as any).client.getProductDetail = vi.fn().mockResolvedValue({
            code: 'PROD1',
            price: { withVat: "100" }
        });

        // MOCK: Zákazníci (1 změněný zákazník a 1 změněná objednávka)
        (orchestrator as any).client.getCustomerChanges = vi.fn().mockResolvedValue([
            { guid: 'cust-guid-1', changeTime: 'now' }
        ]);
        
        (orchestrator as any).client.getOrdersByChangeTime = vi.fn().mockResolvedValue([
            { code: 'ORD1', customerGuid: 'cust-guid-2' } // Další dotčený zákazník z objednávky
        ]);

        // MOCK: Historie objednávek (pouze pro 2 dotčené zákazníky!)
        (orchestrator as any).client.getCustomerOrders = vi.fn().mockImplementation((guid: string) => {
            if (guid === 'cust-guid-1') return Promise.resolve([{ status: { id: -3 }, paid: true, price: { withVat: 500 }, customerGuid: 'cust-guid-1' }]);
            if (guid === 'cust-guid-2') return Promise.resolve([{ status: { id: -3 }, paid: true, price: { withVat: 1000 }, customerGuid: 'cust-guid-2' }]);
            return Promise.resolve([]);
        });

        (orchestrator as any).client.getAllOrders = vi.fn().mockResolvedValue([]);
        (orchestrator as any).client.getCustomers = vi.fn().mockResolvedValue([]);
        (orchestrator as any).client.getCustomerDetail = vi.fn().mockImplementation((guid: string) => {
            return Promise.resolve({ 
                customerGroup: { name: 'Maloobchodný' },
                accounts: [{ email: `${guid}@example.com` }]
            });
        });

        // Simulujeme zachycení konzole, abychom ověřili průběh
        const consoleSpy = vi.spyOn(console, 'log');

        // BĚH 1: ZMĚNY
        await orchestrator.runFullSync();

        // OVĚŘENÍ BĚHU 1
        expect((orchestrator as any).client.getOrdersByChangeTime).toHaveBeenCalled(); // Volal se inkrement
        expect((orchestrator as any).client.getAllOrders).not.toHaveBeenCalled(); // Nikdy se nevolal Fallback!
        
        // Zákazníci se dotazovali jen 2x (pro cust-guid-1 a cust-guid-2)
        expect((orchestrator as any).client.getCustomerOrders).toHaveBeenCalledTimes(2);

        // Zkontrolujeme z logů, zda to vypsalo správné informace (idempotence, optimalizace)
        const logs = consoleSpy.mock.calls.map(c => c[0]).join('\n');
        expect(logs).toContain('INKREMENTÁLNÍ MÓD');
        expect(logs).toContain('Po spojení máme 2 dotčených zákazníků');
        expect(logs).toContain('Stahuji celoživotní historii objednávek POUZE pro dotčené zákazníky');

        // -------------------------------------------------------------
        // BĚH 2: IDEMPOTENCE A NULOVÉ ZMĚNY (Simulujeme ihned po prvním)
        // -------------------------------------------------------------
        consoleSpy.mockClear();
        GlobalStats.ordersLoaded = 0;
        GlobalStats.apiRequests = { GET: 0, PATCH: 0 };
        
        // MOCK API CLIENTA (Druhý běh - žádné změny)
        (orchestrator as any).client.getProductChanges = vi.fn().mockResolvedValue([]);
        (orchestrator as any).client.getCustomerChanges = vi.fn().mockResolvedValue([]);
        (orchestrator as any).client.getOrdersByChangeTime = vi.fn().mockResolvedValue([]);
        ((orchestrator as any).client.getCustomerOrders as any).mockClear();
        
        await orchestrator.runFullSync();

        // OVĚŘENÍ BĚHU 2
        const logs2 = consoleSpy.mock.calls.map(c => c[0]).join('\n');
        
        expect(logs2).toContain('Žádné změny u zákazníků ani objednávek');
        expect((orchestrator as any).client.getCustomerOrders).not.toHaveBeenCalled(); // Nenačítala se historie!
        expect(GlobalStats.apiRequests.PATCH).toBe(0); // 0 PATCH požadavků
        expect(GlobalStats.ordersLoaded).toBe(0);
        
        consoleSpy.mockRestore();
    });
});
