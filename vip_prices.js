(() => {
    "use strict";

    // v2.0.0 — no longer depends on a per-email lookup (window.vipDiscounts / Worker
    // fetch). Since the backend now writes the correct, VAT-correct tier price
    // natively into Shoptet's own pricelist mechanism, the discount is already
    // reflected in .price-final-holder for every logged-in customer group — this
    // script's only job is to visually decorate that with the original (struck-through)
    // price and a computed "% off" badge, reading both numbers straight from the DOM.
    console.log("VIP PRICES JS LOADED (v2, DOM-derived discount)");

    function formatPrice(price) {
        return price.toFixed(2).replace(".", ",") + " €";
    }

    function parsePrice(text) {
        const n = parseFloat(text.replace(/[^\d,]/g, "").replace(",", "."));
        return isNaN(n) ? null : n;
    }

    function updateDiscountBadges() {
        document.querySelectorAll(".p-final-price-wrapper").forEach(wrapper => {
            if (wrapper.dataset.vipDone) return;

            // Native action price already present (e.g. a real Shoptet ACTION_PRICE
            // sale, unrelated to loyalty pricelists) — leave Shoptet's own markup alone.
            const priceAdditionalEl = wrapper.querySelector(".price-additional");
            if (priceAdditionalEl && /\d/.test(priceAdditionalEl.textContent)) {
                wrapper.dataset.vipDone = "1";
                return;
            }

            const holder = wrapper.querySelector(".price-final-holder");
            if (!holder) return;

            const finalPrice = parsePrice(holder.textContent);
            if (finalPrice === null) return;

            const productDetail = wrapper.closest(".p-detail, .product-detail, body");
            const priceStandardEl = productDetail ? productDetail.querySelector(".price-standard") : null;
            if (!priceStandardEl) {
                wrapper.dataset.vipDone = "1"; // nothing to compare against, no badge to show
                return;
            }

            const standardPrice = parsePrice(priceStandardEl.textContent);
            if (standardPrice === null || standardPrice <= finalPrice) {
                wrapper.dataset.vipDone = "1"; // no real discount active for this tier
                return;
            }

            const discountPct = Math.round((1 - finalPrice / standardPrice) * 100);

            const old = document.createElement("div");
            old.className = "vip-old-price";
            old.innerHTML = `Bežná cena: <s>${formatPrice(standardPrice)}</s>`;

            const badge = document.createElement("div");
            badge.className = "vip-discount";
            badge.textContent = `UŠETRÍTE ${discountPct}%`;

            wrapper.prepend(old);
            wrapper.appendChild(badge);

            wrapper.dataset.vipDone = "1";

            console.log("VIP BADGE:", formatPrice(standardPrice), "->", formatPrice(finalPrice), `(${discountPct}%)`);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", updateDiscountBadges);
    } else {
        updateDiscountBadges();
    }

    const observer = new MutationObserver(() => updateDiscountBadges());
    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    }
})();
