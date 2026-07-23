# VIP Pricing Engine – Runbook

**Aktuální verze:** 1.1.0 (2026-07-23)

Tento dokument slouží jako provozní manuál pro údržbu, aktualizaci a diagnostiku VIP cenového systému.

## 🧩 Architektura (od 2026-07-23)

Worker (`shoptet-vip-worker.hlancaric.workers.dev`, **ne** `vip.okfish.cz` — ta doména
na Worker nikdy nemířila a `okfish.cz` ani není zóna na tomto Cloudflare účtu) obsluhuje
dva nezávislé datové okruhy, oba ve stejném KV namespace, ale s vlastní Blue/Green
verzí (`active_customer_version` / `active_product_version`), takže se nemůžou navzájem
ovlivnit:

- **Zákazníci** (`/v1/import/*`, `GET /v1/discount/:hash`) — e-mail (hash) → % sleva
  věrnostního tieru zákazníka. Plní `npm run generate` (viz níže).
- **Produkty** (`/v1/products/import/*`, `GET /v1/product-discount/:code/:tier`) —
  skutečná (per-produkt) cena/sleva pro daný tier, počítaná stejným enginem, co píše
  finální ceníky. Plní `npm run sync-products` (v `cloudflare-worker/`), nezávisle na
  existujícím feed-generation cronu (`crons` v `wrangler.toml`) — ten se tímhle vůbec
  nemění a dál běží jak předtím.

**Frontend** (nahrává se přes FTP, vkládá se přes `<script src="...">` v HTML hlavičce
Shoptetu):
- `vip_prices.js` — loader. Zjišťuje e-mail přihlášeného zákazníka, ptá se
  `/v1/discount/:hash`, plní `window.vipDiscounts` a vysílá event `vipReady`. **Na tomhle
  závisí úplně všechno ostatní — nikdy ho nenahrazovat obsahem jiného skriptu.**
- `vip_detail.js`, `vip_cart.js`, `vip_catalog.js` — vizuální dekorace (přeškrtnutá
  původní cena + %), každý pro jinou část webu. Všechny se ptají
  `/v1/product-discount/:code/:tier` na **skutečnou** slevu daného produktu — žádný
  z nich nepočítá slevu jen z ploché % sazby zákazníkova tieru (to byla stará chyba:
  produkt s `maxDiscount` stropem nebo vypnutou věrnostní slevou — např. dárkové
  poukazy — má jinou efektivní slevu než je zákazníkova surová sazba).
- `vip_cart.js` navíc vypisuje "Spolu ušetríte: X €" pod celkovou cenou košíku —
  dopočítáno ze skutečného rozdílu cen jednotlivých položek, **nikdy nepřepisuje**
  samotnou celkovou cenu košíku (Shoptet ji už počítá správně sám z ceníku).

## 🔄 Aktualizace produktových dat (Pravidelný proces)

```
cd cloudflare-worker
npm run sync-products
```

Stáhne živý master feed (`MASTER_FEED_URL` z `.env`), streamuje ho stejným parserem
jako produkční feed-generation, a nahraje do `product` KV cache na Workeru. Bezpečné
spustit kdykoliv — nezávislé na feed-generation cronu, nic jiného neovlivní. Spouštět
znovu vždy, když se změní ceny/akce v Shoptetu (badge jinak ukazují stará čísla).

## 🔄 Aktualizace zákazníků (Pravidelný proces)

Provozní postup pro aktualizaci slevových hladin zákazníků na základě nových dat:

1. **Export zákazníků ze Shoptetu**
   - Vyexportujte aktuální data zákazníků ze Shoptetu.
   - Uložte je k tomuto projektu.
2. **Spustit generátor**
   - V terminálu spusťte generátor (např. `npm run generate`).
   - Skript automaticky vyhodnotí slevy, vygeneruje `customers_import.csv` a **automaticky spustí synchronizaci do Cloudflare KV**.
   - Na konci běhu uvidíte shrnutí (počet odeslaných zákazníků a vyčištění staré verze).
3. **Nahrání do Shoptetu (Backend)**
   - V administraci Shoptetu naimportujte vygenerovaný soubor `exports/customers_import.csv` (nebo `.xlsx`).
   - **Hotovo!** Na FTP se již žádné JSON soubory nenahrávají. Zákazníci si stahují data z Workeru (`https://vip.okfish.cz`).
5. **Ověření po nasazení**
   - Zkontrolujte na e-shopu alespoň jednoho zástupce z:
     - `ZR4`
     - `ZR10`
     - `ZR25`

## ⏪ Rollback (Návrat do předchozího stavu)

Pokud se import nepovede, můžete obnovit záložní export:

1. **Obnovit předchozí databázi** nahráním předchozího `customers_import.csv` zpět do Shoptetu.
2. Odeslání dat do Cloudflare Workeru lze kdykoliv zopakovat vygenerováním staršího CSV z původních dat (Worker podporuje bezstavový Upsert – "poslední vyhrává").

## 🛠 Diagnostika a řešení problémů

Při řešení problémů (např. nezobrazování slevy konkrétnímu uživateli):

1. **Aktivace Debug režimu**
   - Ve skriptu `vip_prices.js` dočasně změňte:
     `const VIP_DEBUG = true;`
2. **Kontrola Konzole**
   - V DevTools prohlížeče (F12) hledejte hlášení začínající na `[VIP]`:
     - Verze, Email, Hash, uplatněná sleva a přepočet pro konkrétní produkt.
3. **Kontrola Cloudflare KV a API**
   - Pokud konzole hlásí, že zákazník nemá slevu, otevřete přímo v prohlížeči: `https://vip.okfish.cz/v1/discount/<hash>`
   - Mělo by vrátit formát: `{"v":1,"discount":6}`. Pokud vrátí `discount: 0`, zákazník v systému opravdu není.
4. **Kontrola `.env`**
   - Aby generátor fungoval, musí v hlavní složce existovat soubor `.env` obsahující:
     ```
     CF_WORKER_URL=https://vip.okfish.cz
     CF_WORKER_TOKEN=<token>
     ```

## 📋 Nasazení Cloudflare Workeru (Pro vývojáře)

Tento projekt používá architekturu Blue/Green s bezvýpadkovým přepnutím verzí a aktivním Garbage Collection (čištěním starých dat). Pro nasazení Workeru:

1. Jděte do složky `cloudflare-worker`
2. Spusťte `npm install`
3. Přidejte tajný token pro importní API: `npx wrangler secret put SECRET_TOKEN`
4. Publikujte Worker na produkci: `npm run deploy`
