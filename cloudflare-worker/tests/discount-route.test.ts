import { describe, it, expect, beforeEach } from 'vitest';
import worker, { __resetActiveCustomerVersionCache } from '../src/index.js';
import { Env } from '../src/feed-generator.js';

// `GET /v1/discount/:hash` se volá z prohlížeče každého návštěvníka e-shopu
// (frontend vip_*.js). U nepřihlášeného/neznámého návštěvníka -- nejčastější případ --
// se dřív dělala 3 KV čtení a stejně z toho vypadlo 404. `active_customer_version`
// se teď drží v paměti isolate, takže z toho jsou 2 čtení a další requesty ve stejném
// isolate už verzi vůbec nečtou. Tyhle testy hlídají, že se fallback na starý
// verzovaný klíč nerozbil a že cache opravdu šetří čtení (včetně negative cachingu).

function fakeCtx(): ExecutionContext {
    return { waitUntil: () => { }, passThroughOnException: () => { } } as any;
}

function fakeEnv(store: Record<string, string>, reads: string[]): Env {
    return {
        VIP_KV: {
            get: async (key: string) => {
                reads.push(key);
                return key in store ? store[key] : null;
            },
        },
    } as unknown as Env;
}

async function callDiscount(env: Env, hash: string): Promise<Response> {
    return worker.fetch(new Request(`https://worker.example.test/v1/discount/${hash}`), env, fakeCtx());
}

describe('GET /v1/discount/:hash', () => {
    beforeEach(() => {
        __resetActiveCustomerVersionCache();
    });

    it('vrátí slevu ze stabilního klíče jediným KV čtením', async () => {
        const reads: string[] = [];
        const env = fakeEnv({ 'customer:abc': '15' }, reads);

        const res = await callDiscount(env, 'abc');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ v: 1, discount: 15 });
        expect(reads).toEqual(['customer:abc']);
    });

    it('padne zpět na starý verzovaný klíč (nezmigrovaný zákazník nesmí přijít o slevu)', async () => {
        const reads: string[] = [];
        const env = fakeEnv({
            'active_customer_version': 'v7',
            'customer:v7:abc': '20',
        }, reads);

        const res = await callDiscount(env, 'abc');

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ v: 1, discount: 20 });
        expect(reads).toEqual(['customer:abc', 'active_customer_version', 'customer:v7:abc']);
    });

    it('verzi čte z KV jen jednou -- druhý miss už na ni nesahá', async () => {
        const reads: string[] = [];
        const env = fakeEnv({ 'active_customer_version': 'v7' }, reads);

        expect((await callDiscount(env, 'aaa')).status).toBe(404);
        expect((await callDiscount(env, 'bbb')).status).toBe(404);

        expect(reads.filter(k => k === 'active_customer_version')).toHaveLength(1);
        expect(reads).toEqual([
            'customer:aaa', 'active_customer_version', 'customer:v7:aaa',
            'customer:bbb', 'customer:v7:bbb',
        ]);
    });

    it('cachuje i chybějící verzi (negative caching) -- neznámý návštěvník stojí 1 čtení', async () => {
        const reads: string[] = [];
        const env = fakeEnv({}, reads);

        expect((await callDiscount(env, 'aaa')).status).toBe(404);
        expect((await callDiscount(env, 'bbb')).status).toBe(404);
        expect((await callDiscount(env, 'ccc')).status).toBe(404);

        expect(reads.filter(k => k === 'active_customer_version')).toHaveLength(1);
        expect(reads).toEqual([
            'customer:aaa', 'active_customer_version',
            'customer:bbb',
            'customer:ccc',
        ]);
    });

    it('výpadek KV při čtení verze nezhodí lookup (vrátí 404, ne 500)', async () => {
        const env = {
            VIP_KV: {
                get: async (key: string) => {
                    if (key === 'active_customer_version') throw new Error('KV down');
                    return null;
                },
            },
        } as unknown as Env;

        const res = await callDiscount(env, 'abc');
        expect(res.status).toBe(404);
    });
});
