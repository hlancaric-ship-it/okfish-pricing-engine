# Progress log

Running, dated notes on what's in progress, what was just finished, and what's
planned next — kept so work picks back up correctly across sessions/context
resets, not just from memory. Newest entry on top. Each entry: what changed,
why, and what's still open.

---

## 2026-08-13

**Incident:** 99459 a 103525 (nové produkty přidané Yopni 2026-08-12) neměly
vůbec dopočítané tier-ceny na wholesale ceníku — Jan je musel dopisovat
ručně. Na frontendu se přihlášenému ZR25 zákazníkovi zobrazovalo jen -10 %
místo -25 %. Root cause: `sync.yml` doběhl zeleně, i když ceny fakticky
chybely — tři na sobě navazující tiché-selhání bugy:

1. `cloudflare-worker/src/shoptet-api/products-reader.ts` (inkrementální
   větev): když Shoptet ještě nepropsal `perPricelistPrices` pro nově
   založený produkt na základní ceník, kód fabrikoval `basePrice=0` a
   produkt přesto poslal dál do pricing enginu.
2. `cloudflare-worker/src/shoptet-api/pricing-bridge.ts`: `validateInput` /
   `validateResult` / `res.rejected` / vyhozená výjimka se pro konkrétní
   SKU+tier prostě zahodily (`catch (e) { /* Ignore */ }`) — bez logu, bez
   počítání jako failure.
3. `cloudflare-worker/src/shoptet-api/sync-orchestrator.ts`: `isSuccess`
   se sice vypočítal a vypsal do konzole jako `FAILED`, ale nikdy se
   nepropagoval jako throw — `run-real-sync.ts` tak viděl exit 0, GitHub
   Actions job zůstal zelený, žádný issue se nevytvořil.

**Fix (jen v repu, zatím nenasazeno na produkci):**
- `products-reader.ts`: chybějící `perPricelistPrices` entry produkt vynechá
  z běhu (`incompleteCodes`), nefabrikuje se cena 0.
- `pricing-bridge.ts`: každé selhání validace/výpočtu/zamítnutí se teď loguje
  (`console.warn` s SKU+tier+reason) a vrací se v poli `failures`.
- `sync-orchestrator.ts`: `isSuccess` teď zohledňuje `incompleteCodes` i
  `pricingFailures`; při neúspěchu se `lastSync` NEPOSUNE (produkt se zkusí
  znovu příští cron běh za 15 min) a na konci se hodí `throw` — takže
  GitHub Actions job zčervená a vytvoří se issue (mechanismus v sync.yml už
  existoval, jen se nikdy nespustil).
- Aktualizovány testy `cloudflare-worker/tests/products-reader.test.ts`
  (nový regresní test na fabrikaci ceny 0) a `scripts/verify-pricing-bridge-samples.ts`
  na nový návratový tvar. Celá sada 236/236 zelená.
- Přidán `FLACARP` do `brandLimits` v `src/config/policies/policy-v1.json`
  (10% strop) — jediný zdroj pravdy, sdílený wholesale enginem
  (`pricing-bridge.ts`) i frontend/coupon enginem
  (`cloudflare-worker/src/engine/config.ts` ho importuje přímo). Název
  značky odhadnut z produktových názvů ve `products.csv` ("FLACARP") —
  pokud `manufacturer` pole z master feedu používá jiný casing, lookup je
  case-sensitive a strop se potichu neuplatní; stojí za ověření na živém
  feedu.

**Co je pořád otevřené:**
- 99459 a 103525 samotné se dopočítají automaticky na dalším syncu POTÉ,
  co se tenhle fix nasadí (produkt musí být znovu "changed" — Janův ruční
  zápis ceny to už vyvolal, takže by měly naskočit hned v prvním běhu po
  merge). Není nasazeno — čeká na review/merge/deploy.
- Neověřeno na živém feedu, jestli `FLACARP` je přesný string v poli
  `manufacturer` (case-sensitive match v `DiscountLimitPolicy`).
- Stejná třída tichého polykání chyb může existovat i jinde v pipeline
  (např. `customerWriter`/`pricelistWriter` interní retry logika) —
  nekontrolováno v rámci tohoto zásahu.

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
