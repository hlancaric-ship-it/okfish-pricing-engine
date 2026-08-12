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

## 2026-08-12

### INC-005
**Popis:**
`sync.yml` selhal opakovaně (11× za předchozích 7 dní) ve kroku "Synchronizace produktových dat pro frontend badge" — `sync-products.ts`.

**Příčina:**
Přechodné síťové chyby (`HeadersTimeoutError`, `SocketError: other side closed`, `HTTP 502` z master feedu) shazovaly celý krok na první chybu. Cron (15 min) fungoval jako záložní síť, takže dopad byl jen krátké zpoždění badge dat, ale selhání bylo hlučné (issue #3 dostával komentář skoro denně).

**Oprava:**
Zaveden `fetchWithRetry()` (3 pokusy, exponenciální backoff 1s/3s/9s) na všech 4 síťových voláních v `sync-products.ts` (feed fetch, import/begin, import/chunk, import/finish). Retry jen na 5xx/429/síťové chyby, ne na 4xx (skutečné chyby se dál hlásí okamžitě).

**Verze:**
main (2026-08-12, commit `c71ca20`)

---

### INC-006
**Popis:**
Pokud selhalo načtení seznamu ceníků ze Shoptet API (`getPricelists()`), `sync-orchestrator.ts` to tiše "prohltl" — zalogoval chybu a normálně se vrátil, místo aby ji propagoval. GitHub Actions krok tak mohl doběhnout jako zelený checkmark i při úplném selhání synchronizace (0 zpracovaných produktů), bez error logu a bez notifikace.

**Příčina:**
`catch (error) { console.error(...); return; }` — `return` místo `throw`, takže `run-real-sync.ts`, které nastavuje `exitCode = 1` jen při vyhozené výjimce, žádnou chybu nezaznamenalo.

**Oprava:**
`return` nahrazeno `throw error;`. Stejná třída chyby, jakou tým už jednou řešil obecně (viz komentář v `run-real-sync.ts`), ale tahle konkrétní větev tehdy opravena nebyla.

**Verze:**
main (2026-08-12, commit `7f70f27`)

---

### INC-007 (největší dopad na náklady)
**Popis:**
Frontend product-discount cache (KV, `/v1/product-discount/:code/:tier`) se přepisovala **kompletně celá** při každém běhu (cron 15 min + každý webhook) — potvrzeno živě: 16 708 zápisů za jeden běh, ~1,6M KV zápisů/den, bez ohledu na to, jestli se cokoliv reálně změnilo. Staré verzované klíče (`product:${version}:${code}`) se navíc nikdy nemazaly — neomezeně rostoucí KV storage, na rozdíl od zákaznické cache, která cleanup má.

**Příčina:**
`/v1/products/import/chunk` dělal nepodmíněný `KV.put()` pro každý produkt v dávce, bez porovnání s tím, co už v KV je.

**Oprava:**
Přechod na stabilní klíč (`product:${code}`, bez verze), zápis jen když se obsah reálně liší od uloženého (`KV.get()` → porovnání → případný `KV.put()`). Čtecí endpoint zkouší nejdřív stabilní klíč, padá zpátky na starý verzovaný klíč, dokud není stabilní klíč naplněný — bez výpadku dat během přechodu. Ověřeno na stagingu i naostro na reálných 16 708 produktech: 2. běh po nasazení zapsal jen ty skutečně změněné (1, resp. 0 při dalším běhu), zbytek přeskočen. `sync-products.ts` teď v souhrnném logu hlásí `written`/`skipped`.

**Poznámka:** Appka pro Pavola (desktop, v1.1.0) volá stejný `/v1/products/import/chunk` endpoint, takže z opravy těží automaticky, bez jakékoli úpravy appky.

**Zbývá (nedokončeno, vědomě odloženo):** Stejný vzorec (posílání kompletních dat bez diffu) platí i pro zápis cen přímo do Shoptet ceníků (PATCH) — `.price_cache.json`, který má sloužit k diffu, se nikdy nezachová mezi GitHub Actions běhy (efemérní runner, žádný `actions/cache` krok), takže se i tam posílá plný ceník pokaždé. Vyžaduje stejně opatrný postup (staging test, before/after porovnání) jako u KV — zatím neřešeno.

**Verze:**
main (2026-08-12, commit `ee37a3f` + `93084a1`... viz `index.ts`/`sync-products.ts`)

---

### INC-008
**Popis:**
`force-customer-discount.yml` (ruční zápis natvrdo nastavené slevy jednomu zákazníkovi) neměl na rozdíl od sourozeneckých one-off skriptů žádnou dry-run pojistku — překlep v e-mailu nebo v % slevy šel rovnou do produkce.

**Oprava:**
`force-customer-discount-live.ts` teď defaultně jen vypíše, co by se zapsalo; ostrý zápis vyžaduje `LIVE=true`. Workflow dostal stejný `live` boolean přepínač jako `reset-cap-outside-brandlist.yml` a další.

**Verze:**
main (2026-08-12, commit `122ff37`)

---

### INC-009
**Popis:**
`disable-negative-stock.ts` sám o sobě dry-run podporuje (výchozí chování bez `--live`), ale `disable-negative-stock.yml` volal skript vždy s natvrdo zapsaným `--live` — pojistka existovala v kódu, ale workflow ji obcházel.

**Oprava:**
Workflow dostal `live` boolean vstup (default `false`), skript se podle něj spouští s/bez `--live`.

**Verze:**
main (2026-08-12, commit `122ff37`)

---

### Provozní úklid (ne incident, ale součást stejného zásahu)
Bezpečnostní/architektonický audit (2026-08-12) odhalil ~30 jednorázových debug/export/find/fix/verify workflow souborů z incident-response práce (3.–6. 8. 2026), které už splnily účel a jen zbytečně zahlcovaly seznam GitHub Actions tlačítek. Přesunuty do `.github/workflows-archive/` (git historie zachována, GitHub Actions je už nevidí/nenabízí ke spuštění). `sync-guest-coupon-cap.yml` mezi nimi — jeho rozbitá logika už jednou způsobila reálný incident (přepis stropů slev na 14 606 produktech, 5.8.2026), cron byl vypnutý, ale skript samotný nikdy opraven — archivace ho znepřístupnila i pro manuální spuštění.

Audit dále odhalil (zatím neřešeno, čeká na rozhodnutí):
- Sdílený hardcoded token (`SECRET_TOKEN`) v `index.ts` i v appce pro Pavola — vědomě ponechán beze změny (appku používá jen Pavol, riziko akceptováno).
- CORS `*` i na chráněných endpointech, autentizace přes `?token=` v URL u pár endpointů.
- `R2` feed bucket bez cleanupu (stejný vzorec jako u KV, ještě neopravený).
- `DiscountLimitPolicy`/`HighestDiscountPolicy`: chybějící validace vstupů (neznámý tier, nevalidovaný `productMaxDiscount`).
- Nulové testy pro `rate-limiter.ts`, `client.ts`, `customer-writer.ts`, `pricelist-writer.ts`, `DiscountLimitPolicy.ts`.
- `npm audit` v `cloudflare-worker/`: 14 zranitelností (5 moderate, 7 high, 2 critical), nezkoumáno do hloubky.

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
