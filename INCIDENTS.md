# Incident Log

Tento dokument slouží pro evidenci incidentů a chyb zjištěných v produkčním provozu.

Každý záznam by měl obsahovat: datum, popis problému, příčinu, řešení a verzi systému, ve které chyba nastala.

---

## 2026-08-13 -- INC-011: Kupónová pole napříč katalogem nespolehlivá (OTEVŘENO, NEDOŘEŠENO)

**Popis (Jan, živě z adminu):** Kupónová pole (`Slevový kupón` checkbox + skutečná
hodnota `minPriceRatio`/kolik % kupónu) nejsou napříč katalogem spolehlivě
doplněná. Konkrétně: checkbox `Slevový kupón` je u některých produktů
zaškrtnutý, ale reálná hodnota (kolik % kupónu = jak moc `minPriceRatio`
dovoluje) není správně dopočítaná/zapsaná. U tierů **ZR20 a ZR25** má
`coupon-policy.json` (`lockedTiers: ["ZR20", "ZR25"]`) kupón automaticky
VYPÍNAT (Rule 4, absolutní precedence, viz `CORE_LOGIC_AND_VALIDATION.md`
§1.2) -- Jan potvrzuje, že se to na živých datech neděje spolehlivě.

**Co je ověřeno:**
- `coupon-policy.json` skutečně definuje `lockedTiers: ["ZR20", "ZR25"]` --
  záměr v konfiguraci je správný.
- Živá kontrola na 103525/ZR20 a ZR25 ukázala `discountCoupon: false,
  minPriceRatio: "0.000"` -- VYPADÁ to správně, ale **Jan potvrdil, že tenhle
  konkrétní produkt opravil RUČNĚ sám** (stejný stopgap jako u cen ráno) --
  tenhle test tedy NEDOKAZUJE, že automatizovaný coupon pipeline funguje
  správně. Nepoužitelný jako důkaz, potřeba testovat na produktu, který
  nikdo ručně neopravoval.

**ROZSAH ZJIŠTĚN (živá kontrola celého katalogu, ZR20+ZR25):**
Z 16 712 položek na ZR20 i ZR25: **61 produktů má `discountCoupon: TRUE`**
(porušuje lock), **16 644 je v pořádku** (`false`, lock funguje), 7 nemá
cenu vůbec. Stejných 61 kódů na obou tierech. Vzorek kódů: `101256,
101283, 101607, 110400, 112054-112070...` -- **velká část se překrývá s
ranním seznamem "55 úplně chybějících produktů"** z katalogového auditu
(INC-010). **Závěr: NENÍ to celoplošný bug -- je to omezené na malou
skupinu (~0,4 % katalogu) nových/nedokončeně synchronizovaných produktů,
stejná rodina příčiny jako hlavní dnešní incident, ne nový nezávislý
celoplošný problém.** Zámek ZR20/ZR25 funguje správně pro 99,6 % katalogu.

**Co NENÍ ověřeno / čeká na příští session (kontext došel, nedokončeno
poctivě, ne uzavřeno):**
- Přesný seznam všech 61 kódů (jen vzorek 15 zaznamenán) -- uložit celý
  seznam a porovnat 1:1 s ranním seznamem 55 chybějících.
- Jestli je to VŽDY stejná skupina produktů co chybí na cenách i kupónech
  (jeden root cause, dva projevy), nebo částečně odlišné množiny.
- Root cause -- podezření na stejnou třídu problémů jako INC-010
  (`sync-coupon-fields-single-product.ts` běží jen na webhook, žádný
  plošný fallback po archivaci `coupon-fields.yml`/`coupon-fields-full-live.yml`
  do `.github/workflows-archive/`), ale NEOVĚŘENO na reálných datech pro
  tenhle konkrétní projev (checked-bez-hodnoty, ZR20/25 lock neaplikovaný).
