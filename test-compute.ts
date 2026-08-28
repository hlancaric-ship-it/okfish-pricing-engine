import { computeCouponWrites, ProductCouponInput } from './cloudflare-worker/src/coupon/compute-coupon-writes';

const items: ProductCouponInput[] = [
    {
        code: '100464',
        manufacturer: 'Robinson',
        category: 'Návnady',
        allowLoyaltyDiscount: true,
        basePriceExVat: 7.00 / 1.23,
        basePriceIncVat: 7.00,
        actionPriceExVat: null,
        actionPriceIncVat: null,
        buyPriceExVat: 2.74 / 1.23,
        applyDiscountCouponGUEST: true
    },
    {
        code: '110006',
        manufacturer: 'Tapado',
        category: 'Návnady',
        allowLoyaltyDiscount: true,
        basePriceExVat: 10.30 / 1.23,
        basePriceIncVat: 10.30,
        actionPriceExVat: null,
        actionPriceIncVat: null,
        buyPriceExVat: 6.52 / 1.23,
        applyDiscountCouponGUEST: true
    },
    {
        code: '101609',
        manufacturer: 'Unknown',
        category: 'Unknown',
        allowLoyaltyDiscount: true,
        basePriceExVat: 479.95 / 1.23,
        basePriceIncVat: 479.95,
        actionPriceExVat: null,
        actionPriceIncVat: null,
        buyPriceExVat: 371.40 / 1.23,
        applyDiscountCouponGUEST: true
    }
];

const writes = computeCouponWrites(items);
console.log(JSON.stringify(writes, null, 2));
