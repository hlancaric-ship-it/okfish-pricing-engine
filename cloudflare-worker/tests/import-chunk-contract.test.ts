import { describe, it, expect, vi, afterEach } from 'vitest';
import worker from '../src/index.js';
import { Env } from '../src/feed-generator.js';
import { RemoteCustomerCache } from '../src/shoptet-api/customer-cache.js';

// PROČ TENHLE TEST EXISTUJE:
// 194 sync běhů v řadě selhalo na 100 % a ANI JEDEN test nezčervenal. Důvod: klient
// (RemoteCustomerCache.commit) posílal na POST /v1/import/chunk payload { customers: [...] }
// bez pole `version`, zatímco nasazený Worker handler `version` VYŽADOVAL a bez něj
// vracel 400. Klient i server byly každý sám o sobě otestovaný — chyběl test, který
// je propojí. Tenhle soubor je přesně ten chybějící článek: vezme REÁLNÉ tělo requestu,
// které klient odešle, a nakrmí ho PŘÍMO do fetch handleru z index.ts.
//
// Když někdo v budoucnu změní tvar payloadu na jedné straně a ne na druhé, spadne tohle,
// ne produkce.

const SECRET_TOKEN = 'shoptet-vip-secret-12345'; // musí sedět s index.ts checkAuth()

/** Mock KV — in-memory Map se stejným get/put rozhraním jako VIP_KV. */
function fakeKv() {
    const store = new Map<string, string>();
    return {
        store,
        get: vi.fn(async (key: string) => (store.has(key) ? store.get(key)! : null)),
        put: vi.fn(async (key: string, value: string) => { store.set(key, value); }),
    };
}

function fakeEnv(kv: ReturnType<typeof fakeKv>): Env {
    return { VIP_KV: kv } as unknown as Env;
}

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => {}, passThroughOnException: () => {} } as any;
}

/**
 * Spustí RemoteCustomerCache.commit() proti mocknutému fetch a vrátí to, co klient
 * SKUTEČNĚ poslal na drát (URL, hlavičky, tělo).
 */