- Navrhovaný přístup pro příště: obdoba `reconcile-pricelist-drift.ts`
  (Stage 5), ale pro kupónová pole -- pro každý produkt×tier spočítat
  očekávaný `discountCoupon`/`minPriceRatio` přes `computeCouponWrites()`
  (stejná produkční funkce) a porovnat s tím, co Shoptet skutečně má.
  ZR20/ZR25 by měly VŽDY vyjít `discountCoupon:false` bez ohledu na
  cokoliv jiného (Rule 4 absolutní precedence) -- to je nejjednodušší
  a nejjednoznačnější první kontrola.
- Jan: "tohle nas klient roseka na kusy" -- vysoká priorita, business-critical,
  ne kosmetická věc. Řešit hned na začátku příští session, ne odkládat.

**Verze:** main (2026-08-13), NEUZAVŘENO.

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

### Ověření stability (2026-08-13) — issue #3 zavřen
Po opravách z 12.8. (retry logika, propagace chyby, diff-aware KV) proběhlo 15+ po sobě jdoucích úspěšných běhů `sync.yml`, žádné selhání. Zachycen i první reálný test po opravě: běh 12.8. 20:09 správně zpracoval a zapsal 1 zákazníka se změněným věrnostním tierem (`CustomerWriter: Nalezeno 1 zákazníků`, `Customers processed: 1`). Issue #3 zavřen s odkazem na tuhle stabilitu.

**Zjištění k zákaznické cache (ne bug, jen upřesnění rozsahu):** ověřeno v `customer-adapter.ts` — `processCustomers()` v inkrementálním režimu volá `getCustomerChanges(lastSync)`, tedy filtruje už na úrovni Shoptet API, ne až lokálně. Zákaznická cache sice (na rozdíl od produktové) nemá diff-aware zápis do KV — co se načte, to se zapíše bez porovnání se starou hodnotou — ale protože se běžně načítá jen hrstka změněných zákazníků za běh (potvrzeno v logu: `Customers loaded` 0–4, nikdy 47 800), reálný dopad plýtvání je malý. Všech ~47 800 zákazníků se zapíše najednou jen při **full syncu** (`isFullSync=true`, tj. když `.sync_state.json` nemá `lastSync` — první běh nebo ruční reset stavu).

**Zbývá (odloženo, ne urgentní):** stejná diff-aware oprava jako u produktů (INC-007) by šla udělat i pro zákaznickou KV cache — nízká priorita vzhledem k výše uvedenému zjištění, plánováno jako samostatný budoucí úkol.

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

## 2026-08-13

### INC-010
**Popis:**
Produkty 99459 a 103525 (přidané Yopni 12.8.) neměly vůbec dopočítané tier-ceny na wholesale ceníku — Jan je musel dopisovat ručně. Na frontendu se přihlášenému ZR25 zákazníkovi zobrazovalo jen -10 % místo -25 %. `sync.yml` doběhl přesto zeleně.

**Příčina (dvě nezávislé díry, obě přispěly):**
1. `products-reader.ts` (inkrementální větev): když Shoptet ještě nepropsal `perPricelistPrices` pro čerstvě založený produkt na základní ceník, kód fabrikoval `basePrice=0` a poslal produkt dál do enginu jako platný.
2. `pricing-bridge.ts`: `validateInput`/`validateResult`/`res.rejected`/vyhozená výjimka se pro konkrétní SKU+tier tiše zahodily (`catch (e) { /* Ignore */ }`) bez logu a bez počítání jako failure; `sync-orchestrator.ts` tak nikdy neviděl, že něco chybí, a `isSuccess` se sice vytiskl jako `FAILED` do konzole, ale nikdy se nepropagoval jako `throw` — `run-real-sync.ts` viděl exit 0, GitHub Actions job zůstal zelený.

Souběžně (nezávisle zjištěno ve stejný den, viz commit `85de937`): Shoptet `/products/changes` endpoint tyhle dva produkty vůbec nikdy nenahlásil jako změněné, takže inkrementální sync by je nenašel ani po opravě výše.

