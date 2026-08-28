import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { SyncConfigState, SyncStateData } from './state-provider';

export interface PricingConfigFiles {
    policy: Record<string, any>;
    productOverrides: Record<string, number>;
    zeroDiscountProducts: string[];
    clearanceSaleProducts: Record<string, any>;
}

export interface ConfigChangeDetectionResult {
    hasChanges: boolean;
    requiresFullReevaluation: boolean;
    affectedProductCodes: string[];
    currentFingerprint: string;
    currentConfigState: SyncConfigState;
    changeSummary: string;
}

/**
 * Deterministic JSON stringifier:
 * - Recursively sorts object keys
 * - Sorts primitive arrays (strings, numbers)
 * - Guarantees identical output regardless of key insertion order in JSON files
 */
export function canonicalJsonStringify(obj: any): string {
    if (obj === null || typeof obj !== 'object') {
        return JSON.stringify(obj);
    }
    if (Array.isArray(obj)) {
        const isPrimitiveArray = obj.every(x => typeof x === 'string' || typeof x === 'number');
        const items = obj.map(item => canonicalJsonStringify(item));
        if (isPrimitiveArray) {
            items.sort();
        }
        return `[${items.join(',')}]`;
    }
    const keys = Object.keys(obj).sort();
    const entries = keys.map(k => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
    return `{${entries.join(',')}}`;
}

export function hashObject(obj: any): string {
    const canonical = canonicalJsonStringify(obj);
    return crypto.createHash('sha256').update(canonical).digest('hex');
}

export function loadPricingConfigFiles(baseDir?: string): PricingConfigFiles {
    const root = baseDir || process.cwd();
    const policiesDir = path.resolve(root, 'src/config/policies');

    const readJson = (fileName: string, fallback: any) => {
        const filePath = path.join(policiesDir, fileName);
        try {
            if (fs.existsSync(filePath)) {
                return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            }
        } catch (e) {
            console.warn(`[ConfigFingerprint] Nepodařilo se načíst ${filePath}:`, e);
        }
        return fallback;
    };

    return {
        policy: readJson('policy-v1.json', {}),
        productOverrides: readJson('product-max-discount-overrides.json', {}),
        zeroDiscountProducts: readJson('zero-discount-products.json', []),
        clearanceSaleProducts: readJson('clearance-sale-products.json', {})
    };
}

export function computePricingConfigFingerprint(configs: PricingConfigFiles): {
    fingerprint: string;
    configState: SyncConfigState;
} {
    const policyHash = hashObject(configs.policy);
    const overridesHash = hashObject(configs.productOverrides);
    const zeroDiscountHash = hashObject(configs.zeroDiscountProducts);
    const clearanceSaleHash = hashObject(configs.clearanceSaleProducts);

    const overallFingerprint = crypto.createHash('sha256').update(
        canonicalJsonStringify({
            policyHash,
            overridesHash,
            zeroDiscountHash,
            clearanceSaleHash
        })
    ).digest('hex');

    const configState: SyncConfigState = {
        policyHash,
        productOverrides: configs.productOverrides,
        zeroDiscountProducts: configs.zeroDiscountProducts,
        clearanceSaleProducts: configs.clearanceSaleProducts
    };

    return {
        fingerprint: overallFingerprint,
        configState
    };
}

export function getModifiedProductCodes(
    priorState: SyncConfigState | undefined,
    currentConfig: PricingConfigFiles
): string[] {
    const affectedCodes = new Set<string>();
    if (!priorState) return [];

    // 1. product-max-discount-overrides
    const priorOverrides = priorState.productOverrides || {};
    const currOverrides = currentConfig.productOverrides || {};
    const allOverrideKeys = new Set([...Object.keys(priorOverrides), ...Object.keys(currOverrides)]);
    for (const key of allOverrideKeys) {
        if (priorOverrides[key] !== currOverrides[key]) {
            affectedCodes.add(key);
        }
    }

    // 2. zero-discount-products
    const priorZero = new Set(priorState.zeroDiscountProducts || []);
    const currZero = new Set(currentConfig.zeroDiscountProducts || []);
    const allZeroKeys = new Set([...priorZero, ...currZero]);
    for (const key of allZeroKeys) {
        if (priorZero.has(key) !== currZero.has(key)) {
            affectedCodes.add(key);
        }
    }

    // 3. clearance-sale-products
    const priorClearance = priorState.clearanceSaleProducts || {};
    const currClearance = currentConfig.clearanceSaleProducts || {};
    const allClearanceKeys = new Set([...Object.keys(priorClearance), ...Object.keys(currClearance)]);
    for (const key of allClearanceKeys) {
        const priorVal = canonicalJsonStringify(priorClearance[key]);
        const currVal = canonicalJsonStringify(currClearance[key]);
        if (priorVal !== currVal) {
            affectedCodes.add(key);
        }
    }

    return Array.from(affectedCodes).sort();
}

export function detectPricingConfigChanges(
    priorStateData: SyncStateData | null | undefined,
    loadedConfigs?: PricingConfigFiles
): ConfigChangeDetectionResult {
    const configs = loadedConfigs || loadPricingConfigFiles();
    const { fingerprint, configState } = computePricingConfigFingerprint(configs);

    // První běh (žádný lastSync ani fingerprint)
    if (!priorStateData || (!priorStateData.configFingerprint && !priorStateData.lastSync)) {
        return {
            hasChanges: true,
            requiresFullReevaluation: true,
            affectedProductCodes: [],
            currentFingerprint: fingerprint,
            currentConfigState: configState,
            changeSummary: 'Inicializace fingerprintu konfigurace (první běh / bootstrap)'
        };
    }

    // Stav má existující lastSync, ale ještě nemá uložený fingerprint (migrace staršího .sync_state.json)
    if (!priorStateData.configFingerprint) {
        return {
            hasChanges: false,
            requiresFullReevaluation: false,
            affectedProductCodes: [],
            currentFingerprint: fingerprint,
            currentConfigState: configState,
            changeSummary: 'Inicializace fingerprintu konfigurace ze stávajícího inkrementálního stavu'
        };
    }

    // Žádná změna
    if (priorStateData.configFingerprint === fingerprint) {
        return {
            hasChanges: false,
            requiresFullReevaluation: false,
            affectedProductCodes: [],
            currentFingerprint: fingerprint,
            currentConfigState: configState,
            changeSummary: 'Konfigurace je beze změny'
        };
    }

    // Změna v globální politice (policy-v1.json)
    if (priorStateData.configState?.policyHash !== configState.policyHash) {
        return {
            hasChanges: true,
            requiresFullReevaluation: true,
            affectedProductCodes: [],
            currentFingerprint: fingerprint,
            currentConfigState: configState,
            changeSummary: 'Změna globální pricing policy (policy-v1.json) — vyžaduje kompletní přepočet katalogu'
        };
    }

    // Změna v per-produktových pravidlech / overrides
    const affectedCodes = getModifiedProductCodes(priorStateData.configState, configs);
    return {
        hasChanges: true,
        requiresFullReevaluation: false,
        affectedProductCodes: affectedCodes,
        currentFingerprint: fingerprint,
        currentConfigState: configState,
        changeSummary: `Změna per-produktových pravidel pro ${affectedCodes.length} kódů: ${affectedCodes.join(', ')}`
    };
}
