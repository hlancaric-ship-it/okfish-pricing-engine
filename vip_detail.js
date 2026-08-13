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
    // košíka") přímo VEDLE finální ceny (na stejný řádek jako €XXX,XX, ne
    // pod celý .p-final-price-wrapper blok -- ten obsahuje i řádek "bez DPH"
    // pod cenou, takže appendChild na wrapper dával ikonku pod všechno, ne
    // vedle ceny z pohledu zákazníka). Cílí konkrétně na `strong.price-final`
    // (element, co obaluje `€426,87`), tomu nastaví display:flex, aby watchdog
    // seděl vpravo od čísla na stejném řádku. Přestylizováno na "Rybárska
    // stráž" -- ikonka strážnika + dvouřádkový text. Nezávislé na VIP
    // slevovém badge výše -- musí fungovat pro každého návštěvníka, ne jen
    // přihlášené VIP zákazníky. Původní href (odkaz na :strazit-cenu/
    // formulář) i klikací chování se zachovává beze změny -- mění se jen
    // vzhled obsahu <a> elementu.
    function moveWatchdogNextToPrice() {
        const priceFinal = document.querySelector(".price-final");
        const watchdog = document.querySelector(".link-icon.watchdog");
        if (!priceFinal || !watchdog || watchdog.dataset.vipMoved) return;

        watchdog.dataset.vipMoved = "1";
        // Pevné (ne em) velikosti -- .price-final má vlastní obří font-size
        // pro číslo ceny, takže cokoliv v "em" jednotkách zdědilo tu obří
        // velikost a text-transform:uppercase. Text musí být viditelně
        // menší než cena, ne stejně velký.
        watchdog.style.cssText = `
            display: inline-flex !important;
            align-items: center;
            gap: 6px;
            margin-left: 14px;
            text-decoration: none;
            vertical-align: middle;
            text-transform: none;
            white-space: nowrap;
            flex-shrink: 0;
        `;
        watchdog.innerHTML = `
            <span style="font-size:20px;line-height:1;">👮</span>
            <span style="display:flex;flex-direction:column;line-height:1.15;text-transform:none;">
                <span style="font-weight:700;color:#333;font-size:12px;">Rybárska stráž</span>
                <span style="color:#888;font-size:10px;">Stráži dostupnosť produktu</span>
            </span>
        `;

        priceFinal.style.display = "flex";
        priceFinal.style.alignItems = "center";
        priceFinal.style.flexWrap = "nowrap";
        priceFinal.appendChild(watchdog);
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