**Oprava:**
- `products-reader.ts`: chybějící `perPricelistPrices` entry produkt vynechá z běhu (`incompleteCodes`) místo fabrikace ceny 0; stejná ochrana teď platí i pro `force-sync-products.json` escape hatch (commit `85de937`) — obě cesty používají shodnou pricelistEntry logiku.
- `pricing-bridge.ts`: každé selhání validace/výpočtu/zamítnutí se loguje (`console.warn` s SKU+tier+reason) a vrací se v poli `failures`.
- `sync-orchestrator.ts`: `isSuccess` zohledňuje `incompleteCodes` i `pricingFailures`; při neúspěchu se `lastSync` neposune (produkt se zkusí znovu za 15 min) a na konci se hodí `throw` — GitHub Actions job zčervená a spustí se issue-notifikace (mechanismus v `sync.yml` existoval už z INC-006, jen se tady nikdy nespustil).
- `FLACARP` zvažován pro `brandLimits` (10% strop) — vědomě NEpřidán teď, platit má až od 2026-08-14 na Janovo přání.

**Merge se souběžnou opravou (85de937, jiná session, stejný den):**
Při nasazení se zjistilo, že mezitím na `origin/main` přibylo 60 commitů (většina automatické `chore: aktualizace času poslední synchronizace [skip ci]` z cronu, ale 7 reálných: INC-005 až INC-009 dokumentované výše + `85de937` "force-sync escape hatch pro 99459/103525"). `85de937` řeší JINOU příčinu stejného incidentu: Shoptet `/products/changes` endpoint tyhle dva produkty vůbec nikdy nenahlásil jako změněné (potvrzeno přímým dotazem na živé API přes 2+ dny), takže by je inkrementální sync nenašel, ani kdyby `perPricelistPrices` bylo v pořádku. Řešení: `force-sync-products.json` se seznamem `{code, guid}` párů, které se natáhnou vždy navíc, mimo `/products/changes`.

Konflikt v `products-reader.ts` a `sync-orchestrator.ts` vyřešen ručním sloučením obou oprav (`git merge`, ne rebase) — force-sync větev teď taky respektuje `incompleteCodes` ochranu (nefabrikuje cenu 0, pokud `perPricelistPrices` chybí i pro force-synced produkt).

**Zjištění PO mergi (důležité):** `force-sync-products.json` se mezi commitem `85de937` (07:57 CEST) a mergem vyprázdnil na `[]` (commit `5b978d6`, 08:11 UTC) — starý `SyncOrchestrator` produkty zpracoval (list smazal jako "hotovo"), ale to bylo ještě PŘED touhle opravou `pricing-bridge.ts`/`products-reader.ts`. Živý screenshot Shoptet admin z 08:36 UTC pořád ukazoval prázdná pole ZR4–ZR25 pro 103525 — potvrzuje, že ten běh se jen tvářil úspěšně, ceny reálně nezapsal. Seznam byl proto ručně doplněn zpátky (commit `0b271aa`), aby je opravená logika zpracovala doopravdy.

**Třetí díra, objevena při živém ověřování (09:00–09:11 UTC):**
Po nasazení merge (`0b271aa`) první běh po pushi (run `31684235933`, dokončen ~08:59 UTC) `force-sync-products.json` znovu vyprázdnil na `[]` a `Products loaded: 0` — TAKŽE se 99459/103525 zase nezpracovaly, potřetí. Příčina: `ProductsReader.fetchProducts()` dělal `return` OKAMŽITĚ, když `getProductChanges()` vrátilo 0 běžných změn — TAKŽE se force-sync smyčka (o pár řádků níž) nikdy nespustila, kdykoli nebyly žádné jiné změny. `sync-orchestrator.ts` mezitím `force-sync-products.json` vyčistil bez ohledu na to, jestli se cokoli z něj reálně zpracovalo — vyčištění je podmíněné jen `isSuccess` (nic neselhalo), ne tím, že force-sync entries doopravdy proběhly. Přesně ten samý vzorec jako hlavní bug výše: "nic nespadlo" ≠ "práce se udělala".

