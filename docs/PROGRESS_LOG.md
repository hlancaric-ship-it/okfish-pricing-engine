# Progress log

Running, dated notes on what's in progress, what was just finished, and what's
planned next — kept so work picks back up correctly across sessions/context
resets, not just from memory. Newest entry on top. Each entry: what changed,
why, and what's still open.

---

## 2026-08-13 (pokračování) — Stage 5 postaveno: Reconciliation / Price Integrity Layer + self-check

**Postaveno (kód existuje, ještě není commitnuté/pushnuté v době psaní
tohohle zápisu -- viz "Zbývá" níže):**

### 1. `cloudflare-worker/src/cli/reconcile-pricelist-drift.ts` (nový soubor)
Read-only skript, nikdy nezapisuje do Shoptetu. Přesně podle Janovy
specifikace formátu alertu:

> „Tahle cena měla být X. Shoptet má Y. Rozdíl = Z. Produkt nebyl
> synchronizován. → ALERT."

Logika:
- Stáhne základní ceník + manufacturer mapu z feedu, spočítá očekávané ceny
  přes `calculateProductsPricing()` -- STEJNOU funkci, co používá produkce.
- Pro každý tier stáhne skutečný stav a porovná.
- **Debounce:** "produkt zcela chybí v tier ceníku" alertuje OKAMŽITĚ (žádná
  legitimní příčina pro tenhle stav neexistuje). "Hodnota nesedí" alertuje
  až když přetrvá přes 2 po sobě jdoucí denní běhy (stav trackovaný v novém
  `.reconciliation_state.json`, committed do repa jako `.sync_state.json`)
  -- aby běžná 15minutová latence cronu (cena se právě změnila, ještě
  nestihla doběhnout) negenerovala planý poplach.
- Při nálezu ALERTu (jakéhokoli typu) `throw` -> stejný fail-closed
  mechanismus jako `sync.yml`.

### 2. Self-check / meta-validace (Janovo doplňující zadání)
Přesná citace zadání: „i kdyz dopadne dobre projede to jeste jedna
celkova validace jestli validace neudelala chybu". Přidáno na konec
skriptu, PŘED vyhodnocením alertů: kontroluje, jestli reconciliace sama
proběhla na plausibilním objemu dat --
- základní ceník vrátil alespoň 5000 produktů (mirror `MIN_EXPECTED_PRODUCTS`
  vzoru ze Stage 2, `sync-coupon-fields-diff.ts`),
- zkontrolováno alespoň `5000 × (počet tierů - 1)` produkt×tier kombinací,
- nalezeno alespoň 5 tierových ceníků,
- výpočetních selhání (`pricing-bridge.ts` failures) není víc než 50 %
  produktů.

**Proč tohle nestačí jen "0 alertů = OK":** `0 alertů` je nerozeznatelné od
"reconciliace se sama potichu rozbila (např. selhala autentizace, feed
vrátil prázdno) a nezkontrolovala skoro nic" -- PŘESNĚ ten samý tvar
chyby jako INC-010 samotné (`getProductDetail()` vracelo `undefined`, run
hlásil `SUCCESS`, protože nikdy nedošel do větve "něco je špatně"). Kdyby
se sanity-check nepřidal, Stage 5 by mohla mít stejnou slepou skvrnu, jakou
má opravovat -- validátor by potřeboval vlastního validátora do
nekonečna, kdyby se to nezastavilo aspoň jedním explicitním, absolutním
(ne relativním) prahem. Self-check selhání se hlásí ODDĚLENĚ od
běžných alertů (`RECONCILIATION SELF-CHECK SELHAL`), i kdyby alerty byly
nulové.