async function captureClientRequest(customers: Array<{ email: string; discount: number }>) {
    const captured: Array<{ url: string; init: RequestInit }> = [];

    const fetchMock = vi.fn(async (url: any, init: any) => {
        captured.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true, written: 0, skipped: 0 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        });
    });
    vi.stubGlobal('fetch', fetchMock);

    const cache = new RemoteCustomerCache('https://worker.example.test', SECRET_TOKEN);
    for (const c of customers) {
        await cache.setCustomerDiscount(c.email, c.discount);
    }
    await cache.commit('v-2026-09-06', true);

    return captured;
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('kontrakt klient <-> server na POST /v1/import/chunk', () => {
    it('klient posílá { customers: [...] } na správnou URL s Bearer tokenem', async () => {
        const captured = await captureClientRequest([
            { email: 'Test@Example.com', discount: 12 },
        ]);

        expect(captured).toHaveLength(1);
        expect(captured[0].url).toBe('https://worker.example.test/v1/import/chunk');
        expect(captured[0].init.method).toBe('POST');
        expect((captured[0].init.headers as any)['Authorization']).toBe(`Bearer ${SECRET_TOKEN}`);

        const body = JSON.parse(captured[0].init.body as string);
        expect(Array.isArray(body.customers)).toBe(true);
        expect(body.customers[0]).toHaveProperty('hash');
        expect(body.customers[0]).toHaveProperty('discount', 12);
    });

    it('reálné tělo od klienta projde serverem s HTTP 200 (ne 400 jako při 194 selháních)', async () => {
        const captured = await captureClientRequest([
            { email: 'Test@Example.com', discount: 12 },
            { email: 'druhy@example.com', discount: 25 },
        ]);
        const clientBody = captured[0].init.body as string;

        // Stub fetch pryč — teď voláme handler přímo, ne přes síť.
        vi.unstubAllGlobals();

        const kv = fakeKv();
        const req = new Request('https://worker.example.test/v1/import/chunk', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SECRET_TOKEN}`,
            },
            body: clientBody,
        });
        const res = await worker.fetch(req, fakeEnv(kv), fakeCtx());

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.ok).toBe(true);
        expect(data.count).toBe(2);
        expect(data.written).toBe(2);
        expect(data.skipped).toBe(0);
    });

    it('zapisuje pod stabilní klíč customer:${hash}, NE customer:${version}:${hash}', async () => {
        const captured = await captureClientRequest([{ email: 'Test@Example.com', discount: 12 }]);
        const clientBody = captured[0].init.body as string;
        const sentHash = JSON.parse(clientBody).customers[0].hash;
        vi.unstubAllGlobals();

        const kv = fakeKv();
        const req = new Request('https://worker.example.test/v1/import/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET_TOKEN}` },
            body: clientBody,
        });
        await worker.fetch(req, fakeEnv(kv), fakeCtx());

        // Přesně jeden zápis, přesně pod stabilním klíčem.
        expect(kv.put).toHaveBeenCalledTimes(1);
        expect(kv.put).toHaveBeenCalledWith(`customer:${sentHash}`, '12');
        expect([...kv.store.keys()]).toEqual([`customer:${sentHash}`]);
        // Žádný klíč nesmí obsahovat verzi — frontend /v1/discount/:hash čte stabilní klíč.
        for (const key of kv.store.keys()) {
            expect(key).not.toContain('v-2026-09-06');
        }
    });

    it('hash je SHA-256 z normalizovaného emailu (trim + lowercase) — sedí s /v1/discount/:hash', async () => {
        const captured = await captureClientRequest([{ email: '  Test@Example.COM  ', discount: 7 }]);
        const sentHash = JSON.parse(captured[0].init.body as string).customers[0].hash;
        vi.unstubAllGlobals();

        const expected = Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('test@example.com')))
        ).map(b => b.toString(16).padStart(2, '0')).join('');

        expect(sentHash).toBe(expected);
    });

    it('beze změny hodnoty server přeskočí zápis (diff-aware, šetří KV write kvótu)', async () => {
        const captured = await captureClientRequest([{ email: 'test@example.com', discount: 12 }]);
        const clientBody = captured[0].init.body as string;
        const sentHash = JSON.parse(clientBody).customers[0].hash;
        vi.unstubAllGlobals();

        const kv = fakeKv();
        kv.store.set(`customer:${sentHash}`, '12'); // stejná hodnota už v KV je

        const req = new Request('https://worker.example.test/v1/import/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET_TOKEN}` },
            body: clientBody,
        });
        const res = await worker.fetch(req, fakeEnv(kv), fakeCtx());

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.written).toBe(0);
        expect(data.skipped).toBe(1);
        expect(kv.put).not.toHaveBeenCalled();
    });

    it('kontrakt je zpětně tolerantní: starý payload s `version` navíc projde taky (200, version ignorována)', async () => {
        // Kdyby někde běžel starý klient (nebo se `version` vrátila), server ho nesmí
        // odmítnout — extra pole se ignoruje a klíče zůstávají stabilní.
        const kv = fakeKv();
        const hash = 'a'.repeat(64);
        const legacyBody = JSON.stringify({
            version: 'v-2026-08-01',
            customers: [{ hash, discount: 30 }],
        });

        const req = new Request('https://worker.example.test/v1/import/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET_TOKEN}` },
            body: legacyBody,
        });
        const res = await worker.fetch(req, fakeEnv(kv), fakeCtx());

        expect(res.status).toBe(200);
        const data = await res.json() as any;
        expect(data.ok).toBe(true);
        expect(data.written).toBe(1);
        expect(kv.put).toHaveBeenCalledWith(`customer:${hash}`, '30');
        // `version` se NESMÍ propsat do klíče.
        expect([...kv.store.keys()]).toEqual([`customer:${hash}`]);
    });

    it('skutečně vadný payload (chybí `customers`) stále vrací 400 — tolerance neznamená slepotu', async () => {
        const kv = fakeKv();
        const req = new Request('https://worker.example.test/v1/import/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET_TOKEN}` },
            body: JSON.stringify({ version: 'v1' }),
        });
        const res = await worker.fetch(req, fakeEnv(kv), fakeCtx());

        expect(res.status).toBe(400);
        expect(kv.put).not.toHaveBeenCalled();
    });

    it('bez Authorization hlavičky je to 401 (import endpoint není veřejný)', async () => {
        const kv = fakeKv();
        const req = new Request('https://worker.example.test/v1/import/chunk', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ customers: [] }),
        });
        const res = await worker.fetch(req, fakeEnv(kv), fakeCtx());

        expect(res.status).toBe(401);
        expect(kv.put).not.toHaveBeenCalled();
    });

    it('nad 250 zákazníků klient dávkuje a KAŽDÁ dávka je samostatně validní payload', async () => {
        const many = Array.from({ length: 260 }, (_, i) => ({ email: `u${i}@example.com`, discount: 5 }));
        const captured = await captureClientRequest(many);
        expect(captured).toHaveLength(2); // BATCH_SIZE = 250 -> 250 + 10
        vi.unstubAllGlobals();

        let totalWritten = 0;
        const kv = fakeKv();
        for (const c of captured) {
            const req = new Request('https://worker.example.test/v1/import/chunk', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SECRET_TOKEN}` },
                body: c.init.body as string,
            });
            const res = await worker.fetch(req, fakeEnv(kv), fakeCtx());
            expect(res.status).toBe(200);
            totalWritten += (await res.json() as any).written;
        }
        expect(totalWritten).toBe(260);
        expect(kv.store.size).toBe(260);
    });
});