**Oprava:**
`products-reader.ts`: `return` na `changes.length === 0` odstraněn, force-sync smyčka se teď spouští VŽDY, bez ohledu na počet běžných změn. Přidán regresní test (`cloudflare-worker/tests/products-reader.test.ts`: "still processes force-sync entries even when getProductChanges() returns zero changes") a opraveny 2 testy (`products-reader.test.ts`, `tests/incremental-sync.test.ts`), které bez mockování `fs` četly skutečný `force-sync-products.json` z repa a nechtěně tak závisely na aktuálním stavu produkce.

`force-sync-products.json` naplněn potřetí (99459, 103525) — tentokrát s opravenou logikou, ověřeno testem, že se force-sync entries doopravdy zpracují i při 0 běžných změnách.

**Sledování živě po pushi `02f015b` — čtvrtá, nejzávažnější díra objevena (09:20–09:25 UTC):**
Po nasazení opravy z předchozí sekce first run (`31686381527`, 09:24 UTC) konečně SPRÁVNĚ spustil force-sync smyčku (`[ForceSync] Doplňuji produkt 99459/103525` v logu) — ale oba produkty skončily jako `nenalezen v API`, přestože GUIDy ve `force-sync-products.json` byly správné (ověřeno přímým GET `/products/code/{code}` dotazem: shodují se přesně). Run správně nahlas selhal (`FINAL RESULT: FAILED`, GitHub issue vytvořen) místo tichého úspěchu — to je funkční pojistka.

Přímým laděním proti živému Shoptet API (read-only GET, žádný zápis) se našly DVĚ samostatné, systémové chyby v `client.ts`:

1. **`getProductDetail()` (řádek 215):** `return json.data.product;` — ale API vrací produkt PŘÍMO jako `json.data` (klíče `guid`, `type`, `variants[]`, ...), žádný vnořený `.product` klíč neexistuje. Funkce tak vracela `undefined` doslova pro KAŽDÝ produkt, odjakživa. Volající kód (`if (!detail) continue`) to tiše přeskakoval bez logu a bez záznamu v `incompleteCodes` — takže celá cesta "běžná změna → `/products/changes` → `getProductDetail()` → cena" byla fakticky mrtvá pro úplně všechny produkty procházející inkrementálním syncem, ne jen pro 99459/103525. Tohle je pravděpodobně hlubší, dlouhodobější příčina než cokoliv popsané výše v INC-010.
2. **`perPricelistPrices` umístění:** i po opravě bodu 1 není `perPricelistPrices` na produktu přímo, ale uvnitř `variants[].perPricelistPrices` (pole variant, obvykle 1 položka pro jednoduché produkty, `variant.code` musí odpovídat merchant kódu). `products-reader.ts` četl `detail.perPricelistPrices` (top-level) — vždy `undefined`.

**Oprava:**
- `client.ts`: `getProductDetail()` vrací `json.data` místo `json.data.product`.
- `products-reader.ts` (obě větve — běžné změny i force-sync): `pricelistEntry` se teď hledá přes `detail.variants.find(v => v.code === ...).perPricelistPrices`, ne přes `detail.perPricelistPrices`. `code` se čte primárně z `variant.code`.
- `products-reader.ts`: `if (!detail) continue;` (getProductDetail vrátil null/undefined) se teď taky počítá jako `incompleteCodes`, ne tichý skip bez záznamu.
- 2 nové regresní testy (`cloudflare-worker/tests/products-reader.test.ts`): "finds perPricelistPrices nested inside variants[]" a "reports the product as incomplete... when getProductDetail() returns null". Celková sada testů aktualizována na reálný tvar API (`variants[]`), 239/239 zelených.
- Ověřeno přímým živým GET dotazem (ne přes CI): `getProductDetail()` teď pro oba GUIDy vrací `FOUND` s reálnými cenami (99459: 474,30 €, 103525: 365,00 €, oba na základním ceníku ID 1, žádný `minPriceRatio` strop).

