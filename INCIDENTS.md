# Incident Log

Tento dokument slouží pro evidenci incidentů a chyb zjištěných v produkčním provozu.

Každý záznam by měl obsahovat: datum, popis problému, příčinu, řešení a verzi systému, ve které chyba nastala.

---

## 2026-09-05 -- INC-016: Shoptet Premium potvrdil "HTTP 200 nestačí" u PATCH /api/pricelists/{id} (VYŘEŠENO — konkrétní SKU uzavřeny, poznatek k API chování ponechán)

**Popis:**
Nahlásili jsme Shoptet Premium (Stanislav Vinc, Premium Technical Consultant)
podezření na rozdíl mezi odeslanou a následně načtenou hodnotou u SKU
`100464` a `110006` na věrnostních ceníkách. Odpověď (2026-09-05, e-mail):

> "Jeden request na endpoint PATCH /api/pricelists/{id} môže obsahovať až
> 300 aktualizácií. Ak časť položiek uspeje a časť zlyhá, API vráti stav
> 200 OK, pričom neúspešne spracované položky uvedie v poli `errors` v
> tele odpovede. Samotný HTTP status preto nestačí na posúdenie úspešného
> spracovania každej jednotlivej položky v dávke."

Potvrdil zároveň, že endpoint je synchronní (ne fire-and-forget) — položka
bez záznamu v `errors` by měla být po dokončení requestu skutečně uložená.

**Zjištěno u SKU 100464**: poskytnutý zápis se týkal ceníku ID `23`, ale
přiložená následná kontrola (z naší strany) se týkala ceníku `ZR10` —
Vinc na to upozornil jako na nesrovnalost v našem podkladu, ne jako na
potvrzenou chybu API. Než se prokáže cokoliv dál, je potřeba dohledat
skutečný request/response pár pro SKU 100464 na ceník `23` (ne `ZR10`,
to byl náš omyl v podkladu) a zvlášť pro SKU 110006.

**Vztah k existujícímu kódu (`cloudflare-worker/src/shoptet-api/client.ts:498-502`):**
`updatePricelistBatch` už dnes `errors` pole kontroluje — ale **na úrovni
celého batch requestu** (`if (json.errors && json.errors.length > 0) throw
...`), ne per-položka. Pokud Shoptet u dávky 100 položek (viz `pricelist-
writer.ts:104`, `chunkSize = 100`) vrátí `errors` jen pro 1 z nich, celý
`throw` shodí i těch 99 úspěšných jako neověřených — opačný problém, než
co popisuje Vinc (tichý neúspěch), ale ze stejného kořene: kód dnes
nerozlišuje "celý request OK", "částečný úspěch s per-item errors" a
"skutečně nic nezapsáno".

Existující first-write verifikace (`pricelist-writer.ts:154-193`,
zavedená INC z 2026-08-15, produkt 77764) cílí jen na `oldPrice === null`
položky (poprvé na daném ceníku) — SKU s existujícím starým záznamem,
kde se jen mění hodnota, tímhle guardem NEPROCHÁZÍ, takže by podobný
tichý drift u NICH nezachytila.

**Požadavek Shoptetu k dalšímu postupu:**
Vyplnit formulář `https://salesforce-eu.123formbuilder.com/form-82632/premium-api-issues`
se všemi poli, samostatně pro každý prověřovaný případ (SKU 100464 a SKU
110006 zvlášť) — vyžaduje kompletní tělo PATCH requestu i odpovědi API
pro obě SKU. Bez tohohle Shoptet nemůže dál posoudit, jestli jde o
skutečnou chybu API nebo chybu na naší straně (viz nesrovnalost ceník
23 vs. ZR10 výše).

**Řešení:**
Jan potvrdil (2026-09-05), že konkrétní případ SKU `100464`/`110006` je
už dávno vyřešený — uzavřeno mimo tenhle kód/repo (ne prostřednictvím
per-item přepisu `updatePricelistBatch`, viz "Otevřená technická mezera"
níže, ta zůstává platná zvlášť). Tenhle záznam se ponechává kvůli
trvale platnému poznatku od Shoptet Premium (200 OK ≠ úspěch všech
položek dávky, `errors` pole je zdroj pravdy per-item) — ne kvůli
otevřenému TODO na těchhle dvou SKU.

**Otevřená technická mezera (samostatná od vyřešeného incidentu, NEOPRAVOVAT NASLEPO):**
`errors`-parsing v `client.ts:498-502` zůstává na úrovni celého batch
requestu, ne per-položka — a first-write verifikace (`pricelist-
writer.ts:154-193`) se stále netýká SKU s existujícím starým záznamem.
Tohle je potenciální budoucí zdroj podobného tichého driftu, ale bez
konkrétního tvaru `errors` pole ze skutečné Shoptet odpovědi by přepis
byl domněnka, ne oprava podle ověřeného chování API. Řešit až při
příštím konkrétním výskytu, ne preventivně teď.

