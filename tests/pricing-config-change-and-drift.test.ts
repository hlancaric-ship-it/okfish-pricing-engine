import { describe, it, expect, vi, beforeEach } from 'vitest';
import Decimal from 'decimal.js';
import {
    canonicalJsonStringify,
    hashObject,
    computePricingConfigFingerprint,
    getModifiedProductCodes,
    detectPricingConfigChanges,
    loadPricingConfigFiles,
    PricingConfigFiles
} from '../cloudflare-worker/src/shoptet-api/pricing-config-fingerprint';
import { SyncOrchestrator } from '../cloudflare-worker/src/shoptet-api/sync-orchestrator';
import { FileStateProvider, ISyncStateProvider, SyncStateData } from '../cloudflare-worker/src/shoptet-api/state-provider';
import { calculateProductsPricing } from '../cloudflare-worker/src/shoptet-api/pricing-bridge';
import { ProductsReader } from '../cloudflare-worker/src/shoptet-api/products-reader';

describe('Pricing Config Fingerprint & Incremental Drift Resolution', () => {
    const baseConfig: PricingConfigFiles = {
        policy: {
            version: '1.0.0',
            loyaltyTiers: { ZR4: 0.04, ZR6: 0.06, ZR10: 0.10, ZR12: 0.12, ZR14: 0.14 },
            brandLimits: { Delphin: 0.15, LOWRANCE: 0.04 }
        },
        productOverrides: {
            '101800': 10,
            '101801': 10
        },
        zeroDiscountProducts: ['46438', '46531'],
        clearanceSaleProducts: {
            '62168': 22
        }
    };

    describe('Fingerprint Determinism & Key-Order Independence', () => {
        it('produces identical canonical strings and hashes regardless of JSON key ordering', () => {
            const configA = {
                b: 2,
                a: 1,
                nested: { z: 100, y: 50 },
                list: ['zebra', 'apple']
            };
            const configB = {
                a: 1,
                b: 2,
                nested: { y: 50, z: 100 },
                list: ['apple', 'zebra']
            };

            const strA = canonicalJsonStringify(configA);
            const strB = canonicalJsonStringify(configB);
            expect(strA).toBe(strB);
            expect(hashObject(configA)).toBe(hashObject(configB));
        });

        it('computes stable fingerprint for complete pricing config', () => {
            const res1 = computePricingConfigFingerprint(baseConfig);
            const res2 = computePricingConfigFingerprint(JSON.parse(JSON.stringify(baseConfig)));
            expect(res1.fingerprint).toBe(res2.fingerprint);
            expect(res1.configState.policyHash).toBe(res2.configState.policyHash);
        });
    });

    describe('Detection of Rule & Override Changes', () => {
        it('1. unchanged pricing config → hasChanges is false, no extra codes', () => {
            const { fingerprint, configState } = computePricingConfigFingerprint(baseConfig);
            const priorState: SyncStateData = {
                lastSync: '2026-08-25T00:00:00+0000',
                configFingerprint: fingerprint,
                configState
            };

            const diff = detectPricingConfigChanges(priorState, baseConfig);
            expect(diff.hasChanges).toBe(false);
            expect(diff.requiresFullReevaluation).toBe(false);
            expect(diff.affectedProductCodes).toEqual([]);
        });

        it('2. product-max-discount-overrides.json modified → only affected products identified', () => {
            const { fingerprint, configState } = computePricingConfigFingerprint(baseConfig);
            const priorState: SyncStateData = {
                lastSync: '2026-08-25T00:00:00+0000',
                configFingerprint: fingerprint,
                configState
            };

            // Add 101821 and modify 101800
            const modifiedConfig: PricingConfigFiles = {
                ...baseConfig,
                productOverrides: {
                    ...baseConfig.productOverrides,
                    '101800': 15, // changed from 10 to 15
                    '101821': 10  // newly added
                }
            };

            const diff = detectPricingConfigChanges(priorState, modifiedConfig);
            expect(diff.hasChanges).toBe(true);
            expect(diff.requiresFullReevaluation).toBe(false);
            expect(diff.affectedProductCodes).toContain('101800');
            expect(diff.affectedProductCodes).toContain('101821');
            expect(diff.affectedProductCodes).not.toContain('101801'); // unchanged product
        });

        it('3. override removed → affected product is included to restore standard pricing', () => {
            const { fingerprint, configState } = computePricingConfigFingerprint(baseConfig);
            const priorState: SyncStateData = {
                lastSync: '2026-08-25T00:00:00+0000',
                configFingerprint: fingerprint,
                configState
            };

            // Remove 101800 from overrides
            const modifiedConfig: PricingConfigFiles = {
                ...baseConfig,
                productOverrides: {
                    '101801': 10
                }
            };

            const diff = detectPricingConfigChanges(priorState, modifiedConfig);
            expect(diff.hasChanges).toBe(true);
            expect(diff.affectedProductCodes).toEqual(['101800']);
        });

        it('4. zero-discount-products.json and clearance-sale-products.json changes detected accurately', () => {
            const { fingerprint, configState } = computePricingConfigFingerprint(baseConfig);
            const priorState: SyncStateData = {
                lastSync: '2026-08-25T00:00:00+0000',
                configFingerprint: fingerprint,
                configState
            };

            const modifiedConfig: PricingConfigFiles = {
                ...baseConfig,
                zeroDiscountProducts: ['46438', '99999'], // 46531 removed, 99999 added
                clearanceSaleProducts: {
                    '62168': 30, // changed discount
                    '88888': 20  // new clearance
                }
            };

            const diff = detectPricingConfigChanges(priorState, modifiedConfig);
            expect(diff.hasChanges).toBe(true);
            expect(diff.affectedProductCodes).toContain('46531');
            expect(diff.affectedProductCodes).toContain('99999');
            expect(diff.affectedProductCodes).toContain('62168');
            expect(diff.affectedProductCodes).toContain('88888');
        });

        it('5. global policy change (policy-v1.json) → triggers full catalog re-evaluation', () => {
            const { fingerprint, configState } = computePricingConfigFingerprint(baseConfig);
            const priorState: SyncStateData = {
                lastSync: '2026-08-25T00:00:00+0000',
                configFingerprint: fingerprint,
                configState
            };

            const modifiedPolicyConfig: PricingConfigFiles = {
                ...baseConfig,
                policy: {
                    ...baseConfig.policy,
                    brandLimits: { ...baseConfig.policy.brandLimits, Delphin: 0.10 } // changed brand limit
                }
            };

            const diff = detectPricingConfigChanges(priorState, modifiedPolicyConfig);
            expect(diff.hasChanges).toBe(true);
            expect(diff.requiresFullReevaluation).toBe(true);
        });

        it('6. bootstrap (no prior lastSync and no fingerprint) → triggers full reevaluation', () => {
            const priorState: SyncStateData = {
                lastSync: null
            };

            const diff = detectPricingConfigChanges(priorState, baseConfig);
            expect(diff.hasChanges).toBe(true);
            expect(diff.requiresFullReevaluation).toBe(true);
            expect(diff.currentFingerprint).toBeDefined();
        });

        it('6b. migration (prior lastSync but no fingerprint) → initializes fingerprint without forcing full reevaluation', () => {
            const priorState: SyncStateData = {
                lastSync: '2026-08-25T00:00:00+0000'
            };

            const diff = detectPricingConfigChanges(priorState, baseConfig);
            expect(diff.hasChanges).toBe(false);
            expect(diff.requiresFullReevaluation).toBe(false);
            expect(diff.currentFingerprint).toBeDefined();
        });
    });

    describe('ProductsReader Integration with Extra Affected Codes', () => {
        it('7. fetches product unchanged in Shoptet changes API when passed via extraCodes', async () => {
            const mockClient = {
                getProductChanges: vi.fn().mockResolvedValue([]), // zero Shoptet changes!
                getPricelistItemByCode: vi.fn().mockImplementation((pricelistId: number, code: string) => {
                    if (code === '101800') {
                        return Promise.resolve({
                            code: '101800',
                            price: { price: '752.84' },
                            sales: { minPriceRatio: '1.0' },
                            vatRate: '23.00',
                            includingVat: true
                        });
                    }
                    return Promise.resolve(null);
                })
            } as any;

            const reader = new ProductsReader(mockClient);
            const result = await reader.fetchProducts(1, undefined, '2026-08-25T00:00:00+0000', ['101800']);

            expect(result.products).toHaveLength(1);
            expect(result.products[0].code).toBe('101800');
            expect(result.products[0].price.toNumber()).toBe(752.84);
            expect(mockClient.getPricelistItemByCode).toHaveBeenCalledWith(1, '101800');
        });

        it('8. missing item on base pricelist is reported via incompleteCodes', async () => {
            const mockClient = {
                getProductChanges: vi.fn().mockResolvedValue([]),
                getPricelistItemByCode: vi.fn().mockResolvedValue(null)
            } as any;

            const reader = new ProductsReader(mockClient);
            const result = await reader.fetchProducts(1, undefined, '2026-08-25T00:00:00+0000', ['NON_EXISTENT']);

            expect(result.products).toHaveLength(0);
            expect(result.incompleteCodes).toContain('NON_EXISTENT');
        });
    });

    describe('End-to-End Orchestrator Drift Resolution (Mocked API)', () => {
        it('9. unchanged products + changed override → orchestrator recalculates and patches Shoptet diff', async () => {
            const liveConfig = loadPricingConfigFiles();
            const liveConfigInfo = computePricingConfigFingerprint(liveConfig);

            const mockPriceCache = {
                // Previously cached uncapped price for ZR12 was 662.50
                getPrice: vi.fn().mockImplementation((plId: number, code: string) => {
                    if (plId === 3 && code === '101800') return Promise.resolve('662.50');
                    return Promise.resolve(null);
                }),
                setPrice: vi.fn().mockResolvedValue(undefined),
                commit: vi.fn().mockResolvedValue(undefined)
            };

            // Simulate prior state that had the same policy-v1.json hash, but 101800 was not in productOverrides
            const mockStateProvider = {
                getState: vi.fn().mockResolvedValue({
                    lastSync: '2026-08-25T00:00:00+0000',
                    configFingerprint: 'prior-different-fingerprint',
                    configState: {
                        ...liveConfigInfo.configState,
                        productOverrides: {
                            ...liveConfigInfo.configState.productOverrides,
                            '101800': 25 // old override was 25% (or missing)
                        }
                    }
                }),
                getLastSync: vi.fn().mockResolvedValue('2026-08-25T00:00:00+0000'),
                setLastSync: vi.fn().mockResolvedValue(undefined)
            };

            const orchestrator = new SyncOrchestrator({
                dryRun: false,
                token: 'TEST_TOKEN',
                priceCache: mockPriceCache,
                stateProvider: mockStateProvider
            });

            // Mock client APIs
            (orchestrator as any).client.getPricelists = vi.fn().mockResolvedValue([
                { id: 1, name: 'Maloobchodný' },
                { id: 3, name: 'ZR12' }
            ]);
            (orchestrator as any).client.getCustomerGroups = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getProductChanges = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getCustomerChanges = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getOrdersByChangeTime = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getPricelistProducts = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getPricelistItemByCode = vi.fn().mockResolvedValue({
                code: '101800',
                price: { price: '752.84' },
                sales: { minPriceRatio: '1.0' },
                vatRate: '23.00',
                includingVat: true
            });
            (orchestrator as any).client.updatePricelistBatch = vi.fn().mockResolvedValue({
                requestId: 'req-1',
                response: 'OK',
                timestamp: 'now',
                status: 200,
                endpoint: '/pricelists/3'
            });

            await orchestrator.runFullSync();

            // Verify updatePricelistBatch was called for ZR12 with capped price (677.56)
            expect((orchestrator as any).client.updatePricelistBatch).toHaveBeenCalled();
            const patchCall = (orchestrator as any).client.updatePricelistBatch.mock.calls[0];
            expect(patchCall[0]).toBe(3); // ZR12 pricelist
            expect(patchCall[1][0].code).toBe('101800');
            expect(patchCall[1][0].price).toBe('677.56'); // 752.84 - 10%

            // Verify new fingerprint saved
            expect(mockStateProvider.setLastSync).toHaveBeenCalled();
        });

        it('10. unchanged product + unchanged config → no updates and no API patches dispatched', async () => {
            const liveConfig = loadPricingConfigFiles();
            const liveConfigInfo = computePricingConfigFingerprint(liveConfig);

            const mockPriceCache = {
                getPrice: vi.fn().mockResolvedValue('677.56'), // Cache matches expected price
                setPrice: vi.fn().mockResolvedValue(undefined),
                commit: vi.fn().mockResolvedValue(undefined)
            };

            const mockStateProvider = {
                getState: vi.fn().mockResolvedValue({
                    lastSync: '2026-08-25T00:00:00+0000',
                    configFingerprint: liveConfigInfo.fingerprint,
                    configState: liveConfigInfo.configState
                }),
                getLastSync: vi.fn().mockResolvedValue('2026-08-25T00:00:00+0000'),
                setLastSync: vi.fn().mockResolvedValue(undefined)
            };

            const orchestrator = new SyncOrchestrator({
                dryRun: false,
                token: 'TEST_TOKEN',
                priceCache: mockPriceCache,
                stateProvider: mockStateProvider
            });

            (orchestrator as any).client.getPricelists = vi.fn().mockResolvedValue([
                { id: 1, name: 'Maloobchodný' },
                { id: 3, name: 'ZR12' }
            ]);
            (orchestrator as any).client.getCustomerGroups = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getProductChanges = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getCustomerChanges = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getOrdersByChangeTime = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.getPricelistProducts = vi.fn().mockResolvedValue([]);
            (orchestrator as any).client.updatePricelistBatch = vi.fn();

            await orchestrator.runFullSync();

            // Zero product updates sent to Shoptet API
            expect((orchestrator as any).client.updatePricelistBatch).not.toHaveBeenCalled();
        });
    });

    describe('Pricing Engine Mathematical Consistency', () => {
        it('11. pricing calculation produces exact expected discount with override', () => {
            const products = [
                {
                    code: '101800',
                    basePrice: 752.84
                }
            ];
            const pricelists = [
                { id: 1, name: 'ZR4' },
                { id: 2, name: 'ZR10' },
                { id: 3, name: 'ZR12' },
                { id: 4, name: 'ZR25' }
            ];

            const { results, failures } = calculateProductsPricing(products, pricelists);
            expect(failures).toHaveLength(0);
            expect(results).toHaveLength(1);

            const prices = results[0].prices;
            // 101800 has 10% override in product-max-discount-overrides.json
            // ZR4 (4% < 10%): 752.84 * 0.96 = 722.7264 -> 722.7300
            expect(prices['ZR4']).toBe('722.7300');
            // ZR10 (10% == 10%): 752.84 * 0.90 = 677.5560 -> 677.5600
            expect(prices['ZR10']).toBe('677.5600');
            // ZR12 (12% > 10%): capped at 10% -> 677.5600
            expect(prices['ZR12']).toBe('677.5600');
            // ZR25 (25% > 10%): capped at 10% -> 677.5600
            expect(prices['ZR25']).toBe('677.5600');
        });
    });
});
