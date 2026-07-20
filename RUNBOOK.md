# VIP Pricing Engine – Runbook

**Aktuální verze:** 1.0.0

Tento dokument slouží jako provozní manuál pro údržbu, aktualizaci a diagnostiku VIP cenového systému.

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