**Verze:** main (2026-09-05)

---

## 2026-09-05 -- INC-015: FULL SYNC větev fabrikovala basePrice=0 pro produkty s chybějící cenou -- root cause ~1850 produkt×tier reconciliation alertů (VYŘEŠENO)

**Popis:**
Issue #8 (Price Integrity) a #9 (Coupon Integrity) hlásily denně od 2026-08-19/20
neshodu mezi očekávanou a skutečnou cenou -- k 2026-09-04 celkem 144 zcela chybějících
+ 1706 trvale nesedících = ~1850 produkt×tier záznamů. `.reconciliation_state.json`
ukázal, že 92 % z nich (1600 záznamů, 160 unikátních kódů) má `firstSeen: 2026-08-28`,
ne rozptýlené v čase -- silný signál jedné konkrétní události, ne pomalého driftu.

**Příčina:**
`ProductsReader.fetchProducts()` (`cloudflare-worker/src/shoptet-api/products-reader.ts`)
má dvě větve: inkrementální (běží, když je k dispozici `lastSync`) a FULL SYNC (běží při
prvním běhu nebo když `pricing-config-fingerprint.ts` detekuje `requiresFullReevaluation`,
např. změna `policy-v1.json`). Inkrementální větev má od INCIDENTU 2026-08-12 (99459/103525)
ochranu: pokud Shoptet nevrátí platnou `price.price`, produkt se vynechá a nahlásí jako
`incompleteCodes`, NIKDY se nefabrikuje `basePrice=0`. **FULL SYNC větev tuhle ochranu
nikdy nedostala** -- řádek `const basePrice = item.price?.price ? item.price.price : 0;`
tiše zapisoval nulovou cenu pro jakýkoli produkt s chybějící/prázdnou `price.price`, a vždy
vracela `incompleteCodes: []` bez ohledu na realitu.

2026-08-28 v 17:39 CEST byl commitem `e5172e4` poprvé nasazen `pricing-config-fingerprint.ts`.
Jeho první běh (žádný uložený `configFingerprint`) vždy vrací `requiresFullReevaluation: true`
(bootstrap), což vynutilo FULL SYNC větev při běhu v 20:00 UTC téhož dne -- 160 produktů,
u kterých Shoptet v tu chvíli nevrátil `price.price` (typicky produkty v přechodném stavu),
dostalo fabrikovanou nulu místo vynechání, což se v cílovém ceníku projevilo jako chybějící/
nesedící záznam napříč všemi 10 tiery (160 × 10 = 1600).

**Řešení:**
FULL SYNC větev v `products-reader.ts` přepsána ze `.map()` na `for` smyčku se stejnou
`incompleteCodes` ochranou jako inkrementální větev: chybějící/prázdná `price.price`
produkt vyloučí z běhu a nahlásí, místo aby zapsala nulu. Přidány 2 regresní testy
(`tests/products-reader.test.ts`, sekce "full sync price extraction").

**Backfill dokončen (2026-09-05):** `cloudflare-worker/src/cli/backfill-reconciliation-drift.ts`
napsán, dry-run ověřen (1731/1742 záznamů k opravě, 11 se mezitím srovnalo samo, 0 chybějících
basePrice), po schválení spuštěn ostře -- všech 1731 položek napříč 10 tiery zapsáno a
živě ověřeno, 0 selhání. Součástí i produkt 93683 (4 záznamy, ZR16/18/20/25, jiná/starší
kategorie -- existující cena 12.71 přepsána na přepočítanou hodnotu podle aktuální policy,
schváleno explicitně). Plán zápisu uložen v `backfill-plan.json` (needituje se do gitu).

**Verze:**
main (2026-09-05)

---

## 2026-08-25 -- INC-014: Nulová DPH (vatRate: 0.00% / includingVat: false) při zápisu do věrnostních ceníků přes API (VYŘEŠENO)

**Popis:**
V administraci Shoptetu v detailu produktů (např. Boilie DELPHIN kód `93850` / produkt `120449`) svítila v tabulce *Jiné ceníky* u všech věrnostních ceníků (ZR4 až ZR25) hodnota `0% DPH`, přestože hlavní ceník a nákupní/akční cena měly správně `23% DPH`.

**Příčina:**
Metoda `updatePricelistBatch` v `cloudflare-worker/src/shoptet-api/client.ts` při zápisu cen dávkově odesílala do Shoptet API (`PATCH /api/pricelists/{id}`) pouze pole `{ code, price }` bez polí `vatRate` a `includingVat`.
Shoptet API u nově zakládaných položek ceníku nepřevezme sazbu DPH ze základního ceníku, ale nastaví výchozí hodnotu `vatRate: "0.00"` a `includingVat: false`.

