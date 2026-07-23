(() => {
    "use strict";

    console.log("%cVIP CART MODULE (v4) — per-product real discount + total savings", "background:#e4002b;color:white;padding:2px 6px;font-weight:bold;");

    const WORKER_URL = "https://shoptet-vip-worker.hlancaric.workers.dev";
    const productDataCache = new Map(); // code -> { price, standardPrice, discountPct } | null

    function formatPrice(price) {
        return price.toFixed(2).replace(".", ",") + " €";
    }

    function getTier() {
        const email = (window.shoptet?.customer?.email || "").trim().toLowerCase();
        if (!email) return null;
        const discount = window.vipDiscounts?.[email];
        if (typeof discount !== "number" || discount <= 0) return null;
        // Loyalty tiers are named ZR<discount%> (ZR4, ZR6, ZR8 ... ZR25) — a 1:1 mapping
        // fixed by policy-v1.json, so the flat % from the customer lookup already tells
        // us the tier name directly. Only used to look up PRODUCT-SPECIFIC data below —
        // never to compute a discount by itself (that was the earlier bug).
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

    function getRowQuantity(row) {
        const input = row.querySelector("input[name='amount']");
        const n = input ? parseInt(input.value, 10) : 1;
        return isNaN(n) ? 1 : n;
    }

    function renderTotalSavings(totalSaved) {
        let box = document.querySelector(".vip-cart-total-savings");
        if (totalSaved <= 0) {
            if (box) box.remove();
            return;
        }
        if (!box) {
            box = document.createElement("div");
            box.className = "vip-cart-total-savings";
            box.style.marginTop = "10px";
            box.style.paddingTop = "10px";
            box.style.borderTop = "1px dashed #28a745";
            box.style.color = "#28a745";
            box.style.fontWeight = "800";
            box.style.fontSize = "1.1em";
            box.style.textAlign = "right";

            // Anchor near the cart's own total, if we can find it; otherwise fall back
            // to appending at the end of the cart table's container.
            const anchor = document.querySelector("[data-testid='recapFullPrice']")?.closest("tr, div, .cart-total")
                || document.querySelector(".cart-total")
                || document.querySelector(".cart-table")?.parentElement;
            if (anchor) {
                anchor.insertAdjacentElement("afterend", box);
            } else {
                return; // no safe place to attach — skip rather than guess
            }
        }
        box.textContent = `Spolu ušetríte: ${formatPrice(totalSaved)}`;
    }

    async function renderCart() {
        const tier = getTier();
        if (!tier) { renderTotalSavings(0); return; }

        const rows = document.querySelectorAll("tr[data-micro='cartItem'], tr.removeable");
        let totalSaved = 0;

        for (const row of rows) {
            const code = row.getAttribute("data-micro-sku");
            const totalCell = row.querySelector(".p-total");
            if (!code || !totalCell) continue;

            if (!productDataCache.has(code)) {
                productDataCache.set(code, await fetchProductDiscount(code, tier));
            }
            const data = productDataCache.get(code);
            if (!data || !data.discountPct || data.discountPct <= 0) continue;

            if (!row.dataset.vipCartBadgeDone) {
                const badge = document.createElement("span");
                badge.className = "vip-cart-percent";
                badge.style.color = "#28a745";
                badge.style.fontWeight = "700";
                badge.style.marginLeft = "8px";
                badge.textContent = `-${data.discountPct}%`;
                totalCell.appendChild(badge);
                row.dataset.vipCartBadgeDone = "1";
            }

            const qty = getRowQuantity(row);
            totalSaved += (data.standardPrice - data.price) * qty;
        }

        renderTotalSavings(Math.round(totalSaved * 100) / 100);
    }

    // NOTE: deliberately does NOT touch the cart's grand total (recapFullPrice) —
    // Shoptet already computes that correctly from the per-item pricelist prices.
    // An earlier version subtracted a flat % AGAIN on top of that, double-discounting
    // the customer's total (a real money bug, not just cosmetic).

    function init() {
        renderCart();
        let timeout;
        const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(renderCart, 200);
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

    window.addEventListener("vipReady", renderCart);
    document.addEventListener("shoptet.cart-updated", () => setTimeout(renderCart, 200));
})();
