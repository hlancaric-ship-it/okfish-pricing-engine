(() => {
    "use strict";

    console.log("%cVIP CART MODULE (v6) — real discount incl. sale + coupon, total savings", "background:#e4002b;color:white;padding:2px 6px;font-weight:bold;");

    const WORKER_URL = "https://shoptet-vip-worker.hlancaric.workers.dev";

    // standardPrice never changes per tier — it's the plain pre-discount price from
    // the master feed. We only ever need to fetch it ONCE per product, using whatever
    // tier is convenient (falls back to ZR4 for guests, just to have a valid tier
    // param for the API call), then reuse it forever. This is deliberately NOT
    // dependent on Shoptet's own cart tooltip ([data-testid="cartItemDiscount"]),
    // which turned out to be unreliable: it doesn't render at all for items where the
    // coupon adds zero extra room (e.g. productMaxDiscount=0), even though those items
    // still have a real, visible discount (their sale/action price) that should count.
    const standardPriceCache = new Map(); // code -> standardPrice

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
        // us the tier name directly.
        return `ZR${discount}`;
    }

    async function fetchStandardPrice(code, tier) {
        try {
            const res = await fetch(`${WORKER_URL}/v1/product-discount/${encodeURIComponent(code)}/${encodeURIComponent(tier || "ZR4")}`, { cache: "no-store" });
            if (!res.ok) return null;
            const data = await res.json();
            return typeof data?.standardPrice === "number" ? data.standardPrice : null;
        } catch {
            return null;
        }
    }

    function getRowQuantity(row) {
        const input = row.querySelector("input[name='amount']");
        const n = input ? parseInt(input.value, 10) : 1;
        return isNaN(n) ? 1 : n;
    }

    // Extracts a €-formatted price (e.g. "6,39" out of "Súčet €6,39 Odstrániť z košíka")
    // instead of naively parseFloat-ing the whole cell text, which also contains
    // labels/button text mixed in and would just return NaN.
    function parsePrice(text) {
        if (!text) return NaN;
        const m = text.match(/(\d[\d\s]*,\d{2})/);
        if (!m) return NaN;
        return parseFloat(m[1].replace(/\s/g, "").replace(",", "."));
    }

    // Reads a cell's price text while ignoring any badge WE previously inserted into
    // it — otherwise re-running after our own DOM change would parse "6,39-4%" as
    // garbage instead of the real price.
    function parsePriceExcludingOwnBadge(cell) {
        if (!cell) return NaN;
        const clone = cell.cloneNode(true);
        clone.querySelectorAll(".vip-cart-percent").forEach(el => el.remove());
        return parsePrice(clone.textContent);
    }

    function setBadge(totalCell, pct) {
        let badge = totalCell.querySelector(":scope > .vip-cart-percent");
        if (pct === null || pct <= 0) {
            if (badge) badge.remove();
            return;
        }
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "vip-cart-percent";
            badge.style.color = "#28a745";
            badge.style.fontWeight = "700";
            badge.style.marginLeft = "8px";
            totalCell.appendChild(badge);
        }
        const pctText = pct % 1 === 0 ? pct.toFixed(0) : pct.toFixed(1).replace(".", ",");
        badge.textContent = `-${pctText}%`;
    }

    function renderTotalSavings(totalSaved) {
        document.querySelectorAll(".vip-cart-total-savings").forEach(el => el.remove());
        if (totalSaved <= 0) return;

        // Anchor near the cart's own total, if we can find it; otherwise fall back
        // to appending at the end of the cart table's container.
        const anchor = document.querySelector("[data-testid='recapFullPrice']")?.closest("tr, div, .cart-total")
            || document.querySelector(".cart-total")
            || document.querySelector(".cart-table")?.parentElement;
        if (!anchor) return; // no safe place to attach — skip rather than guess

        const box = document.createElement("div");
        box.className = "vip-cart-total-savings";
        box.style.marginTop = "10px";
        box.style.paddingTop = "10px";
        box.style.borderTop = "1px dashed #28a745";
        box.style.color = "#28a745";
        box.style.fontWeight = "800";
        box.style.fontSize = "1.1em";
        box.style.textAlign = "right";
        box.textContent = `Spolu ušetríte: ${formatPrice(totalSaved)}`;
        anchor.insertAdjacentElement("afterend", box);
    }

    async function renderCart() {
        const tier = getTier();

        const rows = document.querySelectorAll("tr[data-micro='cartItem'], tr.removeable");
        const seenSkus = new Set(); // dedupe possible duplicate mobile/desktop row markup
        let totalSaved = 0;

        for (const row of rows) {
            const code = row.getAttribute("data-micro-sku");
            const totalCell = row.querySelector(".p-total");
            if (!code || !totalCell) continue;
            if (seenSkus.has(code)) continue;
            seenSkus.add(code);

            if (!standardPriceCache.has(code)) {
                standardPriceCache.set(code, await fetchStandardPrice(code, tier));
            }
            const standardPrice = standardPriceCache.get(code);
            if (standardPrice === null || standardPrice === undefined) continue;

            const qty = getRowQuantity(row);
            const rowTotal = parsePriceExcludingOwnBadge(totalCell);
            const currentUnitPrice = !isNaN(rowTotal) && qty > 0 ? rowTotal / qty : NaN;
            if (isNaN(currentUnitPrice)) continue;

            const pct = standardPrice > 0
                ? Math.round((1 - currentUnitPrice / standardPrice) * 10000) / 100
                : null;
            setBadge(totalCell, pct);

            totalSaved += (standardPrice - currentUnitPrice) * qty;
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

    // Applying/removing the coupon triggers an AJAX price recalculation — but Shoptet
    // doesn't reliably re-render EVERY row's markup afterwards. Re-running renderCart()
    // on a timer can't fix that if the DOM itself is stale. A full reload is the most
    // reliable way to get every row's price rendered fresh from the server. A page
    // reload does NOT itself submit this form, so there's no risk of a reload loop —
    // the in-memory flag just guards against the same submit firing this twice.
    let couponReloadScheduled = false;
    document.addEventListener("submit", (e) => {
        const form = e.target;
        if (form?.action && /DiscountCoupon/i.test(form.action) && !couponReloadScheduled) {
            couponReloadScheduled = true;
            setTimeout(() => location.reload(), 700);
        }
    }, true);
})();