**Zbývá:**
- Sledovat další běh `sync.yml` po tomhle pushi — poprvé očekávám SKUTEČNÝ zápis tierových cen pro 99459/103525, ne jen "nalezeno".
- **Prověřit dopad bodu 1 (`json.data.product`) šířeji** — pokud tahle funkce vracela `undefined` odjakživa, je otázka, jak dlouho a jak moc byl celý `/products/changes` → `getProductDetail` pricing pipeline fakticky nefunkční pro BĚŽNÉ (ne jen force-sync) produktové změny. Nekontrolováno v rámci dnešního zásahu, mimo scope 99459/103525 — doporučuji samostatný audit, kolik produktů za poslední dny/týdny touhle cestou prošlo a nedostalo přepočítanou cenu.
- `sync-coupon-fields-single-product.ts` (jiný consumer `getProductDetail()`) čte `product?.code` přímo — po opravě bodu 1 tenhle top-level `code` pořád neexistuje (jen `variant.code`), takže guid→code lookup tam může být taky rozbitý. Nekontrolováno, mimo scope dnešního zásahu.
- Neověřeno na živém feedu, jestli `FLACARP` je přesný string v poli `manufacturer` (case-sensitive match v `DiscountLimitPolicy`) — ověřit před přidáním zítra (2026-08-14).
- Stejná třída tichého polykání chyb může existovat i jinde v pipeline (`customerWriter`/`pricelistWriter` interní retry logika) — nekontrolováno v rámci tohoto zásahu.
- Obecné poučení, potvrzené počtvrté za jeden den: "run doběhl bez chyby" a "produkt se skutečně zpracoval" jsou dvě různá tvrzení a kód je nesmí zaměňovat. Dnešní vyšetřování jednoho hlášeného incidentu (2 produkty bez ceny) postupně odkrylo čtyři samostatné, na sobě nezávislé silent-failure díry v téže pipeline: fabrikace ceny 0, polykání chyb v pricing-bridge, early-return přeskakující force-sync, a `json.data.product`/`variants[]` chyby v samotném API klientovi. Žádná z nich nezpůsobila crash — všechny se tvářily jako úspěch.