**Řešení:**
1. Do rozhraní a payloadů `ProductsReader`, `PricelistDiff`, `PricelistWriter` a `ShoptetApiClient.updatePricelistBatch` doplněno předávání `vatRate` a `includingVat: true`.
2. Vytvořen a úspěšně spuštěn migrační/opravný skript `scripts/fix-pricelist-vat.ts`, který prošel všech 10 věrnostních ceníků (ZR4 až ZR25), identifikoval všech **205 dotčených položek** a do Shoptetu zapsal správnou sazbu DPH `23.00%` a `includingVat: true`.
3. Ověřeno živě na produktu `93850` napříč všemi 11 ceníky v Shoptet API i v administraci.

**Verze:**
main (2026-08-25)

---

## 2026-08-20 -- INC-012: Kupónová rekonciliace hlásí false-positive "chybí záznam" (OTEVŘENO, NEDOŘEŠENO)

**Popis:** Denní běh `reconcile-coupon-drift.ts` (run #32330621142, 2026-08-20
04:06 UTC) nahlásil 341 neshod (170× "zcela chybí", 171× "hodnota nesedí
2+ běhy"). Alespoň jeden konkrétní případ je potvrzený false positive:
produkt s kódem **56167** (MIVARDI Rapid Pellets Easy Catch Cesnak 5kg,
4mm) má na značce MIVARDI aktivní strop max. 10% slevy. Na tiercích
ZR10+ (včetně ZR20/ZR25) je proto `discountCoupon` záměrně vypnutý --
Jan živě ověřil v adminu Shoptetu, že záznam **existuje** a je **správně
nastavený** (kupón vypnutý, sedí s brand capem). Rekonciliace ho přesto
klasifikuje jako `CHYBÍ CELÝ ZÁZNAM`.

**Seznam 59 unikátních kódů z tohoto běhu (min. jeden potvrzený false
positive, zbytek needit ověřen):**
23996, 28001, 28421, 28928, 39374, 39375, 39376, 39767, 46438, 46439,
46443, 46445, 46446, 46447, 46449, 46450, 46451, 46452, 46536, 46537,
46541, 46543, 55163, 55320, 55328, 55464, 55574, 55597, 55729, 55761,
55864, 55877, 55979, 56064, 56102, 56107, 56161, 56164, 56167, 56179,
56339, 56384-56398 (blok 15 po sobě jdoucích kódů), 59779, 89504, 91645.

**Pracovní hypotézy (žádná zatím live neověřená):**
1. Mismatch v párovacím klíči: `actualByCode` v `reconcile-coupon-drift.ts`
   (řádek ~229-235) se plní podle `item.code` z odpovědi
   `client.getPricelistProducts(pricelistId)` pro daný tier, zatímco
   `expectedByCode` se plní podle `product.code` z master feedu. Pokud
   se formát/case/mezery kódu mezi těmito dvěma zdroji liší, existující
   záznam se nespáruje a vypadá jako chybějící.
2. Paginace: `fetchPaginated()` v `shoptet-api/client.ts` (řádek ~325)
   stahuje po 1000 položkách/stránku, u ~16 700 produktů to je ~17
   stránek -- `while` podmínka ukončení cyklu nebyla v rámci tohohle
   vyšetřování ještě zkontrolovaná, možná off-by-one uřezává poslední
   dávku. Blok 56384-56398 (15 po sobě jdoucích kódů) na to vzorem sedí.

**Co NENÍ příčina (vyvráceno):**
- Brand cap logika sama o sobě je v pořádku -- `expected.applyDiscountCoupon
  = false` pro MIVARDI na ZR10+ je správný závěr, potvrzeno živě v adminu.
- Skryté/neskladem produkty nejsou nikde v kódu (`compute-coupon-writes.ts`,
  `sync-coupon-fields-live.ts`) filtrované ani zvýhodněné -- hypotéza
  "skrytý produkt = záměrně přeskočen" nemá oporu v kódu.

**Další kroky:**
- Přímo porovnat `item.code` vs `product.code` pro kód 56167 (a pár dalších
  z bloku 56384-56398) na živých datech.
- Zkontrolovat `while` podmínku v `fetchPaginated()` na off-by-one.
- Až se najde root cause: opravit `reconcile-coupon-drift.ts` (nebo
  `client.ts`), znovu spustit rekonciliaci a ověřit, že se 341 neshod
  smrsklo na skutečně reálné případy.

**Verze:**
main (2026-08-20)

---

## 2026-08-20 (pokračování) -- INC-012: obě hypotézy vyvráceny live testem, nová příčina + navržený fix

**Live ověření (5 kódů: 56167, 46438 a celý blok 56384/56390/56398), přímo
proti Shoptet API, `ShoptetApiClient` z `cloudflare-worker/src/shoptet-api/
client.ts`:**

1. **Hypotéza 1 (mismatch `item.code` vs `product.code` z feedu) --
   VYVRÁCENA.** `expectedByCode` v `reconcile-coupon-drift.ts` se ve
   skutečnosti vůbec neplní z master feedu -- plní se ze stejného API pullu
   jako `actualByCode` (`baseItems` = `client.getPricelistProducts(GUEST)`,
   řádek ~188). Feed (`loadFeedAttrsMap`) se používá výhradně na
   manufacturer/category/allowLoyaltyDiscount atributy pro policy výpočet,
   ne na klíč porovnání. Obě strany srovnání tedy čtou identický `item.code`
   tvar ze stejného zdroje -- mismatch kódů mezi zdroji není možný.
2. **Hypotéza 2 (off-by-one ve `fetchPaginated()`) -- nepotvrzena.** Všech
   5 testovaných kódů, včetně celého bloku 56384-56398, je teď přítomných
   a se **správně vyplněným `sales` polem** ve všech třech testovaných
   ceníkách (ZR10/ZR20/ZR25) i v base/GUEST pullu. `do { ... } while (page
   <= totalPages)` samo o sobě nevynechává poslední stránku.

**Nová, live podložená hypotéza -- pagination-during-mutation:**
`fetchPaginated()` prochází ~168 stránek sekvenčně za ceník (11 ceníků ×
~168 stránek, přes rate limiter) -- celý běh `reconcile-coupon-drift.ts`
musí podle toho trvat desítky minut. Pokud se BĚHEM tak dlouhého pullu
změní řazení/počet položek v ceníku (souběžný `sync.yml` cron, webhook
zápis kupónu/ceny, změna skladu), Shoptet stránkuje nad posunutou sadou dat
-- stránka, co byla v čase `page=N` "položka 46001-47000", může být o pár
minut později "položka 45950-46950", takže se položky mezi dvěma po sobě
jdoucími fetchi buď vynechají, nebo zduplikují. **Blok 15 po sobě jdoucích
kódů (56384-56398)** z původního běhu tomu odpovídá přesně jako obrys --
to je typický tvar "celá stránka dat vypadla", ne náhodný rozptyl
jednotlivých kódů, což by odpovídalo skutečnému mismatchi klíčů.

**Vedlejší nález (souvisí s PROGRESS_LOG.md, bod 1 z 2026-08-19):**
`getPricelistItemByCode()` (`?code=` filtr na `/pricelists/{id}`, používaný
jako post-write verifikace v `pricelist-writer.ts`/`coupon-sales-writer.ts`)
vrátil **NULL pro všech 5 testovaných kódů**, přestože plný paginovaný pull
je najde bez problému. Potvrzeno teď živě i mimo dřív podezřelé "skryté
produkty" (39373/68172) -- `?code=` filtr na tomhle endpointu/účtu vypadá
nespolehlivý obecně, ne jen pro skryté položky.

**Navržený fix -- IMPLEMENTOVÁNO (bod 1 dole), zbytek zůstává otevřený:**
1. ~~Reconciliace: druhý nezávislý pull~~ -- **nahrazeno lepším řešením
   přímo v `fetchPaginated()`** (viz níže), takže tenhle krok navíc není
   potřeba: `reconcile-coupon-drift.ts` teď z principu nemůže dostat
   neúplná data, aniž by o tom věděl.
2. **`fetchPaginated()` (`shoptet-api/client.ts`) -- HOTOVO.** Přidán
   integrity check: po dokončení pullu se porovná `items.length` s
   `paginator.totalCount` z POSLEDNÍ stažené stránky (ne první -- totalCount
   se může posunout uprostřed pullu stejným mechanismem jako počet
   položek). Při nesedícím součtu se **celý pull opakuje od začátku**
   (max. 3 pokusy), a pokud se ani po 3 pokusech nesrovná, funkce **throwne**
   místo tichého vrácení neúplných dat -- volající (reconciliace, sync,
   customers/orders čtení) teď dostane buď garantovaně kompletní data, nebo
   explicitní chybu, nikdy tiše useknutý seznam. `maxPages`-truncated volání
   (záměrně částečný fetch) integrity check přeskakují. Implementace přidala
   `fetchPaginatedOnce()` jako interní helper, `fetchPaginated()` je teď
   retry wrapper okolo něj. 4 nové regresní testy v `tests/client.test.ts`
   (match/retry-success/exhausted-throw/maxPages-skip), celá sada
   `cloudflare-worker` (103 testů) zelená po změně.
3. **`getPricelistItemByCode()` nespolehlivost -- STÁLE OTEVŘENO.** Živě
   potvrzeno (viz výše), ale mimo rozsah tohohle fixu -- dotýká se
   `pricelist-writer.ts`/`coupon-sales-writer.ts` produkční zápisové cesty,
   chce samostatné ověření/testing než se sáhne na post-write verifikaci.
   Navrhované řešení beze změny: nahradit `getPricelistItemByCode()` malým
   `getPricelistProducts(id, maxPages=1)` + klientským filtrem, nebo (pokud
   kód může být na libovolné stránce) fallbackem na plný pull jen pro
   verifikaci jednoho produktu po zápisu.
4. **Další krok:** spustit `reconcile-coupon-drift.ts` naostro (příští cron
   běh, nebo ručně) a ověřit, že 341 neshod z 2026-08-20 04:06 UTC kleslo na
   reálné číslo (očekávaně blízko 0, pokud je hypotéza pagination-during-
   mutation správná). Zatím neověřeno živě po nasazení.

**Verze:**
main (2026-08-20), fix v `cloudflare-worker/src/shoptet-api/client.ts`
(nekomitnuto -- čeká na Janovo schválení commitu)

---

## 2026-08-21 -- INC-012: fix nasazen, ale hypotéza pagination-during-mutation VYVRÁCENA vlastním fixem

**Kontext:** Fix z 2026-08-20 (integrity check v `fetchPaginated()`,
commit `db08913`, pushnuto na `main`) běžel poprvé naostro v pravidelném
cronu `reconcile-coupon-drift.yml` (run `32445846840`, 2026-08-21 04:08 UTC).

**Výsledek:**
- Zkontrolováno: 183 854 kombinací produkt×ceník.
- ALERT -- zcela chybí: **220** (dřív 170 při běhu, co založil INC-012).
- ALERT -- hodnota nesedí (2+ běhy): **202** (dřív 171).
- Celkem **422 neshod** -- víc než dřívějších 341, ne míň.
- Self-check OK (běh proběhl na plausibilním objemu dat).
- **`[Paginator] Integrity` se v logu běhu neobjevuje ani jednou** -- žádný
  mismatch proti `paginator.totalCount` nenastal, `fetchPaginated()` tedy
  při tomhle běhu nezaznamenal jedinou stránku, co by tiše vypadla.

**Závěr: hypotéza pagination-during-mutation z předchozí aktualizace je
VYVRÁCENA vlastním fixem.** Pokud by byla správná, integrity check by teď
odchytával mismatch, retryoval, a alerty by klesly k nule. Místo toho se
integrity check ani jednou nespustil do retry větve A počet alertů
STOUPL. Neshody jsou tedy reálné/přetrvávající, ne přechodný artefakt
souběžného zápisu během dlouhého pullu.

**Co to znamená pro fix z 2026-08-20:** není špatně -- dělá přesně to, co
má (garantuje kompletnost dat nebo throwne), a zůstává v repu jako obecně
správná ochrana pro všechny volající `fetchPaginated()`. Jen neřeší INC-012
false-positives, protože to nikdy nebyla jejich příčina.

**INC-012 zůstává OTEVŘENÝ, root cause NEZNÁMÝ.** Další krok: vrátit se
k původním dvěma hypotézám z prvního zápisu (2026-08-20), tentokrát
prozkoumat ne paginaci, ale skutečný obsah neshod -- konkrétně čím se liší
těch 220 "zcela chybí" a 202 "hodnota nesedí" kódů od zbytku katalogu (růst
oproti 341 -> 422 mezi dvěma běhy navíc naznačuje, že se problém možná i
zhoršuje/rozšiřuje, ne že je stabilní). Zkontrolovat konkrétní kódy z
aktuálního běhu (artifact `coupon-reconciliation-log` u run `32445846840`)
stejným způsobem, jako se dřív živě ověřil 56167 -- přímým dotazem na
Shoptet API, ne spekulací.

**Verze:**
main (2026-08-21), run `32445846840`

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

**HODNOTY (ne jen boolean) ověřeny na 5 náhodných "starých" produktech
(100798-100802, ZR4):** `computeCouponWrites()` (produkční funkce) spočítala
`minPriceRatio=0.8400` u všech pěti, živá hodnota v Shoptetu **přesně
sedí** (`0.840`) u všech pěti. Na tomhle vzorku je tedy potvrzeno: pro
již plně synchronizované produkty jsou kupónové HODNOTY (ne jen
zámek/checkbox) správně dopočítané a zapsané, ne jen náhodou "vypadají
OK". Malý vzorek (5 kusů) -- ne vyčerpávající důkaz, ale konzistentní se
závěrem výše (problém omezen na ~61 nedokončených produktů, ne
celoplošný).

**DŮLEŽITÁ MEZERA V OVĚŘENÍ (Jan se explicitně ptal, přiznáno):**
Hodnotový test proběhl JEN na tieru **ZR4** (5 vzorků) a zámek
(discountCoupon boolean) jen na **ZR20+ZR25** (celý katalog). **NEOVĚŘENO
vůbec:** ZR6, ZR8, ZR10, ZR12, ZR14, ZR16, ZR18 (ani hodnoty, ani
zámek/lock), a **NEOVĚŘENO hlavní/základní ceník** ("Hlavný cenník",
pricelist id 1) -- u toho navíc není ani jasné, jestli tam kupónová
logika platí stejným způsobem (guest/výchozí ceník, jiný kontext než
tier ceníky). Před jakýmkoli tvrzením "kupóny jsou v pořádku napříč
celým katalogem" je potřeba tohle doplnit -- zatím je to ověřeno jen na
2 z 10 tier ceníků plus vůbec ne na základním ceníku.

**ZADÁNÍ PRO PŘÍŠTÍ SESSION (Jan, explicitně, vysoká priorita):**
Kupónový pipeline potřebuje **stejný 5-stupňový validační model jako
pricing** (viz `CORE_LOGIC_AND_VALIDATION.md` §3, Stage 1-5) **VČETNĚ
self-check vrstvy** (validace toho, že samotná validace/reconciliation
proběhla smysluplně, ne jen "0 alertů" bez záruky, že se vůbec něco
zkontrolovalo -- stejný vzorec jako `reconcile-pricelist-drift.ts`'s
self-check sekce). Konkrétně potřeba postavit:
1. Stage 4 (run-level fail-closed) pro `sync-coupon-fields-single-product.ts`
   a příbuzné skripty -- pokud dnes tiše nezapíšou, nikdo se to nedozví.
2. Stage 5 (reconciliation) pro kupóny -- návrh už je výše (obdoba
   `reconcile-pricelist-drift.ts`, `computeCouponWrites()` jako zdroj
   pravdy, ZR20/ZR25 always-false jako první/nejjednodušší kontrola).
3. Self-check uvnitř té Stage 5 kupónové reconciliace -- stejný vzorec:
   minimální očekávaný počet zkontrolovaných produktů×tierů, jinak
   "0 alertů" není důvěryhodné.
Tohle NENÍ dnes postavené -- jen navržené a zdůvodněné. Priorita na
začátek příští session dle Jana.
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

**INC-011 sedmý nález — Stage 4/5 postaveny, ZR6-ZR18 + hlavní ceník dopověřeny (2026-08-13, pokračování):**

Dopověřeno přesně to, co minulá session nechala otevřené (viz "Co NENÍ ověřeno" výše):

1. **Stage 4 (`sync-coupon-fields-single-product.ts`):** skript dřív `stats.failed`
   z `CouponSalesWriter.processTierBatch()` jen logoval, nikdy nepropagoval --
   částečné selhání zápisu (např. Shoptet 5xx na jedné dávce) by se tvářilo jako
   úspěch, přesně stejný tvar chyby jako INC-010's `sync-orchestrator.ts` před
   opravou. Opraveno: skript teď po zápisu na všechny ceníky `throw`ne, pokud
   `stats.failed > 0` na kterémkoli z nich -- fail-closed, exit code zčervená,
   webhook step v `sync.yml` to nahlásí.

2. **Stage 5 (`cloudflare-worker/src/cli/reconcile-coupon-drift.ts` +
   `.github/workflows/reconcile-coupon-drift.yml`):** postaveno analogicky k
   `reconcile-pricelist-drift.ts` -- `computeCouponWrites()` (produkční funkce)
   jako zdroj pravdy, nezávisle přepočítá očekávaný `discountCoupon`/
   `minPriceRatio` pro KAŽDÝ produkt × VŠECH 11 ceníků (10 ZR tierů + GUEST/
   "Hlavný cenník" -- řeší i otevřenou otázku "co s hlavním ceníkem", protože
   `computeCouponWrites()` už dnes GUEST položku počítá jako součást stejného
   výstupu), a porovná se skutečným stavem na Shoptetu. ZR20/ZR25
   always-`discountCoupon:false` (Rule 4) je vlastní, samostatná, OKAMŽITÁ
   alert kategorie (bez debounce) -- první/nejjednodušší kontrola, přesně dle
   zadání. Self-check (min. 5000 produktů ze základního ceníku, min. 5000×11
   zkontrolovaných kombinací, min. 5000 kódů s feed atributy) mirror stejného
   vzorce jako `reconcile-pricelist-drift.ts`.

   **Živě spuštěno (read-only, 2× -- první běh měl falešně vysoký počet
   "neshod" kvůli přílišně přísnému porovnání `minPriceRatio` i když byl
   `discountCoupon=false` na obou stranách -- opraveno, `minPriceRatio` se
   teď porovnává jen když je kupón aspoň na jedné straně skutečně povolený,
   protože jinak nemá na checkout žádný vliv). Výsledek druhého (opraveného)
   běhu, celý katalog, všech 11 ceníků:**
   - Zkontrolováno: 183 766 kombinací produkt×ceník.
   - Sedí: 170 184 (92,6 %).
   - **ZR20/ZR25 lock porušen: 122 produktů** (přesně stejné číslo v obou
     bězích -- tahle logika se opravou neměnila, potvrzeno konzistentní).
     Dvojnásobek dřívějšího odhadu 61 -- dřívější číslo bylo jen ZR20 NEBO
     ZR25 na 61 kódech se stejnou dvojicí, 122 = 61 kódů × oba tiery
     (ZR20 i ZR25 zvlášť), takže rozsah odpovídá dřívějšímu nálezu, jen teď
     počítaný per-ceník místo per-produkt.
   - Zcela chybějící záznam / bez `sales` polí: 0 (na rozdíl od cenových
     ceníků žádný produkt kupónová pole úplně nepostrádá).
   - **13 460 nových neshod hodnoty** (první spatření dnes, čeká na
     potvrzení zítřejším během -- debounce, zatím NEALERTOVÁNO): rozloženo
     napříč VŠEMI tiery (ZR4: 2212, ZR6: 2231, ZR8: 2011, ZR10: 1208,
     ZR12: 1257, ZR14: 1253, ZR16: 448, ZR18: 445, GUEST: 2395) --
     **ZR6-ZR18 tedy TEĎ POPRVÉ prověřeny, ne jen ZR20/ZR25 jako minule.**
     Vzorek ukazuje konzistentní vzorec (např. hodně produktů:
     expected `minPriceRatio=0.9400`, actual `0.880`) -- vypadá to jako
     systematický, ne náhodný drift, ale ROOT CAUSE nezjišťován v rámci
     dnešního zásahu (mimo scope -- Stage 5 měla za úkol drift ODHALIT, ne
     hned diagnostikovat). Čeká na zítřejší potvrzující běh (debounce) a
     na Janovo rozhodnutí o dalším postupu.
   - Self-check: OK (plausibilní objem dat na obou bězích).

3. **Rozhodnutí, co NENÍ v rámci dnešního zásahu:** žádný live zápis
   kupónových polí neproběhl -- reconciliace je striktně read-only, přesně
   jako cenová obdoba. 122 lock-porušení a 13 460 pending neshod čekají na
   Jana, ne na automatickou opravu.

**Zbývá:**
- Zítřejší scheduled běh `reconcile-coupon-drift.yml` (03:30 UTC,
  staggered vůči price reconciliation 03:00) potvrdí/vyvrátí těch 13 460
  pending neshod přes debounce a nahlásí GitHub Issue (`coupon-integrity`
  label), pokud přetrvají.
- Root-cause systematického `0.94` vs `0.88` vzorce (a příbuzných) --
  nezjišťováno dnes, kandidáti: zastaralá `coupon-state.json` z doby před
  nějakou změnou `policy-v1.json`/`coupon-policy.json`, nebo
  `sync-coupon-fields-diff.ts` (na rozdíl od opraveného
  `sync-coupon-fields-single-product.ts`) STÁLE čte feedovo `maxDiscount`
  jako `productMaxDiscount` (řádek 185-186) -- nekonzistentní se
  zdokumentovanou opravou v `coupon-sales-writer.ts` (2026-08-06), pokud
  je tohle skript, co live data skutečně zapsal. Stojí za prověření, než
  se bude řešit náprava 122 lock-porušení nebo 13 460 neshod.
- 122 lock-porušených produktů: opravit ručně/skriptem (mimo scope
  dnešního zásahu -- byl to explicitní požadavek jen na POSTAVENÍ Stage
  4/5, ne na nápravu nálezů).

**Verze:** main (2026-08-13).

---

**INC-011 osmý nález — živá náprava provedena, INC-011 UZAVŘEN (2026-08-13, pokračování):**

Na Janovo přímé zadání ("potřebuju aby vse fungovalo... udelej to at maji vsechny oprodukty") proveden živý zápis přes `sync-coupon-fields-live.ts` (existující produkční skript, stejná bezpečná konvence -- `productMaxDiscount` NIKDY nečte feedovo `maxDiscount`, stejně jako `reconcile-coupon-drift.ts` a `sync-coupon-fields-single-product.ts` -- takže živý zápis se přesně shoduje s tím, co reconciliace označila za "očekávané").

**Průběh (spuštěno Janem přímo v terminálu, `!` prefix, kvůli sandboxovému blokování hromadného produkčního zápisu přes agenta):**
Všech 11 ceníků (10 ZR tierů + GUEST), postupně, každý s vlastním rollback snapshotem (`.snapshots/coupon_sales_<id>_rollback_<timestamp>.json`) před zápisem:

| Tier | Zpracováno | Selhalo |
|---|---|---|
| ZR4 | 16706 | 0 |
| ZR6 | 16706 | 0 |
| ZR8 | 16706 | 0 |
| ZR10 | 16706 | 0 |
| ZR12 | 16706 | 0 |
| ZR14 | 16706 | 0 |
| ZR16 | 16706 | 0 |
| ZR18 | 16706 | 0 |
| ZR20 | 16706 | 0 |
| ZR25 | 16706 | 0 |
| GUEST | 16706 | 0 |

**`=== CELÝ KATALOG ZAPSÁN ===`, 0 selhání na kterémkoli ceníku.**

**Ověření po zápisu (read-only, `reconcile-coupon-drift.ts`, celý katalog znovu):**
- Zkontrolováno: 183 766 kombinací produkt×ceník.
- **Sedí: 183 766 (100 %).**
- ALERT -- ZR20/ZR25 lock porušen: **0** (dřívějších 122 opraveno).
- ALERT -- zcela chybí: 0.
- ALERT -- hodnota nesedí: 0.
- Self-check: OK.

**Root cause (sedmého nálezu) tímto fakticky obejit, ne formálně diagnostikován:** živý plošný přepočet přes `computeCouponWrites()` přepsal cokoli, co tam předtím bylo (ať už z rozbitého `sync-coupon-fields-diff.ts` s jeho `maxDiscount` nekonzistencí, nebo z chybějících webhooků) správnou hodnotou. Otázka "co přesně naposledy zapsalo těch 13 460 špatných hodnot" zůstává technicky nezodpovězená, ale je teď akademická -- katalog sedí 1:1 s produkční pravdou. Doporučeno pro budoucnost: než se `sync-coupon-fields-diff.ts` znovu zapne/použije (momentálně žádný scheduled trigger neběží, cron byl archivován), opravit jeho řádek 185-186 na stejnou bezpečnou konvenci jako zbytek pipeline, jinak by příští běh mohl znovu rozjet stejný drift.

**INC-011 UZAVŘEN end-to-end:** Stage 4 (fail-closed) a Stage 5 (reconciliation + self-check) postaveny a commitnuty, celý katalog naživo ověřen (10/10 ceníků + GUEST, ne jen ZR20/ZR25 jako na začátku), 122 lock-porušení i 13 460 hodnotových neshod opraveny živým zápisem, druhé nezávislé ověření po zápisu potvrzuje 0 alertů na 183 766 kontrolách.

**Verze:** main (2026-08-13), UZAVŘENO.

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

## 2026-08-25

### INC-013
**Popis:**
1. Diagnostické statistiky (`GlobalStats`) hlásily v konzoli a na monitorovacím dashboardu (`/dashboard`, `POST /v1/sync-stats`) trvale `phase=starting` a `GET=0` / `PATCH=0` i přesto, že synchronizační smyčka reálně stahovala a zpracovávala tisíce produktů (např. `"Stahuji detail produktu 5750/8648"`). Monitoring se tak jevil jako zamrzlý.
2. V `client.ts` v metodě `fetchPaginatedOnce` hrozilo riziko zbytečných volání nebo nestandardního chování při dotazování prázdných entit (např. zákazník s 0 objednávkami, kde `totalCount === 0`, nebo prázdná 1. stránka `items: []`).

**Příčina:**
1. **Module Singleton Hazard:** `GlobalStats` byl definován jako obyčejný exportovaný objekt v `client.ts`. Při načítání modulu v různých kontextech (ESM rozhraní, relativní vs. absolutní cesty mezi `scripts/run-real-sync.ts` a `cloudflare-worker/src/shoptet-api/`) docházelo k vytváření izolovaných instancí objektu v paměti Node.js procesu. Navíc dlouhé smyčky v `ProductsReader` a `CustomerAdapter` neaktualizovaly `GlobalStats.phase` průběžně.
2. **Chybějící explicitní guard podmínky v do-while smyčce:** Původní `do-while` smyčka ve `fetchPaginatedOnce` pokračovala do další iterace, i když Shoptet API vrátilo prázdnou sadu položek nebo explicitně hlásilo `totalCount === 0` / `pageCount === 0`.

**Oprava:**
1. `client.ts`: `GlobalStats` byl navázán na globální kontext `globalThis` pomocí `Symbol.for('__SHOPTET_GLOBAL_STATS__')`, což garantuje 100% identickou instanci napříč všemi importy v Node.js/Worker běhu.
2. `products-reader.ts` a `customer-adapter.ts`: Přidány průběžné aktualizace `GlobalStats.phase` (např. `fetch-products (50/8648)`, `customer-orders (1/2)`, `customer-details (100/400)`).
3. `client.ts`: Metoda `fetchPaginatedOnce` byla přepsána na robustní `while (true)` smyčku s explicitními guardy:
   - Bezpečný optional chaining `result?.data?.paginator`.
   - Okamžité ukončení při `totalCount === 0` nebo `totalPages <= 0` po prvním requestu.
   - Okamžité ukončení při prázdné stránce (`items.length === 0`).
   - Bezpečný inkrement čítače `GlobalStats.apiRequests.GET = (GlobalStats.apiRequests.GET || 0) + 1`.
4. `client.test.ts`: Přidány komplexní automatizované testy ověřující okamžité ukončení při `totalCount: 0`, ochranu proti zacyklení a sdílený stav `GlobalStats` v `globalThis`.

**Verze:**
main (2026-08-25)

