import { describe, it, expect } from 'vitest';
import { getLoyaltyTier } from '../../src/core/config.js';

describe('Loyalty Tier Calculation', () => {
    it('should assign ZR4 for turnover 0 to 99.99', () => {
        expect(getLoyaltyTier(0).tier).toBe('ZR4');
        expect(getLoyaltyTier(50).tier).toBe('ZR4');
        expect(getLoyaltyTier(99.99).tier).toBe('ZR4');
    });

    it('should assign ZR6 for turnover 100 to 299.99', () => {
        expect(getLoyaltyTier(100).tier).toBe('ZR6');
        expect(getLoyaltyTier(200).tier).toBe('ZR6');
        expect(getLoyaltyTier(299.99).tier).toBe('ZR6');
    });

    it('should assign ZR8 for turnover 300 to 499.99', () => {
        expect(getLoyaltyTier(300).tier).toBe('ZR8');
        expect(getLoyaltyTier(499.99).tier).toBe('ZR8');
    });

    it('should assign ZR10 for turnover 500 to 699.99', () => {
        expect(getLoyaltyTier(500).tier).toBe('ZR10');
        expect(getLoyaltyTier(699.99).tier).toBe('ZR10');
    });

    it('should assign ZR12 for turnover 700 to 999.99', () => {
        expect(getLoyaltyTier(700).tier).toBe('ZR12');
        expect(getLoyaltyTier(999.99).tier).toBe('ZR12');
    });

    it('should assign ZR14 for turnover 1000 to 1999.99', () => {
        expect(getLoyaltyTier(1000).tier).toBe('ZR14');
        expect(getLoyaltyTier(1999.99).tier).toBe('ZR14');
    });

    it('should assign ZR16 for turnover 2000 to 4999.99', () => {
        expect(getLoyaltyTier(2000).tier).toBe('ZR16');
        expect(getLoyaltyTier(4999.99).tier).toBe('ZR16');
    });

    it('should assign ZR18 for turnover 5000 to 6999.99', () => {
        expect(getLoyaltyTier(5000).tier).toBe('ZR18');
        expect(getLoyaltyTier(6999.99).tier).toBe('ZR18');
    });

    it('should assign ZR20 for turnover 7000 to 9999.99', () => {
        expect(getLoyaltyTier(7000).tier).toBe('ZR20');
        expect(getLoyaltyTier(9999.99).tier).toBe('ZR20');
    });

    it('should assign ZR25 for turnover 10000 and above', () => {
        expect(getLoyaltyTier(10000).tier).toBe('ZR25');
        expect(getLoyaltyTier(50000).tier).toBe('ZR25');
    });

    it('should fallback to ZR4 for negative turnover', () => {
        expect(getLoyaltyTier(-100).tier).toBe('ZR4');
    });
});
