(() => {
    "use strict";

    console.log("%cVIP CATALOG MODULE (v2) — per-product real discount", "background:#e4002b;color:white;padding:2px 6px;font-weight:bold;");

    const WORKER_URL = "https://shoptet-vip-worker.hlancaric.workers.dev";

    function formatPrice(price) {
        return price.toFixed(2).replace(".", ",") + " €";
    }

    function getTier() {
        const email = (window.shoptet?.customer?.email || "").trim().toLowerCase();
        if (!email) return null;
        const discount = window.vipDiscounts?.[email];
        if (typeof discount !== "number" || discount <= 0) return null;
        // Same 1:1 tier-name mapping as vip_cart.js (ZR<discount%>) — only used to look
        // up the PRODUCT-SPECIFIC price via /v1/product-discount, never to compute the
        // discount from the flat % directly (that was the old bug: a product's real
        // discount can differ from the customer's raw tier rate due to maxDiscount caps,
        // action prices, or loyalty-disabled products like gift cards).
        return `ZR${discount}`;
    }

    async function fetchProductDiscount(code, tier) {
        try {
            const res = await fetch(`${WORKER_URL}/v1/product-discount/${encodeURIComponent(code)}/${encodeURIComponent(tier)}`, { cache: "no-store" });
            if (!res.ok) return null;
            return await res.json();
        } catch {
            return null;
        }
    }

    async function renderCatalog() {
        const tier = getTier();
        if (!tier) return;

        const cards = document.querySelectorAll(".product");

        for (const card of cards) {
            if (card.dataset.vipCatalogDone) continue;

            // The real merchant SKU/code lives in a hidden <span data-micro="sku">, NOT
            // in data-micro-product-id (that's Shoptet's own internal numeric ID, a
            // different ID space that never matches our pricing data's `code` field).
            const skuEl = card.querySelector("[data-micro='sku']");
            const code = skuEl?.textContent.trim();
            const priceEl = card.querySelector(".price.price-final[data-testid='productCardPrice']");
            if (!code || !priceEl) continue;

            card.dataset.vipCatalogDone = "1";

            const data = await fetchProductDiscount(code, tier);

            // No real discount for this product/tier -> leave Shoptet's own price alone.
            if (!data || !data.discountPct || data.discountPct <= 0) {
                priceEl.style.display = "";
                continue;
            }

            priceEl.style.display = "none";

            const box = document.createElement("div");
            box.className = "vip-catalog-price-box";
            box.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span style="font-size:1.2em;font-weight:800;color:#d9534f;">${formatPrice(data.price)}</span>
                    <span style="background:#e8f5e9;color:#28a745;border:1px solid #28a745;padding:1px 6px;border-radius:4px;font-weight:bold;font-size:0.8em;">-${data.discountPct}%</span>
                </div>
                <div style="font-size:0.85em;color:#888;text-decoration:line-through;">${formatPrice(data.standardPrice)}</div>
            `;
            priceEl.insertAdjacentElement("afterend", box);
        }
    }

    function init() {
        renderCatalog();
        let timeout;
        const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(renderCatalog, 200);
        });
        if (document.body) {
            observer.observe(document.body, { childList: true, subtree: true });
        }
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    window.addEventListener("vipReady", renderCatalog);
    document.addEventListener("shoptet.products-list-updated", () => setTimeout(renderCatalog, 200));
})();
