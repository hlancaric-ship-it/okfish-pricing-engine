(() => {
    "use strict";

    console.log("%cVIP DETAIL MODULE — per-product real discount", "background:#e4002b;color:white;padding:2px 6px;font-weight:bold;");

    const WORKER_URL = "https://shoptet-vip-worker.hlancaric.workers.dev";

    function formatPrice(price) {
        return price.toFixed(2).replace(".", ",") + " €";
    }

    function getTier() {
        const email = (window.shoptet?.customer?.email || "").trim().toLowerCase();
        if (!email) return null;
        const discount = window.vipDiscounts?.[email];
        if (typeof discount !== "number" || discount <= 0) return null;
        return `ZR${discount}`;
    }

    function getCode() {
        // Confirmed present on the product detail page (unlike catalog cards, which use
        // a different hidden <span data-micro="sku"> element instead).
        const el = document.querySelector("[itemprop='sku']");
        return el?.getAttribute("content") || el?.textContent.trim() || null;
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

    async function renderDetail() {
        const wrapper = document.querySelector(".p-final-price-wrapper");
        if (!wrapper || wrapper.dataset.vipDetailDone) return;

        // Native Shoptet badge (.price-standard / .price-save) already covers some
        // products — don't duplicate it if it's already there.
        if (wrapper.querySelector(".price-standard, .price-save")) {
            wrapper.dataset.vipDetailDone = "1";
            return;
        }

        const tier = getTier();
        const code = getCode();
        if (!tier || !code) return;

        wrapper.dataset.vipDetailDone = "1";

        const data = await fetchProductDiscount(code, tier);
        if (!data || !data.discountPct || data.discountPct <= 0) return;

        const box = document.createElement("div");
        box.className = "vip-detail-price-box";
        box.innerHTML = `
            <div style="font-size:0.9em;color:#888;text-decoration:line-through;">${formatPrice(data.standardPrice)}</div>
            <span style="display:inline-block;margin-top:4px;padding:2px 8px;background:#e8f5e9;color:#28a745;border:1px solid #28a745;font-size:0.85em;font-weight:700;border-radius:4px;">Ušetríte ${data.discountPct}%</span>
        `;
        wrapper.prepend(box);
    }

    // Přesune "Strážiť" (watchdog) ikonku z .link-icons (pod tlačítkem "Do
    // košíka") vedle ceny. Nezávislé na VIP slevovém badge výše -- musí
    // fungovat pro každého návštěvníka, ne jen přihlášené VIP zákazníky.
    function moveWatchdogNextToPrice() {
        const wrapper = document.querySelector(".p-final-price-wrapper");
        const watchdog = document.querySelector(".link-icon.watchdog");
        if (!wrapper || !watchdog || watchdog.dataset.vipMoved) return;

        watchdog.dataset.vipMoved = "1";
        watchdog.style.display = "inline-flex";
        watchdog.style.alignItems = "center";
        watchdog.style.marginLeft = "12px";
        wrapper.appendChild(watchdog);
    }

    function init() {
        renderDetail();
        moveWatchdogNextToPrice();
        let timeout;
        const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                renderDetail();
                moveWatchdogNextToPrice();
            }, 200);
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

    window.addEventListener("vipReady", () => {
        renderDetail();
        moveWatchdogNextToPrice();
    });
})();