### 3. `.github/workflows/reconcile-pricelist-drift.yml` (nový soubor)
Scheduled denní cron (03:00 UTC, mimo špičku 15minutového `sync.yml`) +
`workflow_dispatch` pro ruční spuštění. Při selhání (alert NEBO self-check)
-- upload logu jako artifact + GitHub issue (label `price-integrity`,
stejný vzor jako `sync.yml`'s `sync-failure` notifikace). Stav
(`.reconciliation_state.json`) se commituje VŽDY, i při selhání --
debounce logika potřebuje vědět, co bylo "poprvé spatřeno dnes", i když
tenhle běh skončil alertem.

**Ověřeno:** `npx tsc --noEmit` -- 0 chyb v novém souboru. Celá test suite
239/239 zelených (nedotčena, nový skript zatím nemá vlastní dedikované
testy -- stejná mezera jako u ostatních CLI skriptů v `cloudflare-worker/src/cli/`,
žádný z nich testy nemá).

**Zbývá:**
- Commit + push (probíhá souběžně s tímhle zápisem).
- Skript zatím NENÍ spuštěný proti živému API ani jednou -- na rozdíl od
  `audit-catalog-drift-all.ts` (scratchpad), který dnes už reálně
  odhalil 812 produktů. Před prvním scheduled během doporučeno jedno
  ruční `workflow_dispatch` spuštění pro ověření, že self-check i alerty
  fungují na reálných datech, ne jen že kód typecheckuje.
- `.reconciliation_state.json` ještě neexistuje (první běh ho založí).
- Rozšíření na kupónovou politiku (INC-010, pátý nález) zůstává mimo
  scope -- tenhle Stage 5 pokrývá jen wholesale tier ceny, ne
  `discountCoupon`/`minPriceRatio` pole.
- Souběžně stále běží dry-run full sync (náprava 812 produktů) na pozadí,
  nezávisle na tomhle zápisu.

---

## 2026-08-13 (pokračování) — Zadání: Reconciliation / Price Integrity Layer, PRÁVĚ ZAČÍNÁ STAVBA

**Zadání (Jan), doslovně:** Stage 5 z návrhu výše (`CORE_LOGIC_AND_VALIDATION.md`
§3.5) se má postavit hned, ne jen zůstat navržený. Přesná specifikace
formátu alertu, jak ji Jan zadal:

> Reconciliation / Price Integrity Layer, který pravidelně řekne:
> „Tahle cena měla být X. Shoptet má Y. Rozdíl = Z. Produkt nebyl
> synchronizován. → ALERT."
>
> Pak už nikdy nemusíš čekat, až někdo náhodou otevře produkt 99459 a
> řekne: „Hele, proč tam mám -10 % místo -25 %?" Systém ti to řekne sám.

Cíl: stejná diagnostika, co dnes odhalila 812 postižených produktů
(`audit-catalog-drift-all.ts`, zatím jen scratchpad), ale jako TRVALÁ,
naplánovaná součást pipeline — ne jednorázový ruční běh na požádání.

**Co se bude stavět (podle §3.5 návrhu):**
1. Přesun/přepis skriptu do `cloudflare-worker/src/cli/reconcile-pricelist-drift.ts`
   -- read-only, žádný zápis, stejná core logika jako dnešní scratchpad
   verze (porovnání `calculateProductsPricing()` výstupu proti živému
   stavu na Shoptet tierových ceníkách), ale výstup ve formátu, co Jan
   zadal: pro každý nesedící produkt konkrétně "Tahle cena měla být X,
   Shoptet má Y, rozdíl Z, produkt nebyl synchronizován."
2. Scheduled GitHub Actions workflow (denní cron), co skript spouští.
3. Fail-closed napojení na alerting: při nálezu driftu nad toleranci
   `throw` -> stejný mechanismus jako `sync.yml` dnes (GH Actions job
   zčervená, vytvoří/aktualizuje se issue) -- žádný tichý log, žádné
   čekání, až si toho někdo všimne ručně na frontendu.
4. Debounce/threshold (viz §3.5): "úplně chybí" alertovat okamžitě,
   "hodnota nesedí" až při přetrvání přes 2 po sobě jdoucí denní běhy,
   aby to nebylo hlučné na běžnou 15minutovou latenci cronu.

**Stav:** implementace právě začíná (tenhle zápis je "start" marker,
psaný podle Janova pokynu ihned, ne až po dokončení). Souběžně pořád
běží dry-run full sync (náprava 812 produktů, viz předchozí zápis) --
obě věci jsou nezávislé, dry-run se nezastavuje kvůli stavbě
reconciliation vrstvy.

**Zatím se nic nezapsalo, nic není nasazené.** Bude doplněno dalším
zápisem, jakmile bude Stage 5 hotová a otestovaná.

---

## 2026-08-13 (pokračování) — Architektonický závěr INC-010: 5 pilířů trvalé ochrany

**Zadání (Jan):** oprava 812 postižených produktů je jen half práce.
Skutečná otázka: jak zajistit, aby se tenhle typ tichého driftu nikdy
znovu nemohl vytvořit, aniž by to systém okamžitě poznal. Pojmenováno
5 pilířů: validace, reconciliation, alerting, fail-closed chování,
auditní trail.

**Stav zjištěný auditem vlastního kódu (co z toho dnes vzniklo, co chybí):**

1. **Validace (fail-closed na vstupu)** — HOTOVO dnes (INC-010, chyby 1–2).
   `products-reader.ts`/`pricing-bridge.ts` odmítají neúplná data
   (`incompleteCodes`/`pricingFailures`) místo fabrikace ceny 0.
2. **Fail-closed chování** — HOTOVO dnes (INC-010, chyba 3).
   `sync-orchestrator.ts` hodí `throw` při jakémkoli selhání, `lastSync`
   se neposune, GH Actions job zčervená místo tichého "success".
3. **Auditní trail** — JIŽ EXISTOVAL, nezávisle na dnešním zásahu.
   `pricelist-writer.ts:120` loguje `[AUDIT LOG]` s
   timestamp/entity/id/endpoint/requestId/HTTP status/oldValue/newValue
   na každý zápis do Shoptet ceníku.
4. **Alerting** — ČÁSTEČNĚ. GH issue se vytvoří při selhání BĚŽÍCÍHO
   `sync.yml` (mechanismus z INC-006, dnes konečně funkční). Nepokrývá
   ale drift, co vznikne tiše mimo aktuální běh (přesně scénář 812
   produktů — žádný jednotlivý běh nikdy "neselhal", jen se roky
   kumulovaly nezapsané změny).
5. **Reconciliation** — CHYBÍ ÚPLNĚ. Dnešní `audit-catalog-drift-all.ts`
   (porovnání očekávané vs. skutečně zapsané ceny napříč celým katalogem)
   JE reconciliation logika, ale žije jen ve scratchpadu, spustila se
   jednou ručně na explicitní požádání a jinak nikde neběží.

**Navržené uzavření smyčky (spojuje pilíře 4+5, ČEKÁ NA JANOVO SCHVÁLENÍ,
zatím nic neimplementováno):**
- Přesunout audit skript do repa jako
  `cloudflare-worker/src/cli/reconcile-pricelist-drift.ts` (read-only,
  žádný zápis -- stejná logika jako dnešní scratchpad verze, jen
  zabudovaná a testovaná).
- Nový scheduled GitHub Actions workflow (denní cron), co ho spouští.
- Pokud najde mismatch/missing nad rozumnou toleranci, `throw` -> stejný
  fail-closed mechanismus jako `sync.yml` dnes -- GH issue, ne tichý log.
- Otevřená otázka k doladění: threshold/debounce, aby to nebylo hlučné
  na drobnou volatilitu (cena se právě změnila, cron ji ještě
  nedohnal do 15 min) -- např. alertovat na "úplně chybějící" (55-typ)
  okamžitě (jednoznačný signál), na "mismatch" až při přetrvání přes
  2 po sobě jdoucí denní běhy.
- Rozšíření o kupónovou politiku (INC-010, pátý nález) zvažováno jako
  navazující krok, ne součást první verze.

**Proč to takhle a ne jinak:** pilíře 1–3 řeší "co se stane, když sync
běží a něco selže". Pilíř 5 (reconciliation) řeší jinou otázku: "co když
sync běžel roky bez jediného selhání, a přesto výsledek nesedí, protože
sám kód měl chybu v logice" — přesně INC-010, chyba 5
(`json.data.product`), 12 dní, žádné selhání, 812 postižených produktů.
Bez pravidelné nezávislé kontroly "co je vs. co by mělo být" tenhle typ
chyby žádný fail-closed mechanismus nikdy neodhalí, protože fail-closed
chrání jen běh, který se skutečně spustil a skutečně selhal -- ne
tichou logickou chybu uvnitř úspěšného běhu.

---

## 2026-08-13 (pokračování) — Náprava 812 postižených produktů: dry-run full sync, PRÁVĚ BĚŽÍ

**Rozhodnutí (Jan):** z navržených dvou variant nápravy (vynucený full sync
vs. cílený bulk skript pro 812 kódů) zvolen **vynucený full sync** — jde
přes `getPricelistProducts()`, stejnou cestu jako produkce, žádný nový
netestovaný kód. Postup dle Dry-Run First: nejdřív `scripts/run-dry-sync.ts`
(dryRun: true, nic nezapisuje) přes CELÝ katalog, výsledek se ukáže Janovi,
teprve po jeho schválení ostrý běh.

**Jak byl vynucen full sync mód:** `FileStateProvider` čte `.sync_state.json`
z `process.cwd()`, žádná jiná cesta injectovatelná zvenku. Soubor byl
DOČASNĚ přesunut do `/tmp` (zálohován, `getLastSync()` vrátil `null` →
`[FULL SYNC MÓD]` potvrzeno v logu), a IHNED vrácen zpět (ověřeno `diff`
identický obsah, `git status` čistý) -- `FileStateProvider.getLastSync()`
se čte jen jednou na začátku běhu, takže vrácení souboru neovlivnilo
běžící proces. `dryRun: true` navíc zaručuje, že `setLastSync()` se
nezavolá vůbec, i kdyby něco selhalo.

**Průběh (zatím):** základní ceník staženo (16 711 položek, sedí s číslem
z auditu), manufacturer mapa načtena (16 644 kódů), teď běží FULL SYNC
zákazníků/objednávek (`/orders`, 3838 stránek stránkování -- tohle bude
nejdelší část, výrazně víc než produktová část). Odhad dokončení
neznámý, může to trvat desítky minut. Monitor nastaven, výsledek bude
doplněn do tohohle zápisu.

**Zatím se NIC nezapsalo ani nezměnilo** -- čistě diagnostický dry-run.

---

## 2026-08-13 (pokračování) — Katalogový audit dopadu chyby 5 (INC-010), DOKONČENO

**Kontext:** Po vyřešení INC-010 (99459/103525) vyšlo najevo, že `getProductDetail()`
bug (`json.data.product`) existoval v repu minimálně od **2026-08-01** (12 dní,
ověřeno `git log -S`). `.sync_state.json` existuje nepřetržitě od stejného data —
tedy po prvním full syncu běžel 12 dní JEN rozbitý inkrementální sync. Jan se
zeptal, jestli to nezasáhlo i jiné produkty. Spuštěn READ-ONLY audit (žádný
zápis): pro každý tier se porovnává cena spočítaná stejnou produkční funkcí
(`calculateProductsPricing`) ze ŽIVÉ základní ceny (`Hlavný cenník`, id 1 —
`Maloobchodný` pod tímhle jménem v Shoptetu vůbec neexistuje, produkce na něj
stejně fallbackuje na `pricelists[0]`) proti tomu, co je SKUTEČNĚ zapsané na
tierovém ceníku.

**Dílčí výsledek (ZR25 samotný, dokončeno):** z 16 705 produktů se základní
cenou:
- 15 895 sedí (v toleranci 0,02 €)
- **755 má špatnou/zastaralou cenu**
- **55 v ZR25 ceníku úplně chybí**
- 0 výpočetních selhání (engine cenu spočítat umí, jen se nikdy nezapsala)

To je ~4,8 % katalogu jen na jednom tieru. Příklady nesedících (očekáváno vs.
skutečně zapsáno): `01011` 44,91 vs 49,90 | `101800` 577,46 vs 692,96 |
`101821` 371,21 vs 445,46 | `103524` 408,00 vs 516,80. Vzorek zahrnuje i
`103518`/`103519`/`103524` — sourozenecké kódy stejné dávky produktů jako
99459/103525, potvrzuje že to byl širší problém s nedávno přidanými/měněnými
produkty, ne jen ty dva nahlášené.

**FINÁLNÍ VÝSLEDEK — audit přes všech 10 tierů dokončen:**

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

**812 unikátních produktových kódů** (~4,9 % katalogu) má špatnou cenu na
alespoň jednom tieru. **Stejných 55 kódů chybí úplně na VŠECH 10 tierech**
(žádný záznam v pricelistu vůbec) — pravděpodobně nedávno založené
produkty se stejným osudem jako 99459/103525 (potvrzeno: obě už v seznamu
chybějících nejsou, oprava fungovala). Vzorek chybějících: `110400`,
`112054`–`112076`, `112416`, `112417`, ... (plný seznam
`/tmp/audit-<TIER>-missing.json`, stejná sada napříč tiery).

Pozorování: čím vyšší tier (víc slevy), tím víc nesedí (ZR4: 250 → ZR25:
755) — konzistentní s tím, že produkty s brand/produktovými stropy
(jako HASWING) se při špatném/neaktualizovaném výpočtu odchylují víc na
vyšších tierech, kde by strop měl zasáhnout.

**Rozsah příčiny:** přesně to, co jsme čekali — `getProductDetail()` bug
existoval od 2026-08-01, celých 12 dní žádná normální produktová změna
(nová cena, akční cena, nový strop) nepropsala do wholesale ceníků, pokud
produkt neprošel jinou cestou (např. plošný full sync, který ale od
2026-08-01 neproběhl ani jednou, nebo ruční CLI zásah).

**Co zůstává otevřené / navrhované další kroky:**
1. **Hromadná náprava** — 812 kódů je moc na `force-sync-products.json`
   (ten je určený pro jednotky výjimek, ne stovky). Potřeba buď (a) vynutit
   jednorázový FULL SYNC (smazat/ignorovat `.sync_state.json` na jeden běh
   — `ProductsReader` pak jde přes `getPricelistProducts()`, úplně jinou,
   nepostiženou cestu), nebo (b) napsat cílený "bulk catch-up" skript, co
   vezme přesně těch 812 kódů a přepočítá/zapíše jen je. Varianta (a) je
   jednodušší a bezpečnější (stejná cesta jako produkce), ale zapíše i
   těch ~15,9k správných produktů znovu (neškodné, jen zbytečné API volání
   navíc — cca 16-17k PATCH požadavků). **Nerozhodnuto, čeká na Janovo
   rozhodnutí. Nic z tohohle auditu se zatím nezapsalo, byl to čistě
   read-only audit.**
2. Ověřit, jestli těch 55 "úplně chybějících" kódů má taky prázdnou
   kupónovou politiku (stejný vzorec jako 103525 dnes ráno) — pravděpodobné,
   nekontrolováno.
3. Zvážit trvalý monitoring/alerting: pravidelný (např. týdenní) běh
   tohohle read-only audit skriptu, aby podobný 12denní tichý drift příště
   nezůstal bez povšimnutí měsíce. Skript zatím žije jen ve scratchpadu,
   ne v repu — pokud se má používat trvale, přesunout do
   `cloudflare-worker/src/cli/`.

**Verze:** main (2026-08-13), audit proveden read-only proti živému
produkčnímu Shoptet API, žádný zápis.

---

## 2026-08-13 — INC-010: kompletní report (VYŘEŠENO, ověřeno živě)

**Původní hlášení (Jan):** 99459 a 103525 (nové produkty přidané Yopni
2026-08-12) neměly vůbec dopočítané tier-ceny na wholesale ceníku — Jan je
musel dopisovat ručně. Na frontendu se přihlášenému ZR25 zákazníkovi
zobrazovalo jen -10 % místo -25 %. `sync.yml` doběhl přesto zeleně bez
jakékoli chyby. Plný detail všech nálezů v `INCIDENTS.md` (INC-010) —
tady jen souhrn.

### Chyba 1 — fabrikace ceny 0 při chybějících ceníkových datech
`products-reader.ts` (inkrementální větev): když Shoptet ještě nepropsal
`perPricelistPrices` pro nově založený produkt na základní ceník, kód
fabrikoval `basePrice=0` a produkt přesto poslal dál do pricing enginu.
**Fix:** produkt se vynechá z běhu (`incompleteCodes`), cena 0 se nefabrikuje.

### Chyba 2 — polykání chyb v pricing-bridge
`pricing-bridge.ts`: `validateInput`/`validateResult`/`res.rejected`/
vyhozená výjimka se pro konkrétní SKU+tier prostě zahodily
(`catch (e) { /* Ignore */ }`) — bez logu, bez počítání jako failure.
**Fix:** každé selhání se loguje (`console.warn` s SKU+tier+reason) a vrací
v poli `failures`.

### Chyba 3 — tichý úspěch místo hlasitého selhání
`sync-orchestrator.ts`: `isSuccess` se sice vypočítal a vypsal do konzole
jako `FAILED`, ale nikdy se nepropagoval jako `throw` — `run-real-sync.ts`
viděl exit 0, GitHub Actions job zůstal zelený, žádný issue se nevytvořil.
**Fix:** `isSuccess` zohledňuje `incompleteCodes` i `pricingFailures`; při
neúspěchu se `lastSync` neposune (retry za 15 min) a na konci se hodí
`throw` — GH Actions job zčervená, issue-notifikace (existovala už v
sync.yml, jen se nikdy nespustila) konečně naskočí.

### Chyba 4 — force-sync escape hatch se nikdy nespustil při 0 změnách
Souběžně (jiná session, commit `85de937`) se zjistilo, že Shoptet
`/products/changes` tyhle dva produkty vůbec nikdy nenahlásil jako
změněné — přidán `force-sync-products.json` escape hatch. Po mergi s mým
fixem se ale ukázalo: `products-reader.ts` dělal `return` OKAMŽITĚ, když
`getProductChanges()` vrátilo 0 běžných změn — TAKŽE se force-sync smyčka
nikdy nespustila, kdykoli nebyly žádné jiné změny (většina běhů).
`force-sync-products.json` se přesto pravidelně vyprázdnil jako "hotovo"
(2×), aniž by se cokoli zpracovalo. **Fix:** `return` odstraněn, force-sync
smyčka běží vždy.

### Chyba 5 — `getProductDetail()` vracelo `undefined` úplně vždy (nejzávažnější)
I po opravě chyby 4 force-sync smyčka hlásila oba produkty jako
"nenalezen v API", přestože GUIDy byly ověřeně správné (potvrzeno přímým
GET `/products/code/{code}` dotazem). Přímým laděním proti živému API
(read-only) se našly dvě systémové chyby v `client.ts`:
- `getProductDetail()` četlo `json.data.product` — ale API vrací produkt
  PŘÍMO jako `json.data`, žádný vnořený `.product` klíč neexistuje. Funkce
  vracela `undefined` pro KAŽDÝ produkt, odjakživa. Volající kód
  (`if (!detail) continue`) to tiše přeskakoval bez záznamu — **celá cesta
  "běžná změna → `/products/changes` → `getProductDetail()` → cena" byla
  fakticky mrtvá pro všechny produkty procházející inkrementálním syncem,
  ne jen pro 99459/103525.** Rozsah dopadu mimo tyhle dva produkty
  NEPROVĚŘEN — doporučen samostatný audit (viz "Co zůstává otevřené").
- `perPricelistPrices` navíc není na produktu přímo, ale uvnitř
  `variants[].perPricelistPrices` (jedna položka na variantu).
- Stejná chyba (`product.code` místo `product.variants[].code`) byla i v
  `sync-coupon-fields-single-product.ts` (guid→code lookup pro webhook).
  Opraveno současně.

**Fix:** `client.ts` vrací `json.data`; `products-reader.ts` čte
`variant.perPricelistPrices` přes `detail.variants.find(...)`;
`if (!detail) continue` se teď taky počítá do `incompleteCodes`.

### Ověření živě (ne jen testy)
Po nasazení chyby 5 opravy proběhl běh `31688150194` (09:47 UTC):
force-sync smyčka doplnila oba produkty, reálné HTTP 200 zápisy napříč
všemi 10 tierovými ceníky, `Products failed: 0`, `FINAL RESULT: SUCCESS`.
Hodnoty sedí přesně: 99459/ZR25 → 426,87 € (474,30 × 0,90 — HASWING
brandový strop 10 % z `policy-v1.json`, **potvrzeno správné chování, Jan
odmítl výjimku**), 103525/ZR25 → 273,75 € (365 × 0,75 — čistá 25% sleva,
bez stropu). Jan potvrdil na frontendu: ceny i badge sedí.

### Kupónová politika — samostatný nález, částečně otevřený
Pricelisty jsou opravené, ale kupónová pole (`Slevový kupón`/
`discountCoupon`+`minPriceRatio`) zůstala u 103525 prázdná. Příčina:
`sync-coupon-fields-single-product.ts` běží JEN na Shoptet webhook
`product:create`/`product:update`, který se pro tyhle produkty (stejně
jako `/products/changes`) nikdy nespustil. Žádný plošný fallback
neexistuje — všechny scheduled coupon-fields workflows jsou archivované
(`.github/workflows-archive/`, úklid 12.8., commit `93084a1`). Jan pole
pro 103525 doplnil RUČNĚ v Shoptet adminu; live-write skript se vědomě
nespustil, aby ho nepřepsal. 99459 nebylo zmíněno jako doplněné —
needs check.

**Kód:** 6 commitů (`ea2f273`, `74cef74` merge, `0b271aa`, `02f015b`,
`6314ec7`, `7943308`), 239/239 testů zelených, pushnuto na `main`.

### Co zůstává otevřené
- **Audit rozsahu chyby 5** — pokud `getProductDetail()` vracelo
  `undefined` odjakživa, kolik dalších produktů za poslední dny/týdny
  touhle cestou prošlo a nedostalo přepočítanou cenu? Nekontrolováno,
  mimo scope dnešního zásahu.
- Kupónová politika nemá scheduled/plošný fallback po archivaci
  `coupon-fields.yml` — pokud webhook selže jako dnes, pole zůstanou
  navěky prázdná bez notifikace. Zvážit obdobu `force-sync-products.json`
  i pro kupóny.
- 99459 kupónová pole — ověřit, jestli je taky potřeba doplnit ručně.
- `FLACARP` zvažován pro `brandLimits` (10% strop) — VĚDOMĚ NEpřidán,
  platit má až od 2026-08-14 na Janovo přání. Neověřeno na živém feedu,
  jestli je to přesný string v poli `manufacturer` (case-sensitive match).
- Stejná třída tichého polykání chyb může existovat i jinde v pipeline
  (`customerWriter`/`pricelistWriter` interní retry logika) —
  nekontrolováno v rámci tohoto zásahu.

**Klíčové poučení dne:** "run doběhl bez chyby" a "produkt se skutečně
zpracoval" jsou dvě různá tvrzení a kód je nesmí zaměňovat. Jeden hlášený
incident (2 produkty bez ceny) postupně odkryl PĚT samostatných,
na sobě nezávislých silent-failure děr ve stejné pipeline. Žádná
nezpůsobila crash — všechny se tvářily jako úspěch.

---

## 2026-08-08

**Done:**
- Added Stage 1 (config-load-time) validation to `cloudflare-worker/src/engine/config.ts`:
  `assertNoCrossFileConflicts()` throws if a product code appears in more than one
  of {zero-discount-products.json, clearance-sale-products.json,
  product-max-discount-overrides.json} — closes the silent-wrong-price gap the
  audit found (same failure class as INC-004, different file pair).
- Added 4 regression tests in `cloudflare-worker/tests/compute-coupon-writes.test.ts`
  covering the previously-untested three-way interaction: loyalty tier + active
  clearance sale + coupon eligibility together. Full suite now 236/236 green.
- Wrote 4 docs: `ENGINE_DOCUMENTATION.md` (okfish-specific deep dive),
  `ENGINE_TECHNICAL_TEMPLATE.md` (genericized, for deploying on a new Shoptet
  client), `ENGINE_BUSINESS_OVERVIEW.md` (Czech, non-technical pitch doc),
  `CORE_LOGIC_AND_VALIDATION.md` (formal 3-stage validation model: config-load /
  pre-write diff-fuse / regression tests — the architectural principle the
  owner wants every new policy file to follow going forward).
- Repo cleanup: `.price_cache.json` (3.9MB, regenerated every run) and
  `.snapshots/` (accumulated CLI rollback backups, ~1.7M lines total) had been
  accidentally committed at some point — untracked both, added to `.gitignore`
  along with `coupon-dry-run-report.json` and `*.sync_state.json.bak` patterns.
  Also deleted two loose untracked root scripts: `coupon-applied-finder.js`
  (one-off console diagnostic) and `vip_cart_coupon_percent.js` (superseded —
  folded into `vip_cart.js`).
- okfish.sk mobile header: logo + icon row now share one line (flex on
  `.header-top-wrapper`), login icon centers in the gap next to the logo,
  wishlist heart resized to match other icons, gaps tightened to fit the
  hamburger menu when the "-4%" loyalty badge is showing. Confirmed working by
  owner on a real device.
- Split 4 inline `<script>` blocks (goldfish badge, filters+rating,
  description/cart-text, availability-text) that lived in the Shoptet admin
  body/footer field into external `defer`-loaded files on FTP
  (`/upload/CSSJS/`), freeing head/body character-limit headroom and letting
  them defer-load instead of blocking render. Also split the header's inline
  `<style>` CSS into `okfish-header-extra.css` for the same reason.

**Known open items (not yet done, flagged in CORE_LOGIC_AND_VALIDATION.md):**
- Worker isolate cache staleness for clearance date windows between deploys —
  documented as an accepted limitation, not mitigated with a TTL/re-eval yet.
- No end-to-end test confirming a bypassed/forced coupon on a locked tier
  (ZR20/ZR25) actually gets rejected by Shoptet's own `minPriceRatio` floor at
  checkout — the trust boundary between client-side cosmetic lock and
  server-side real enforcement is asserted only in code comments.
- Frontend JS deployed via FTP (`vip_cart*.js`, `goldfish-badge-header.js`,
  etc.) has zero automated test coverage — deployed and verified manually only.

**Context for future sessions:** owner (Jan Lančarič, L-Code Dynamics) wants
this engine documented and hardened well enough that it could be redeployed
for a new Shoptet client, not just kept working for okfish.sk. The core
differentiator to protect: this engine writes tier-specific prices directly to
Shoptet wholesale ("Veľkoobchod") pricelists instead of using Shoptet's native
loyalty-discount add-on, sidestepping Shoptet's naive additive discount
stacking — that architectural choice is the reason precise coupon/tier/sale
interaction logic is even possible here. Keep protecting that boundary in any
future change.
