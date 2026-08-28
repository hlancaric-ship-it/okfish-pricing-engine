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

    // Jednorázově vloží <style> s responzivní media query -- inline styly
    // (element.style.xxx) nejdou media-query podmínit, proto se rozložení
    // (mezera od ceny, velikosti textu, zalomení pod cenu na mobilu) řeší
    // přes CSS třídy, ne přes inline hodnoty.
    function ensureWatchdogStyles() {
        if (document.getElementById("vip-watchdog-style")) return;
        const style = document.createElement("style");
        style.id = "vip-watchdog-style";
        style.textContent = `
            .price-final { flex-wrap: nowrap; }
            .vip-watchdog-block {
                display: inline-flex !important;
                align-items: center;
                gap: 5px;
                margin-left: 16px;
                text-decoration: none;
                vertical-align: middle;
                text-transform: none;
                white-space: nowrap;
                background: rgba(136, 186, 21, 0.08) !important;
                border: 1px solid rgba(136, 186, 21, 0.25) !important;
                border-radius: 8px !important;
                cursor: pointer;
                padding: 3px 8px !important;
                transition: background-color 0.15s ease, border-color 0.15s ease;
            }
            .vip-watchdog-block:hover {
                background: rgba(136, 186, 21, 0.16) !important;
                border-color: rgba(136, 186, 21, 0.45) !important;
            }
            .vip-watchdog-icon { font-size: 20px; line-height: 1; }
            .vip-watchdog-title { font-weight: 700; color: #1a1a1a; font-size: 11.5px; white-space: nowrap; }
            .vip-watchdog-sub { color: #555; font-size: 8.5px; white-space: nowrap; }
            @media (max-width: 768px) {
                .vip-watchdog-block {
                    margin-left: 12px !important;
                    gap: 4px !important;
                    padding: 3px 7px !important;
                    background: rgba(136, 186, 21, 0.08) !important;
                    border: 1px solid rgba(136, 186, 21, 0.25) !important;
                    border-radius: 8px !important;
                }
                .vip-watchdog-icon { font-size: 18px !important; }
                .vip-watchdog-title { font-size: 10.5px !important; font-weight: 700 !important; color: #1a1a1a !important; }
                .vip-watchdog-sub { font-size: 7.5px !important; color: #555 !important; }
            }

            /* --- RYBÁRSKA STRÁŽ MODAL --- */
            .vip-modal-overlay {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(15, 20, 25, 0.65);
                backdrop-filter: blur(5px);
                -webkit-backdrop-filter: blur(5px);
                z-index: 999999;
                display: flex;
                align-items: center;
                justify-content: center;
                opacity: 0;
                visibility: hidden;
                transition: opacity 0.25s ease, visibility 0.25s ease;
                padding: 16px;
                box-sizing: border-box;
            }
            .vip-modal-overlay.active {
                opacity: 1;
                visibility: visible;
            }
            .vip-modal-dialog {
                background: #ffffff;
                width: 100%;
                max-width: 440px;
                border-radius: 16px;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25), 0 0 0 1px rgba(0,0,0,0.06);
                padding: 24px 22px;
                position: relative;
                transform: scale(0.94) translateY(10px);
                transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
                color: #1f2328;
                font-family: inherit;
                box-sizing: border-box;
            }
            .vip-modal-overlay.active .vip-modal-dialog {
                transform: scale(1) translateY(0);
            }
            .vip-modal-close {
                position: absolute;
                top: 14px;
                right: 14px;
                width: 32px;
                height: 32px;
                border-radius: 50%;
                border: none;
                background: #f0f2f5;
                color: #656d76;
                font-size: 20px;
                line-height: 1;
                cursor: pointer;
                display: flex;
                align-items: center;
                justify-content: center;
                transition: background 0.15s, color 0.15s;
            }
            .vip-modal-close:hover {
                background: #e4e7ec;
                color: #1f2328;
            }
            .vip-modal-header {
                display: flex;
                align-items: center;
                gap: 12px;
                margin-bottom: 14px;
            }
            .vip-modal-header-icon {
                font-size: 34px;
                line-height: 1;
            }
            .vip-modal-header-text h3 {
                margin: 0;
                font-size: 18px;
                font-weight: 750;
                color: #111827;
                letter-spacing: -0.01em;
            }
            .vip-modal-header-text p {
                margin: 2px 0 0;
                font-size: 12px;
                color: #6b7280;
            }
            .vip-modal-product-box {
                display: flex;
                align-items: center;
                gap: 12px;
                background: #f9fafb;
                border: 1px solid #e5e7eb;
                border-radius: 10px;
                padding: 10px 12px;
                margin-bottom: 16px;
            }
            .vip-modal-product-box img {
                width: 48px;
                height: 48px;
                object-fit: contain;
                border-radius: 6px;
                background: #fff;
                border: 1px solid #e5e7eb;
                flex-shrink: 0;
            }
            .vip-modal-product-info {
                flex: 1;
                min-width: 0;
            }
            .vip-modal-product-name {
                font-size: 13px;
                font-weight: 600;
                color: #1f2937;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                margin-bottom: 2px;
            }
            .vip-modal-product-price {
                font-size: 13.5px;
                font-weight: 750;
                color: #88BA15;
            }
            .vip-form-group {
                margin-bottom: 14px;
            }
            .vip-form-label {
                display: block;
                font-size: 12px;
                font-weight: 650;
                color: #374151;
                margin-bottom: 6px;
                text-transform: uppercase;
                letter-spacing: 0.03em;
            }
            .vip-form-input {
                width: 100%;
                height: 42px;
                padding: 8px 12px;
                border: 1.5px solid #d1d5db;
                border-radius: 8px;
                font-size: 14px;
                color: #111827;
                box-sizing: border-box;
                outline: none;
                transition: border-color 0.15s, box-shadow 0.15s;
            }
            .vip-form-input:focus {
                border-color: #88BA15;
                box-shadow: 0 0 0 3px rgba(136, 186, 21, 0.2);
            }
            .vip-options-group {
                background: #f9fafb;
                border: 1px solid #e5e7eb;
                border-radius: 10px;
                padding: 10px 12px;
                margin-bottom: 16px;
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .vip-option-row {
                display: flex;
                align-items: center;
                gap: 9px;
                font-size: 13px;
                color: #374151;
                cursor: pointer;
            }
            .vip-option-row input[type="checkbox"] {
                accent-color: #88BA15;
                width: 17px;
                height: 17px;
                margin: 0;
                cursor: pointer;
            }
            .vip-price-target-wrap {
                display: flex;
                align-items: center;
                gap: 8px;
                margin-top: 4px;
                padding-left: 26px;
            }
            .vip-price-target-wrap input {
                width: 100px;
                height: 32px;
                padding: 4px 8px;
                border: 1px solid #d1d5db;
                border-radius: 6px;
                font-size: 13px;
            }
            .vip-modal-submit-btn {
                width: 100%;
                height: 44px;
                background: #88BA15;
                color: #ffffff;
                border: none;
                border-radius: 8px;
                font-size: 15px;
                font-weight: 700;
                cursor: pointer;
                transition: background 0.15s, transform 0.1s;
                display: flex;
                align-items: center;
                justify-content: center;
                gap: 8px;
            }
            .vip-modal-submit-btn:hover {
                background: #76a310;
            }
            .vip-modal-submit-btn:active {
                transform: scale(0.99);
            }
            .vip-modal-submit-btn:disabled {
                background: #9ca3af;
                cursor: not-allowed;
            }
            .vip-success-screen {
                text-align: center;
                padding: 12px 6px;
            }
            .vip-success-icon {
                font-size: 48px;
                line-height: 1;
                margin-bottom: 12px;
            }
            .vip-success-title {
                font-size: 18px;
                font-weight: 750;
                color: #111827;
                margin-bottom: 6px;
            }
            .vip-success-desc {
                font-size: 13px;
                color: #4b5563;
                line-height: 1.4;
                margin-bottom: 18px;
            }

            @media (max-width: 600px) {
                .vip-modal-overlay {
                    padding: 12px;
                    align-items: center;
                }
                .vip-modal-dialog {
                    padding: 20px 16px;
                    max-height: 92vh;
                    overflow-y: auto;
                    border-radius: 16px;
                }
                .vip-modal-header-icon { font-size: 28px; }
                .vip-modal-header-text h3 { font-size: 17px; }
                .vip-form-input {
                    font-size: 16px !important; /* zabrání nechtěnému zoomování v iOS Safari */
                    height: 44px;
                }
                .vip-modal-submit-btn {
                    height: 46px;
                    font-size: 15px;
                }
            }
        `;
        document.head.appendChild(style);
    }

    function createWatchdogModal() {
        if (document.getElementById("vip-watchdog-modal")) return;

        const modalOverlay = document.createElement("div");
        modalOverlay.id = "vip-watchdog-modal";
        modalOverlay.className = "vip-modal-overlay";
        modalOverlay.innerHTML = `
            <div class="vip-modal-dialog" role="dialog" aria-modal="true">
                <button type="button" class="vip-modal-close" id="vipModalClose" aria-label="Zatvoriť">&times;</button>
                
                <div id="vipModalBody">
                    <div class="vip-modal-header">
                        <span class="vip-modal-header-icon">👮</span>
                        <div class="vip-modal-header-text">
                            <h3>Rybárska stráž</h3>
                            <p>Nastavte si sledovanie dostupnosti a ceny</p>
                        </div>
                    </div>

                    <div class="vip-modal-product-box">
                        <img id="vipModalProdImg" src="" alt="Produkt" style="display:none;" />
                        <div class="vip-modal-product-info">
                            <div class="vip-modal-product-name" id="vipModalProdName">Načítavam produkt…</div>
                            <div class="vip-modal-product-price" id="vipModalProdPrice"></div>
                        </div>
                    </div>

                    <form id="vipWatchdogForm">
                        <div class="vip-form-group">
                            <label class="vip-form-label" for="vipWatchdogEmail">Váš e-mail</label>
                            <input type="email" id="vipWatchdogEmail" class="vip-form-input" placeholder="napr. meno@email.sk" required />
                        </div>

                        <div class="vip-options-group">
                            <label class="vip-option-row">
                                <input type="checkbox" id="vipWatchAvailability" checked />
                                <span>Strážiť <b>naskladnenie</b> (keď bude tovar skladom)</span>
                            </label>
                            <label class="vip-option-row">
                                <input type="checkbox" id="vipWatchPrice" />
                                <span>Strážiť <b>zníženie ceny</b></span>
                            </label>
                            <div class="vip-price-target-wrap" id="vipPriceTargetWrap" style="display:none;">
                                <span>upozorniť pri cene pod:</span>
                                <input type="number" step="0.01" id="vipTargetPrice" placeholder="Cena v €" />
                            </div>
                        </div>

                        <button type="submit" class="vip-modal-submit-btn" id="vipSubmitBtn">
                            Aktivovať Rybársku stráž 🎣
                        </button>
                    </form>
                </div>

                <div id="vipModalSuccess" class="vip-success-screen" style="display:none;">
                    <div class="vip-success-icon">🎣</div>
                    <div class="vip-success-title">Rybárska stráž aktivovaná!</div>
                    <div class="vip-success-desc" id="vipSuccessDesc">
                        Dáme vám vedieť hneď, ako bude tovar dostupný.
                    </div>
                    <button type="button" class="vip-modal-submit-btn" id="vipSuccessCloseBtn">
                        Rozumiem
                    </button>
                </div>
            </div>
        `;

        document.body.appendChild(modalOverlay);

        const closeModal = () => modalOverlay.classList.remove("active");
        modalOverlay.querySelector("#vipModalClose")?.addEventListener("click", closeModal);
        modalOverlay.querySelector("#vipSuccessCloseBtn")?.addEventListener("click", closeModal);
        modalOverlay.addEventListener("click", (e) => {
            if (e.target === modalOverlay) closeModal();
        });
        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape" && modalOverlay.classList.contains("active")) closeModal();
        });

        const priceCheck = modalOverlay.querySelector("#vipWatchPrice");
        const priceWrap = modalOverlay.querySelector("#vipPriceTargetWrap");
        priceCheck?.addEventListener("change", () => {
            if (priceWrap) priceWrap.style.display = priceCheck.checked ? "flex" : "none";
        });

        const form = modalOverlay.querySelector("#vipWatchdogForm");
        form?.addEventListener("submit", async (e) => {
            e.preventDefault();
            const emailInput = modalOverlay.querySelector("#vipWatchdogEmail");
            const email = emailInput?.value?.trim();
            if (!email) return;

            const submitBtn = modalOverlay.querySelector("#vipSubmitBtn");
            if (submitBtn) {
                submitBtn.disabled = true;
                submitBtn.textContent = "Ukladám…";
            }

            try {
                const nativeAction = modalOverlay.dataset.actionUrl || "/action/Watchdog/new/";
                const formData = new FormData();
                formData.append("email", email);
                if (modalOverlay.dataset.productId) formData.append("productId", modalOverlay.dataset.productId);
                if (modalOverlay.dataset.priceId) formData.append("priceId", modalOverlay.dataset.priceId);

                const watchAvail = modalOverlay.querySelector("#vipWatchAvailability")?.checked;
                const watchPrice = modalOverlay.querySelector("#vipWatchPrice")?.checked;
                const targetPrice = modalOverlay.querySelector("#vipTargetPrice")?.value;

                if (watchAvail) formData.append("watchAvailability", "1");
                if (watchPrice && targetPrice) {
                    formData.append("watchPrice", "1");
                    formData.append("price", targetPrice);
                }

                await fetch(nativeAction, {
                    method: "POST",
                    body: formData,
                    credentials: "same-origin"
                }).catch(() => {});
            } catch (err) {
                console.warn("[VIP Watchdog] Submit fallback:", err);
            }

            const bodyEl = modalOverlay.querySelector("#vipModalBody");
            const successEl = modalOverlay.querySelector("#vipModalSuccess");
            const successDesc = modalOverlay.querySelector("#vipSuccessDesc");
            if (bodyEl) bodyEl.style.display = "none";
            if (successEl) successEl.style.display = "block";
            if (successDesc) {
                successDesc.innerHTML = `Sledovanie bolo zapnuté pre e-mail <b>${email}</b>.<br>Akonáhle dôjde k zmene stavu, pošleme vám notifikáciu.`;
            }
        });
    }

    function openWatchdogModal(nativeHref) {
        ensureWatchdogStyles();
        createWatchdogModal();

        const modalOverlay = document.getElementById("vip-watchdog-modal");
        if (!modalOverlay) return;

        const bodyEl = modalOverlay.querySelector("#vipModalBody");
        const successEl = modalOverlay.querySelector("#vipModalSuccess");
        const submitBtn = modalOverlay.querySelector("#vipSubmitBtn");
        if (bodyEl) bodyEl.style.display = "block";
        if (successEl) successEl.style.display = "none";
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = "Aktivovať Rybársku stráž 🎣";
        }

        const prodName = document.querySelector("h1[itemprop='name'], .p-detail-inner h1, h1")?.textContent?.trim() || "Produkt";
        const prodImg = document.querySelector(".p-main-image img, [itemprop='image']")?.getAttribute("src") || "";
        const prodPrice = document.querySelector(".price-final")?.childNodes?.[0]?.textContent?.trim() || "";

        const nameEl = modalOverlay.querySelector("#vipModalProdName");
        const imgEl = modalOverlay.querySelector("#vipModalProdImg");
        const priceEl = modalOverlay.querySelector("#vipModalProdPrice");

        if (nameEl) nameEl.textContent = prodName;
        if (priceEl) priceEl.textContent = prodPrice;
        if (imgEl) {
            if (prodImg) {
                imgEl.src = prodImg;
                imgEl.style.display = "block";
            } else {
                imgEl.style.display = "none";
            }
        }

        const userEmail = (window.shoptet?.customer?.email || "").trim();
        const emailInput = modalOverlay.querySelector("#vipWatchdogEmail");
        if (emailInput && userEmail) {
            emailInput.value = userEmail;
        }

        if (nativeHref) {
            modalOverlay.dataset.actionUrl = nativeHref;
        }

        modalOverlay.classList.add("active");
    }

    function moveWatchdogNextToPrice() {
        const priceFinal = document.querySelector(".price-final");
        const watchdog = document.querySelector(".link-icon.watchdog, a.vip-watchdog-block");
        if (!priceFinal || !watchdog || watchdog.dataset.vipMoved) return;

        watchdog.dataset.vipMoved = "1";
        ensureWatchdogStyles();

        watchdog.classList.remove("watchdog");
        watchdog.classList.add("vip-watchdog-block");
        watchdog.innerHTML = `
            <span class="vip-watchdog-icon">👮</span>
            <span style="display:flex;flex-direction:column;line-height:1.15;text-transform:none;">
                <span class="vip-watchdog-title">Rybárska stráž</span>
                <span class="vip-watchdog-sub">Stráži dostupnosť produktu</span>
            </span>
        `;

        const originalHref = watchdog.getAttribute("href") || "";

        watchdog.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            openWatchdogModal(originalHref);
        });

        priceFinal.style.display = "flex";
        priceFinal.style.alignItems = "center";
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
