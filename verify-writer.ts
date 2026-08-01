import { PricelistWriter } from './cloudflare-worker/src/shoptet-api/pricelist-writer.ts';
import { ShoptetApiClient } from './cloudflare-worker/src/shoptet-api/client.ts';
import Decimal from 'decimal.js';

async function verify() {
    // Mock the API client
    const client = new ShoptetApiClient('dummy-token');
    client.updatePricelistBatch = async (id, items) => {
        return {
            requestId: 'mocked-x-request-id-1234',
            response: 'ok',
            timestamp: new Date().toISOString(),
            status: 200,
            endpoint: `/pricelists/${id}`
        };
    };

    const writer = new PricelistWriter(client, { dryRun: false });
    
    // Test 1: Cold Cache (oldPrice: null)
    console.log("--- TEST 1: Cold Cache ---");
    const diff1 = [{ code: "SKU1", oldPrice: null, newPrice: new Decimal(100) }];
    const stats1 = await writer.processDiff(1, "TestPricelist", diff1);
    console.log("Stats1:", stats1);

    // Test 2: Filled Cache (oldPrice: 50)
    console.log("\n--- TEST 2: Filled Cache ---");
    const diff2 = [{ code: "SKU2", oldPrice: new Decimal(50), newPrice: new Decimal(100) }];
    const stats2 = await writer.processDiff(1, "TestPricelist", diff2);
    console.log("Stats2:", stats2);
}
verify();
