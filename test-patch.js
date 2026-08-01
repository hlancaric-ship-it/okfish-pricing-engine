const token = process.env.SHOPTET_PRIVATE_API_TOKEN;
const guid = "1ee1e56e-8364-40c3-b3e9-879c0dcfccf8";
async function testPayload(payload) {
    const res = await fetch(`https://api.myshoptet.com/api/customers/${guid}`, {
        method: 'PATCH',
        headers: { 'Shoptet-Private-API-Token': token, 'Content-Type': 'application/vnd.shoptet.v1.0' },
        body: JSON.stringify({ data: payload })
    });
    const json = await res.json();
    console.log(JSON.stringify(payload) + " => " + (json.errors ? json.errors[0].message : "SUCCESS!"));
}
async function run() {
    await testPayload({ customerGroupId: 5 });
    await testPayload({ customerGroup: 5 });
    await testPayload({ groupId: 5 });
    await testPayload({ priceListId: 2 });
    await testPayload({ pricelistId: 2 });
    await testPayload({ customer: { customerGroup: { id: 5 } } });
}
run();