**INC-010 pátý nález — kupónová politika (09:30–10:00 UTC):**
Po opravě pricelistu (viz výše) Jan potvrdil na frontendu: ceny i badge už jsou správně, VČETNĚ HASWING brandového stropu na 99459 (474,30 € × (1−0,10) = 426,87 € pro ZR25 přihlášeného zákazníka -- ne bug, `policy-v1.json`'s `HASWING: 0.10` funguje přesně jak má, Jan potvrdil, že nemá být výjimka).

Zbylo: **kupónová politika** (`Slevový kupón`/`discountCoupon`+`minPriceRatio` pole v Shoptet adminu) zůstala u 103525 prázdná. Příčina: `sync-coupon-fields-single-product.ts` se spouští VÝHRADNĚ na Shoptet webhook `product:create`/`product:update` (`sync.yml`, `repository_dispatch`) -- a stejně jako `/products/changes`, tenhle webhook se pro 99459/103525 nikdy nespustil (stejná Shoptet-strana anomálie jako u INC-010 hlavního nálezu). Žádný jiný krok kupónová pole nevyplňuje -- VŠECHNY plošné/scheduled coupon-fields workflows (`coupon-fields.yml`, `coupon-fields-full-live.yml`, `sync-guest-coupon-cap.yml`, ...) byly archivovány do `.github/workflows-archive/` v rámci úklidu 12.8. (commit `93084a1`), takže žádný pravidelný fallback pro tuhle pipeline neexistuje.

Navíc: i kdyby webhook fungoval, `sync-coupon-fields-single-product.ts` měl STEJNOU chybu jako `products-reader.ts` z bodu výše -- guid→code lookup četl `product.code` (top-level), který po opravě `client.ts` víme, že neexistuje (jen `product.variants[].code`). Opraveno (`resolvedCode = product?.variants?.[0]?.code || product?.code`), nekonzultováno testem (mimo scope, žádná existující test suite pro tenhle skript).

**Rozhodnutí:** Jan kupónová pole pro 103525 doplnil RUČNĚ v Shoptet adminu (stopgap, stejně jako u pricelistu ráno) -- živý zápis skriptem (`sync-coupon-fields-single-product.ts PRODUCT_CODE=99459/103525`) se VĚDOMĚ nespustil, aby nepřepsal jeho ruční zásah.

**Zbývá (nové, mimo scope dnešního zásahu):**
- Kupónová politika nemá žádný scheduled/plošný fallback po archivaci `coupon-fields.yml` -- pokud Shoptet webhook pro nový produkt selže (jako tady), kupónová pole zůstanou navěky prázdná bez jakékoli notifikace, dokud si toho někdo nevšimne ručně na frontendu. Stejný "SUCCESS bez skutečné práce" vzorec jako celý zbytek INC-010, jen v jiné pipeline. Stojí za zvážení: buď vrátit nějakou formu pravidelného/force-sync fallbacku pro kupóny (obdobu `force-sync-products.json`), nebo aspoň přidat 99459 (stejné riziko jako 103525, zatím neověřeno/nedoplněno) do manuální kontroly.
- 99459 kupónová pole nebyla zmíněna jako ručně doplněná -- ověřit, jestli je taky potřeba doplnit.

**Verze:**
main (2026-08-13)

---

**INC-010 šestý nález — katalogový dopad chyby 5, kvantifikováno auditem (11:00–12:00 UTC):**
Jan se zeptal, jestli chyba 5 (`getProductDetail()` vracelo `undefined` odjakživa,
existovalo od `git log -S` potvrzeného data 2026-08-01, 12 dní) zasáhla i jiné
produkty než 99459/103525. Spuštěn READ-ONLY audit (žádný zápis): pro každý
z 10 tierových ceníků porovnána cena spočítaná stejnou produkční funkcí
(`calculateProductsPricing`) ze živé základní ceny (`Hlavný cenník`, id 1)
proti tomu, co je skutečně zapsáno na tierovém ceníku.

**Výsledek:**

| Tier | Celkem | Sedí | Nesedí | Chybí |
|------|--------|------|--------|-------|
| ZR4  | 16705  | 16400| 250    | 55    |
| ZR6  | 16705  | 16344| 306    | 55    |
| ZR8  | 16705  | 16303| 347    | 55    |
| ZR10 | 16705  | 16301| 349    | 55    |
| ZR12 | 16705  | 16237| 413    | 55    |
| ZR14 | 16705  | 16082| 568    | 55    |
| ZR16 | 16705  | 15912| 738    | 55    |
| ZR18 | 16705  | 15910| 740    | 55    |
| ZR20 | 16705  | 15910| 740    | 55    |
| ZR25 | 16705  | 15895| 755    | 55    |

**812 unikátních kódů (~4,9 % katalogu) má špatnou cenu na aspoň jednom
tieru. 55 kódů chybí úplně na všech 10 tierech** (stejný osud jako
99459/103525 před opravou -- ty už v seznamu chybějících nejsou, potvrzuje
funkčnost dnešní opravy). Vyšší tiery (víc slevy) mají víc nesedících --
konzistentní s tím, že brand/produktové stropy se při neaktualizovaném
výpočtu odchylují víc, čím vyšší je nominální sleva, kterou by měly
osekávat.

**Rozhodnutí:** Zatím se NIC hromadně nezapisovalo -- audit byl čistě
read-only. Rozhodnutí o nápravném postupu (vynucený full sync vs. cílený
bulk catch-up skript pro 812 kódů) čeká na Jana.

**Detailní data:** `/tmp/audit-summary.json` (souhrn + seznam 812 kódů),
`/tmp/audit-<TIER>-mismatches.json` a `-missing.json` (po tierech) --
lokální, není commitnuto do repa (citlivá/objemná provozní data).
Audit skript: `audit-catalog-drift-all.ts`, zatím jen ve scratchpadu, ne
v repu.

**Zbývá:**
- Rozhodnout a provést hromadnou nápravu (viz PROGRESS_LOG.md pro detaily
  obou navrhovaných variant).
- Ověřit, jestli 55 úplně chybějících kódů má taky prázdnou kupónovou
  politiku (stejný vzorec jako 103525).
- Zvážit trvalý periodický read-only audit (týdenní?) jako včasný
  varovný signál proti podobnému tichému driftu v budoucnu.

**Verze:**
main (2026-08-13)

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
