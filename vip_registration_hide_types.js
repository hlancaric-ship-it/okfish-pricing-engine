(() => {
    "use strict";

    console.log("%cVIP REGISTRATION — skryje typ zákazníka, nechá jen běžnou registráciu", "background:#28a745;color:white;padding:4px 8px;font-weight:bold;font-size:12px;border-radius:3px;");

    function hideOption(id) {
        const input = document.getElementById(id);
        if (!input) return false;
        const wrapper = input.closest("label") || input.parentElement;
        if (wrapper) wrapper.style.display = "none";
        return true;
    }

    // ZR4 is the only real choice left once the other two are hidden, so instead of
    // trying to relabel/restyle a single lonely radio button (which looked broken —
    // native checkbox with no wrapping style), we just select it silently and hide
    // it too. The customer never needs to see or choose anything here.
    function selectAndHideZr4() {
        const zr4 = document.getElementById("zr4");
        if (!zr4) return false;
        zr4.checked = true;
        const wrapper = zr4.closest("label") || zr4.parentElement;
        if (wrapper) wrapper.style.display = "none";
        return true;
    }

    function hideHeading() {
        // Find the smallest element whose own trimmed text is exactly "Typ zákazníka"
        // — walking every element (not just headings) since the real markup here
        // turned out to be a plain div/p, not a semantic heading tag.
        const candidates = Array.from(document.querySelectorAll("body *"))
            .filter(el => el.children.length === 0 && el.textContent.trim() === "Typ zákazníka");
        if (candidates.length === 0) return false;
        candidates.forEach(el => { el.style.display = "none"; });
        return true;
    }

    function run() {
        const hidKoncovy = hideOption("koncovy-zakaznik");
        const hidWholesale = hideOption("wholesale");
        const didZr4 = selectAndHideZr4();
        const hidHeading = hideHeading();
        return hidKoncovy && hidWholesale && didZr4 && hidHeading;
    }

    function init() {
        if (run()) return; // already done, no need to keep observing
        let timeout;
        const observer = new MutationObserver(() => {
            clearTimeout(timeout);
            timeout = setTimeout(() => {
                if (run()) observer.disconnect();
            }, 150);
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
})();
