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
