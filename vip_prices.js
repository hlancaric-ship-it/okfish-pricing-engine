(async function() {
    const VIP_VERSION = "1.0.0";
    const VIP_DEBUG = false;

    function debug(...args) {
        if (VIP_DEBUG) {
            console.log("[VIP]", ...args);
        }
    }

    debug("Version:", VIP_VERSION);

    // 1. Získáme e-mail přihlášeného zákazníka ze Shoptet objektu
    const email = (window.shoptet?.customer?.email || "").toLowerCase();
    
    if (email) {
        debug("Email:", email);
    }
    
    // Pokud zákazník není přihlášen, nemá smysl nic stahovat
    if (!email) return;

    // 2. Bezpečná hashovací funkce (SHA-256) nativně v prohlížeči
    async function hashEmail(str) {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    try {
        const hash = await hashEmail(email);
        const prefix = hash.substring(0, 2);
        
        debug("Hash:", hash);
        
        // 3. Stahujeme POUZE malý soubor s hashem daného e-mailu z podsložky (V3)
        // Předpoklad: složka "vip" je přes FTP nahraná do /user/documents/upload/vip/
        const res = await fetch(`/user/documents/upload/vip/${prefix}/${hash}.json`, { cache: "default" });
        
        // Pokud server vrátí 404, znamená to, že zákazník žádnou VIP slevu nemá.
        // Potichu skončíme.
        if (!res.ok) return;

        const data = await res.json();
        const discount = data.d;

        if (typeof discount !== "number") return;
        
        debug("Discount:", discount);

        // 4. Funkce pro aplikaci slevy (včetně dynamického načítání)
        function applyVipDiscount() {
            const priceElements = document.querySelectorAll(
                '.price-final-holder, ' + 
                '.product .price, ' +
                '.p-bottom > div > .price, ' +
                '.cart-summary-item.price'
            );

            priceElements.forEach(el => {
                let targetEl = el.querySelector('.price-final') || el;
                
                // Přeskakujeme naše vlastní vložené prvky
                if (targetEl.classList.contains('vip-price-new') || targetEl.closest('.vip-price-container')) return;

                const text = targetEl.textContent;
                
                // Pokud je text stejný jako při posledním průchodu, neděláme nic
                if (targetEl.dataset.lastProcessedText === text) return;

                const match = text.match(/[\d\s\u00A0]+(?:,\d+)?/);
                
                if (match) {
                    const originalStr = match[0];
                    const customerPrice = parseFloat(originalStr.replace(/[\s\u00A0]/g, '').replace(',', '.'));
                    
                    if (!isNaN(customerPrice)) {
                        // Shoptet už zobrazuje cenu po slevě, dopočítáme původní cenu před slevou
                        const originalPrice = customerPrice / (1 - (discount / 100));
                        
                        debug("Product:", originalPrice, "->", customerPrice);
                        const hasDecimals = originalStr.includes(',');
                        const formatter = new Intl.NumberFormat('sk-SK', {
                            minimumFractionDigits: hasDecimals ? 2 : 0,
                            maximumFractionDigits: 2
                        });
                        
                        const formattedOriginalPrice = formatter.format(originalPrice);
                        const formattedCustomerPrice = formatter.format(customerPrice);
                        
                        const originalPriceText = text.replace(originalStr, formattedOriginalPrice);
                        const customerPriceText = text.replace(originalStr, formattedCustomerPrice);
                        
                        let vipContainer = targetEl.nextElementSibling;
                        if (!vipContainer || !vipContainer.classList.contains('vip-price-container')) {
                            vipContainer = document.createElement('div');
                            vipContainer.className = 'vip-price-container';
                            targetEl.style.display = 'none'; // Skryjeme původní uzel
                            targetEl.parentNode.insertBefore(vipContainer, targetEl.nextSibling);
                        }
                        
                        vipContainer.innerHTML = `
                            <span class="original-price" style="text-decoration: line-through; opacity: 0.7;">${originalPriceText}</span>
                            <span class="vip-price-new" style="font-weight: bold; color: #e4002b; margin-left: 6px;">${customerPriceText}</span>
                            <span class="vip-badge" style="background: #e4002b; color: white; padding: 2px 6px; border-radius: 4px; font-size: 0.8em; margin-left: 6px;">VIP -${discount} %</span>
                        `;
                        
                        // Zaznamenáme si, jaký text jsme zpracovali
                        targetEl.dataset.lastProcessedText = text;
                    }
                }
            });
        }

        // Aplikujeme při načtení
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', applyVipDiscount);
        } else {
            applyVipDiscount();
        }

        // Sledujeme změny na stránce (např. přepnutí varianty) s debouncem
        let observerTimeout;
        const observer = new MutationObserver((mutations) => {
            let shouldApply = false;
            for (let mutation of mutations) {
                if (mutation.addedNodes.length > 0 || mutation.type === 'characterData') {
                    shouldApply = true;
                    break;
                }
            }
            if (shouldApply) {
                clearTimeout(observerTimeout);
                observerTimeout = setTimeout(() => {
                    applyVipDiscount();
                }, 100);
            }
        });
        
        observer.observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true
        });

    } catch (err) {
        console.warn("VIP: Chyba při ověřování slevy.", err);
    }
})();
