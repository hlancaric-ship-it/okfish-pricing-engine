# Incident Log

Tento dokument slouží pro evidenci incidentů a chyb zjištěných v produkčním provozu.

Každý záznam by měl obsahovat: datum, popis problému, příčinu, řešení a verzi systému, ve které chyba nastala.

---

## 2026-08-03

### INC-001
**Popis:**
Inkrementální sync `products-reader.ts` ztrácel `productMaxDiscount` (a případně další cenová pole) u produktů synchronizovaných mimo full sync.

**Příčina:**
Kód četl neexistující top-level pole `detail.price` / `detail.sales.minPriceRatio`. Tato pole existují jen uvnitř `detail.perPricelistPrices[]` (vyžaduje `?include=perPricelistPrices` v API dotazu).

**Oprava:**
`products-reader.ts` teď hledá odpovídající položku v `perPricelistPrices[]` podle `pricelistId` a bere `price.price`, `price.actionPrice.price`, `sales.minPriceRatio` odtud. Pokud shoda chybí, loguje varování a přeskočí cenová data (místo tichého zápisu falešné 0% slevy). Regresní testy: `cloudflare-worker/tests/products-reader.test.ts`.

**Verze:**
main (2026-08-03)

---

### INC-002
**Popis:**
Po full syncu zůstala v Cloudflare KV cache jen malá část zákazníků (řádově jednotky místo tisíců) — většina zákazníků přestala dostávat slevu.

**Příčina:**
`sync-orchestrator.ts` při full syncu zapisoval do KV jen zákazníky, kterým se změnil tier (`customerDiffs`), ne všechny. Full sync ale atomicky nahrazuje CELOU aktivní verzi KV — takže zákazníci bez změny tieru z cache úplně zmizeli.

**Oprava:**
Při `isFullSync` se před `commit()` navíc projde celý nefiltrovaný `customerDiffsRaw` a zapíšou se i nezměnění zákazníci. Opravena i podmínka spouštějící `commit()` (`processed > 0 || isFullSync`).

**Verze:**
main (2026-08-03)

---

### INC-003 (nejzávažnější)
**Popis:**
Automatický `coupon-fields.yml` cron (2×/den) přepisoval reálné pole "Maximální povolená sleva" u produktů, čímž je nekontrolovaně měnil (pozorováno např. 11 % → 2 %).

**Příčina:**
`coupon-sales-writer.ts` zapisoval GUEST-tier coupon data do pricelistu 1 ("Hlavný cenník") — to je ALE stejný záznam, ze kterého Shoptet čte skutečný strop "Maximální povolená sleva" na produktu.

**Oprava:**
`processTierBatch()` teď tvrdě odmítá jakýkoliv zápis do `GUEST_PRICELIST_ID` (pricelist 1), loguje varování a vrací no-op stats. Ověřeno živě přes log grep při dalším běhu. Regresní testy: `cloudflare-worker/tests/coupon-sales-writer.test.ts`.

**Verze:**
main (2026-08-03)

---

---

## 2026-08-04

### INC-004
**Popis:**
Produkty s aktivní výprodejovou/akční cenou HLUBŠÍ než nově nastavený strop "Maximální povolená sleva" na produktu měly cenu nesprávně zvednutou (oslabenou) až na úroveň stropu — příklad: VAGNER Magic In-Line 21, akční cena 281,67 € (~18 %), po nastavení stropu 10 % se cena ve všech ceníkách chybně přepočítala na 309,71 € (10 %). Šlo o chybu v samotném cenovém enginu, přítomnou od začátku (netýkalo se jen tohoto jednoho zásahu).

**Příčina:**
`DiscountLimitPolicy.ts` (root engine) i `calculateAllTierPrices()` (Worker engine `cloudflare-worker/src/engine/pricing.ts` + jeho 1:1 port `desktop-app/lib/pricingEngine.js`) aplikovaly cenový strop jako spodní hranici (floor) na VÝSLEDNOU cenu bez ohledu na to, jestli pochází z akční ceny, nebo z věrnostního tieru. Klientův explicitní požadavek: pokud je na produktu aktivní akční/výprodejová cena, MUSÍ zůstat beze změny — strop smí omezovat jen věrnostní/kupónovou slevu navrch, nikdy nesmí akční cenu zvednout, ani ji přebít vyšší tierovou slevou.

**Oprava:**
Ve všech třech místech: pokud je aktivní strop (`activeLimit`/`minAllowedPrice`) A zároveň existuje akční cena (`salePrice`/`actionPrice`), použije se vždy akční cena — bez porovnávání s tierovou slevou a bez floor-clampu. Strop dál normálně omezuje čistě tierovou/kupónovou slevu, když akční cena chybí. Regresní test: `tests/pricing-parity.test.ts`, profil `action-price-steeper-than-cap` (121/121 kombinací obou enginů prochází shodně).

**Dopad:**
Mohlo se to týkat kteréhokoli produktu v celém katalogu s kombinací (aktivní výprodej + nastavený strop), ne jen VAGNERu — doporučeno po nasazení opravy znovu spustit `sync.yml` (plný běh), aby se případné dotčené ceny v katalogu přepočítaly správně.

**Verze:**
main (2026-08-04)

---

*(Řádky výše jsou první reálné produkční incidenty. Formát pro další záznamy viz vzor níže.)*

<!-- Vzor záznamu:
## 2026-07-21

### INC-001
**Popis:**
VIP cena se nezobrazila po změně varianty.

**Příčina:**
...

**Oprava:**
...

**Verze:**
1.0.0-RC1
-->
