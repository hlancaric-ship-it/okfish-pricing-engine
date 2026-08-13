# Progress log

Running, dated notes on what's in progress, what was just finished, and what's
planned next — kept so work picks back up correctly across sessions/context
resets, not just from memory. Newest entry on top. Each entry: what changed,
why, and what's still open.

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
