(() => {
    "use strict";

    console.log("%cVIP CART COUPON LOCK (SK) — blokuje kupón pri ZR20/ZR25", "background:#28a745;color:white;padding:4px 8px;font-weight:bold;font-size:12px;border-radius:3px;");

    // Tiers that already sit at the maximum available loyalty discount —
    // stacking a cart coupon on top of them is not allowed by policy.
    const LOCKED_TIERS = ["ZR20", "ZR25"];
    const MESSAGE = "Dosiahli ste maximálnu možnú zľavu, kupón preto pre vás nie je dostupný.";
    const FISH_LOGO_URL = "https://cdn.myshoptet.com/usr/www.okfish.sk/user/logos/logo-fish.png";

    function getTier() {
        const email = (window.shoptet?.customer?.email || "").trim().toLowerCase();
        if (!email) return null;
        const discount = window.vipDiscounts?.[email];
        if (typeof discount !== "number" || discount <= 0) return null;
        return `ZR${discount}`;
    }

    function findCouponForm() {
        return document.querySelector("[data-testid='formDiscountCoupon']");
    }

    function findCouponInput(form) {
        return form?.querySelector("#discountCouponCode, [data-testid='inputDiscountCoupon']") || null;
    }

    function findCouponSubmit(form) {
        return form?.querySelector("[data-testid='buttonSubmitDiscountCoupon']") || null;
    }

    function findCouponToggle() {
        return document.querySelector("[data-testid='buttonShowCouponInput']");
    }

    function findLockTarget() {
        // Cover the whole coupon block (badge + subtitle + input + button), not just
        // the <form> or just the badge — walk up from the form until we reach an
        // ancestor that also contains the badge, i.e. their smallest common container.
        const form = findCouponForm();
        const badge = document.querySelector(".discount-coupon-badge");
        if (!form) return badge?.closest("div") || null;
        if (!badge) return form;

        let el = form;
        while (el && !el.contains(badge)) {
            el = el.parentElement;
        }
        return el || form;
    }

    function lockCoupon() {
        const target = findLockTarget();
        const toggle = findCouponToggle();
        if (!target && !toggle) return; // coupon UI not on this page (yet) — MutationObserver will retry

        const form = findCouponForm();
        const input = findCouponInput(form);
        const submit = findCouponSubmit(form);

        // Belt and braces: disable the underlying controls too, in case the
        // overlay's positioning gets knocked off by a later Shoptet re-render.
        if (input) input.disabled = true;
        if (submit) submit.disabled = true;
        if (toggle) toggle.disabled = true;

        if (target && !target.querySelector(":scope > .vip-coupon-overlay")) {
            const computed = getComputedStyle(target);
            if (computed.position === "static") {
                target.style.position = "relative";
            }

            const overlay = document.createElement("div");
            overlay.className = "vip-coupon-overlay";
            overlay.style.position = "absolute";
            overlay.style.inset = "0";
            overlay.style.zIndex = "999";
            overlay.style.background = "linear-gradient(135deg, rgba(55,55,55,0.88) 0%, rgba(95,95,95,0.82) 45%, rgba(35,35,35,0.9) 100%)";
            overlay.style.boxShadow = "inset 0 0 0 1px rgba(255,255,255,0.15)";
            overlay.style.borderRadius = "8px";
            overlay.style.pointerEvents = "auto";
            overlay.style.cursor = "default";
            overlay.addEventListener("click", (e) => e.preventDefault());
            overlay.addEventListener("mousedown", (e) => e.preventDefault());

            const msgText = document.createElement("div");
            msgText.style.position = "absolute";
            msgText.style.top = "12px";
            msgText.style.right = "14px";
            msgText.style.width = "220px";
            msgText.style.maxWidth = "60%";
            msgText.style.textAlign = "right";
            msgText.style.color = "#7ed321";
            msgText.style.fontWeight = "700";
            msgText.style.fontSize = "1em";
            msgText.style.lineHeight = "1.35";
            msgText.style.textShadow = "0 1px 2px rgba(0,0,0,0.35)";
            msgText.style.textTransform = "uppercase";
            msgText.textContent = MESSAGE;
            overlay.appendChild(msgText);

            const fishLogo = document.createElement("img");
            fishLogo.src = FISH_LOGO_URL;
            fishLogo.alt = "";
            fishLogo.style.position = "absolute";
            fishLogo.style.right = "14px";
            fishLogo.style.bottom = "12px";
            fishLogo.style.width = "132px";
            fishLogo.style.height = "132px";
            fishLogo.style.objectFit = "contain";
            fishLogo.style.opacity = "0.95";
            fishLogo.style.filter = "drop-shadow(0 1px 3px rgba(0,0,0,0.35))";
            fishLogo.onerror = () => fishLogo.remove(); // logo failed to load — skip silently

            overlay.appendChild(fishLogo);
            target.appendChild(overlay);
        }

        target?.setAttribute("data-vip-coupon-locked", "1");
        if (form) form.dataset.vipCouponLocked = "1";
        if (toggle) toggle.dataset.vipCouponLocked = "1";
    }

    function unlockCoupon() {
        const target = findLockTarget();
        const form = findCouponForm();
        const toggle = findCouponToggle();
        const wasLocked = target?.getAttribute("data-vip-coupon-locked") || form?.dataset.vipCouponLocked || toggle?.dataset.vipCouponLocked;
        if (!wasLocked) return;

        const input = findCouponInput(form);
        const submit = findCouponSubmit(form);

        if (input) input.disabled = false;
        if (submit) submit.disabled = false;
        if (toggle) {
            toggle.disabled = false;
            delete toggle.dataset.vipCouponLocked;
        }
        if (form) delete form.dataset.vipCouponLocked;

        target?.removeAttribute("data-vip-coupon-locked");
        target?.querySelector(":scope > .vip-coupon-overlay")?.remove();
    }

    function run() {
        const tier = getTier();
        if (tier && LOCKED_TIERS.includes(tier)) {
            lockCoupon();
        } else {
            unlockCoupon();
        }
    }

    function init() {
        run();
        let timeout;
        const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(run, 200);
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

    window.addEventListener("vipReady", run);
    document.addEventListener("shoptet.cart-updated", () => setTimeout(run, 200));
})();
