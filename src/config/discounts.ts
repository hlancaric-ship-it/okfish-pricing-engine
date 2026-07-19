import Decimal from 'decimal.js';
import { CustomerTier } from '../core/interfaces.js';

export const DISCOUNT_MAP: Record<CustomerTier, Decimal> = {
    "ZR4": new Decimal("0.04"),
    "ZR6": new Decimal("0.06"),
    "ZR8": new Decimal("0.08"),
    "ZR10": new Decimal("0.10"),
    "ZR12": new Decimal("0.12"),
    "ZR14": new Decimal("0.14"),
    "ZR16": new Decimal("0.16"),
    "ZR18": new Decimal("0.18"),
    "ZR20": new Decimal("0.20"),
    "ZR25": new Decimal("0.25")
};
