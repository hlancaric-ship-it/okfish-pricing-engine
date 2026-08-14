# Core Pricing/Coupon Decision Logic & the 5-Stage Validation Model

Engineering reference for two things: (1) the exact precedence rules the
engine applies when computing a price or a coupon decision, and (2) the
**5-stage validation model** the codebase now implements to keep a bad config
from ever reaching a live price, AND to keep a live price that already went
wrong from staying wrong unnoticed. This document assumes the reader has
already read `ENGINE_TECHNICAL_TEMPLATE.md` for the general architecture (two
engines, sync pipeline, tier system) — it is not repeated here. This is a
build/scale/validate reference for standing up the next client, not a repeat
of the architecture tour.

**Extended from 3 to 5 stages on 2026-08-13 (INC-010).** The original 3
stages (config-load, pre-write dry-run, regression tests) all answer variants
of "is this *change* safe to make." None of them answer a different
question that INC-010 exposed the hard way: "did the code that's *supposed*
to keep prices correct actually work, for the last 12 days, across the whole
catalog?" A `getProductDetail()` bug silently no-op'd the incremental price
pipeline for 12 days — every single sync run reported `SUCCESS`, Stage 1–3
all stayed green throughout, and 812 products (~4.9% of the catalog) quietly
drifted to a wrong or missing wholesale tier price with zero errors, zero
alerts, zero test failures. Stages 1–3 protect a *change*. Stages 4–5 (new)
protect the *outcome*, independently of whether any individual run ever
reported failure.

## 1. Core Decision Logic (Precedence, Precisely)

There are two separate decision layers. They are invoked at different times,
by different code paths, and they do not call each other — but they must
agree on the same discount ceiling for a given product, or the coupon layer
could grant room the pricing engine would never actually honor.

### 1.1 Price-cap resolution (`cloudflare-worker/src/engine/config.ts`,
`cloudflare-worker/src/engine/pricing.ts`)

Discount cap lookup order, `resolveActiveLimit()` (`pricing.ts:71`):

```
PRODUCT_LIMITS[code]  →  BRAND_LIMITS[brand]  →  CATEGORY_LIMITS[category]  →  none
```

`PRODUCT_LIMITS` itself (`config.ts:109-115`) is built by **object-spread
merge, in this exact order, last write wins**:

```
{}                                        (empty)
  ← zero-discount-products.json           (code -> 0)
  ← clearance-sale-products.json          (code -> pct/100, date-window filtered)
  ← product-max-discount-overrides.json   (code -> pct/100)   ** highest priority **
```

Given a product/action price, `calculateAllTierPrices()` (`pricing.ts:107`):
1. Parse `basePrice`.
2. Parse `actionPrice`; if not strictly below `basePrice`, treat as absent
   (guards against stale promo fields left in the feed).
3. Resolve the active cap via the lookup order above.
4. **Clearance-vs-cap rule** (`pricing.ts:143-164`): if a cap is active *and*
   an action price is present, the action price wins outright — never
   floor-clamped up to the cap, never beaten by a deeper loyalty-tier
   discount. The cap only clamps a *loyalty-only* price (no action price).
5. Otherwise, for each loyalty tier, take the lower of tier price vs. action
   price, then clamp to the cap.

### 1.2 Coupon decision (`src/coupon/CouponPolicy.ts`,
`cloudflare-worker/src/coupon/compute-coupon-writes.ts`)

`CouponPolicy.decide()` (`CouponPolicy.ts:22-56`), checked **in this exact
order, first match wins**:

1. **Rule 4 — locked tiers** (absolute precedence): `customerTier` is in
   `coupon-policy.json.lockedTiers` → no coupon, `maxDiscount = 0`. Checked
   before anything else, no exceptions.
2. **Rule 1**: `productMaxDiscount === 0` → no coupon.
3. **Rule 2**: `productMaxDiscount` set and below `standardLimit` → coupon
   room = `productMaxDiscount − max(productDiscount, tierDiscount)`, if
   positive.
4. **Rule 3**: product's own discount already ≥ `standardLimit` → no coupon.
5. **Rule 5 (default)**: coupon room = `standardLimit − max(productDiscount,
   tierDiscount)`.

`compute-coupon-writes.ts` is the caller that turns one `decide()` call into
a real write payload per pricelist:

- `resolveEffectiveLimit()` (line 43) mirrors the price-cap lookup order in
  §1.1 (Product → Brand → Category) **exactly**, so the coupon layer can
  never grant more room than the pricing engine would apply on its own. This
  is the single most important cross-layer invariant in the system — see the
  margin-safety test in §4.3.
- `couponDisabled` check (line 80, `computeItem()`) short-circuits to
  no-coupon *before* `decide()` runs, for products/brands listed in
  `coupon-policy.json.disabledProducts`/`disabledBrands`.
- Both `productDiscount` and raw tier discount are clamped to
  `effectiveLimit` before being handed to `decide()` (lines 108-113) — the
  three-way interaction (clearance + tier + coupon) is resolved by clamping
  first, then applying the five rules above to the clamped values, not by any
  special-cased three-way branch. See §4.3 for the tests exercising this.
- `minPriceRatio = 1 − maxDiscount` (line 122) is written per-pricelist,
  relative to that pricelist's own (already tier-discounted) price.

**Why two separate layers instead of one**: the price engine decides what a
shopper *sees* on the storefront; the coupon layer decides what checkout will
*accept*. They must independently arrive at a consistent ceiling — which is
exactly why `resolveEffectiveLimit()` duplicates the price-cap fallback
instead of importing a shared function (Worker/root deploy boundary, per
`ENGINE_TECHNICAL_TEMPLATE.md` §1). The 3-stage model in §3 exists largely to
keep these two independently-implemented lookups from silently drifting.

### 1.3 Brand sale discounts (`brandSaleDiscounts`, added 2026-08-14)

A **permanent, year-round brand-wide action price** — e.g. "DELPHIN is always
-15% off standard price" — is a fundamentally different rule from `brandLimits`
(§1.1's discount ceiling), even when the two happen to share a number (MIVARDI
is -10% sale AND 10% cap). Confirmed business rules as of 2026-08-14:

| Brand (exact `manufacturer` string) | `brandSaleDiscounts` | `brandLimits` |
|---|---|---|
| `DELPHIN` | 0.15 | *(none)* |
| `DELPHIN BOMB` (singular, not "BOMBS") | 0.15 | *(none)* |
| `MIVARDI` | 0.10 | 0.10 (pre-existing, independently declared) |
| `MIKADO` | 0.09 | *(none)* |

**Where it lives**: `src/config/policies/policy-v1.json`'s `brandSaleDiscounts`
key, sibling of `brandLimits`, same file, same ratio convention (0.15 = 15%).
**Never** derive one from the other — a brand having a sale is not evidence it
should also have a cap, and vice versa (§5's worked-example principle applies
here too: a new business rule gets its own key, not overloaded onto an
existing one).

**How it reaches the engine** (deliberately *not* inside `DiscountLimitPolicy`/
`HighestDiscountPolicy`/`PricingInput`/`PricingResult` — this is an input-
assembly concern, not core decision logic):

- `cloudflare-worker/src/engine/config.ts` exports `BRAND_SALE_DISCOUNTS`
  (mirrors `BRAND_LIMITS` exactly).
- `cloudflare-worker/src/engine/pricing.ts`'s `calculateAllTierPrices()`:
  right after the existing `actionPrice` no-op guard, if the row still has no
  action price, one is synthesized from `BRAND_SALE_DISCOUNTS[manufacturer]`.
  From that point on it's an ordinary action price — every downstream rule
  (§1.1 steps 4-5, the clearance-vs-cap logic) applies unchanged.
- `cloudflare-worker/src/shoptet-api/pricing-bridge.ts` (the actual production
  write path `sync-orchestrator.ts` calls every 15 minutes): same synthesis,
  right after the existing `salePriceNum` computation, feeding
  `PricingInput.salePrice` — so the real wholesale tier writes (ZR4-ZR25) get
  it automatically, including for a product added to the catalog tomorrow,
  with zero manual step. The synthesized value is also recorded on the result
  as `brandSaleActionPrice` *only* when synthesized (never when the product
  already had its own action price) — `sync-orchestrator.ts` uses this to
  also write/maintain the real "Akční cena" field on the base/GUEST pricelist
  (id 1) via the *same* `PricelistWriter` every other pricelist write goes
  through, never touching `price` itself, only `actionPrice`. An existing
  per-product sale (its own `actionPrice` already present) is never touched
  by any of this — same "výprodej-ochrana" precedent used elsewhere.
- `desktop-app/lib/pricingEngine.js` (the 1:1-ported copy used for local
  preview/export tooling) mirrors the identical synthesis, gated on a new
  optional `limits.brandSaleDiscounts` param, so a caller that doesn't pass it
  (existing call sites) is unaffected.

**Why no cap unless one is explicitly declared**: without an active
`brandLimits` cap, `calculateAllTierPrices()`'s existing step 5 (§1.1) picks
whichever of {synthesized sale price, loyalty price} is *deeper* per tier —
so DELPHIN's baseline -15% is what a guest/low-tier customer sees, while a
ZR25 customer's real 25% loyalty discount still applies on top, never capped
at 15%. Only when a brand *also* has a `brandLimits` entry (MIVARDI) does
step 4's cap-authoritative branch make the sale price flat across every tier.

## 2. Building This Correctly for a New Client, From Scratch

Order matters. Each step depends on artifacts the previous step produced.
Do not skip ahead — a coupon ceiling set before loyalty tiers exist has
nothing to be relative to, and a sync cron wired up before the safety fuses
are tuned to the new catalog size is a live-price incident waiting to happen.

1. **Loyalty tiers** — write `src/config/policies/policy-v1.json`'s
   `loyaltyTiers` map (any names, any count, ratios not percentages).
   Nothing downstream works without this; it's the one file every other
   config keys off of (both engines' `TIER_NAMES`, `compute-coupon-writes.ts`'s
   tier-discount lookups, the frontend's tier→pricelist resolution).
2. **Shoptet pricelists** — create one pricelist per tier in Shoptet admin,
   plus confirm the guest/default pricelist ID. Write
   `cloudflare-worker/src/coupon/tier-pricelist-map.ts`'s `TIER_PRICELIST_MAP`
   to match. This is a manual, hand-verified mapping — there is no API to
   auto-discover it reliably, which is exactly why `sync-coupon-fields-diff.ts`
   re-validates it live before every write batch (§1.2, §3.2 Stage 2).
3. **Brand/category limits** — `policy-v1.json`'s `brandLimits`/
   `categoryLimits`, if the client has any blanket caps below 100%.
4. **Per-product policy files** — `zero-discount-products.json`,
   `clearance-sale-products.json`, `product-max-discount-overrides.json`.
   Populate these *after* tiers/limits exist, because Stage 1 validation
   (§3.1) will refuse to even load the module if a product code lands in more
   than one of these three files — you need all three finalized to pass that
   check, not built incrementally against a partially-populated set.
5. **Coupon policy** — `coupon-policy.json` (`defaultMaxDiscount`,
   `lockedTiers`, `disabledBrands`/`disabledProducts`). This is the ceiling
   value to confirm explicitly with the client — get it wrong and every
   coupon-room calculation downstream is wrong.
6. **Dry-run the diff sync** — `npx tsx sync-coupon-fields-diff.ts` (no
   `--live`) against the real feed before any cron is wired up. This is the
   first point a wrong `MIN_EXPECTED_PRODUCTS` or a systematically wrong feed
   mapping becomes visible, and it costs zero Shoptet API calls.
7. **Tune the two safety-fuse constants** to the new catalog
   (`MIN_EXPECTED_PRODUCTS`, `MAX_CHANGE_RATIO` — see §3.2). Do this *before*
   the first live run, not after an incident.
8. **Wire up cron/webhook workflows** (`sync.yml`,
   `sync-products-worker-cache.yml`, `coupon-fields.yml`) with staggered
   offsets, only once steps 1-7 have been dry-run clean.
9. **Frontend tier resolution** — re-implement however this client's
   storefront exposes customer identity (§4/§6 of the technical template);
   this has no dependency on 1-8 and can be built in parallel, but must not
   go live before the pricelist map (step 2) is confirmed correct, since a
   wrong tier→pricelist mapping is invisible in the UI but silently wrong at
   checkout.

## 3. The 5-Stage Validation Model

**Central principle: a new client's config should never be able to reach a
live price change unless it passes stages 1-3, AND a price that already went
live should never be able to silently stay wrong unless it survives stages
4-5 too.** Each stage catches a different failure mode, at a different point
in the pipeline, at a different cost:

| Stage | When | Catches | Cost |
|---|---|---|---|
| 1 — config-load-time | Module import, before any price is computed | Static self-contradictions between policy JSON files | Free, no I/O, fails in milliseconds |
| 2 — pre-write/dry-run | Every sync run, before any Shoptet API write | Dynamic/data-driven anomalies (bad feed, mapping regression, renamed pricelist) | One feed fetch + optional one API call |
| 3 — regression tests | Every push/PR, in CI | Logic regressions from human code changes | ~7s local, full CI run remotely |
| 4 — run-level fail-closed | Every sync run, after fetch/compute, before declaring success | Incomplete/invalid data for a *specific* product within an otherwise-successful run | Zero extra I/O — reclassifies data already fetched |
| 5 — reconciliation | Scheduled, independent of any sync run | Silent logic bugs that make every individual run report `SUCCESS` while the *aggregate outcome* drifts wrong over time | One full-catalog read pass (all pricelists), no writes |

No single stage is sufficient alone: Stage 1 can't see a corrupted feed
(it only checks static files); Stage 2 can't see a logic bug in code that
produces plausible-looking wrong numbers within the change-ratio threshold;
Stage 3 can't see a config file that is internally fine but contradicts
another config file, or a feed that's broken *today* but wasn't when the
test fixtures were written; Stage 4 can't see a bug that makes a run
under-process silently *without ever reaching an invalid-data branch* (e.g.
`getProductDetail()` returning `undefined` for a reason the code doesn't
distinguish from "nothing to do"); Stage 5 is the only one that doesn't
trust any run's own self-report at all — it re-derives the expected answer
independently and compares against reality. All five together are what
makes it safe to both (a) hand this engine to a new client's config without
re-auditing every policy JSON by hand, and (b) trust that a catalog left
running unattended for weeks hasn't quietly drifted wrong.

### 3.1 Stage 1 — Config-load-time validation (`config.ts`)

Implemented in `cloudflare-worker/src/engine/config.ts:67-107`, function
`assertNoCrossFileConflicts()` (defined at line 84, called at line 103).

What it actually does: takes a `Record<string, string[]>` mapping each
source-file name to its list of product codes, and does a pairwise
comparison across every pair of sources — `O(n²)` over the *files*, not the
products, so with three files today it's three set-intersection checks. For
each pair, it builds a `Set` from the second list and filters the first
list for membership, i.e. `codesA.filter(code => setB.has(code))`. If any
pair has a non-empty intersection, it throws immediately with the specific
conflicting code(s) and the two file names named in the error message. This
throw happens at **module load time** — before `PRODUCT_LIMITS` is even
constructed (line 109) — so a conflicting config doesn't just produce a
wrong price, it prevents the Worker module (and any CLI script that imports
it) from loading at all.

The three sources checked today (call site, lines 103-107):

```ts
assertNoCrossFileConflicts({
    'zero-discount-products.json': zeroDiscountProducts as string[],
    'clearance-sale-products.json': Object.keys(clearanceSaleProducts as Record<string, ClearanceEntry>),
    'product-max-discount-overrides.json': Object.keys(productMaxDiscountOverrides as Record<string, number>)
});
```

**Why this matters**: `PRODUCT_LIMITS` (line 109) is built by object spread,
last-write-wins. Before this check existed, a product code silently present
in two of these three files would resolve to whichever map happened to be
spread later — with zero warning, and a live price that quietly stopped
matching what whoever edited the JSON intended. This is the exact failure
class behind the historical clearance-vs-cap production bug (documented in
`ENGINE_TECHNICAL_TEMPLATE.md` §2 and §7). Stage 1 doesn't try to guess which
source "should" win; it refuses to build at all and forces the person who
introduced the conflict to resolve it explicitly.

**Known scope limit**: Stage 1 only checks the three files wired into the
call at lines 103-107. Adding a fourth policy file that can also assign a
per-product discount cap does *not* get checked automatically — see the
worked example in §5.

### 3.2 Stage 2 — Pre-write/dry-run validation (diff-aware sync)

Implemented in `cloudflare-worker/src/cli/sync-coupon-fields-diff.ts`. Two
independent guards, both evaluated before any live Shoptet write:

**Guard A — minimum scanned-product count** (`MIN_EXPECTED_PRODUCTS = 5000`,
line 45; check at lines 221-226). If the feed parse yields fewer than this
many valid rows, the script throws immediately: `"Prohledáno jen X produktů
... feed je pravděpodobně useknutý nebo rozbitý. Žádný zápis neproběhl,
coupon-state.json nebyl změněn."` **This aborts the entire run** — no writes
happen at all, and the state file is untouched, so the next run retries from
the same baseline.

**Guard B — the 30% change-ratio safety fuse** (`MAX_CHANGE_RATIO = 0.30`,
line 50; check at lines 240-248). After scanning the full feed and diffing
every product×pricelist item against the last-known-written state
(`coupon-state.json`), the script computes `changeRatio = changedCount /
(scanned * numPricelists)`. If running live (`isLive`), that ratio exceeds
30%, and `--force` was not passed, it throws: `"Změna se týká X % všech
položek ... což překračuje pojistku 30 %. ... Žádný zápis neproběhl."`

**Exact behavior when it trips — this is the fact to get right**: **it
aborts the entire run, not a per-item skip.** The threshold is evaluated
once, globally, after the full feed has already been scanned and the full
diff computed — it is not applied per-product or per-tier. If it trips, zero
Shoptet API writes happen for that run (the throw happens *before* the
`CouponSalesWriter` loop at line 261 is ever reached), and `coupon-state.json`
is left completely unchanged (line 278's `if (!failedAny)` block never
executes because `main()` has already thrown and been caught by the
top-level `.catch()` at line 289, which logs the error and calls
`process.exit(1)`). The only way past it is an explicit human re-run with
`--force`. There is no partial-apply or "write the safe 70%, skip the rest"
behavior — it is a full-run circuit breaker, deliberately, because a
change ratio that large is treated as evidence the *entire* diff might be
computed from bad data, not evidence that some specific items are fine and
others aren't.

A third check exists but is not itself a threshold: `validatePricelistMap()`
(lines 103-132), called only once the script knows there's something to
write (line 259, right before the first live write), confirms every ID in
`TIER_PRICELIST_MAP` still resolves to the pricelist name it's expected to
via a live `GET /api/pricelists` call — protects against a renamed/recreated
pricelist in Shoptet admin. Also aborts the whole run on mismatch, before any
write.

`scripts/run-real-sync.ts` (root engine, real-price writer) follows the same
pattern architecturally — diff against previous state, guard on implausible
scope before writing — as part of the same Stage 2 philosophy, though the
coupon-fields script above is the one with the concrete, currently-tuned
thresholds documented here.

### 3.3 Stage 3 — Regression-test validation (CI)

`.github/workflows/ci.yml` runs on every `push` to `main` and every `pull_request`
into `main`: `npm ci` → `npm run build` → `npm test` → `npx eslint src tests`
→ mock-data + benchmark E2E steps. `npm test` runs the Vitest suite —
**236 tests across 17 files** (confirmed via `npx vitest --run`), the
authoritative regression gate for the decision logic in §1. What it locks in:

- **Coupon rule precedence** — `tests/coupon-policy.test.ts` (23 cases) and
  `cloudflare-worker/tests/compute-coupon-writes.test.ts` (21+ cases): exact
  Rule 1-5 ordering from §1.2, locked-tier absolute precedence, disabled
  brand/product short-circuiting.
- **Brand/category/product fallback** — verifies `resolveActiveLimit()` and
  `resolveEffectiveLimit()` both apply Product → Brand → Category in that
  order and agree with each other (the cross-layer invariant from §1.2).
- **Cross-engine pricing parity** — `tests/pricing-parity.test.ts`, 121
  profile combinations comparing root vs. Worker engine output byte-for-byte,
  including the clearance-vs-cap regression profile.
- **The three-way tier+coupon+clearance interaction**
  (`cloudflare-worker/tests/compute-coupon-writes.test.ts:234-281`, `describe('three-way
  interaction: active clearance sale + loyalty tier + coupon')`) — four cases:
  a clearance deeper than the ceiling blocking the coupon outright (Rule 3
  fires before tier is considered); a shallow clearance leaving room based on
  `max(clearance, tier)`; locked tiers staying locked even during an active
  clearance sale; and a per-product cap clamping both clearance and tier
  *before* the coupon layer sees either value. This closes the gap the
  technical template previously flagged as untested (§7/§8 there).
- **The margin-safety test** — `compute-coupon-writes.test.ts:283-293`,
  `'never grants coupon room beyond what the ceiling allows (shop margin
  safety)'`: for every tier's computed write item, asserts
  `1 − minPriceRatio ≤ productMaxDiscount + 1e-9`. This is the test that
  would fail if `resolveEffectiveLimit()` ever drifted out of sync with the
  price engine's cap lookup — the single invariant most directly protecting
  the client's margin from a coupon stacking beyond an intended cap.

### 3.4 Stage 4 — Run-level fail-closed validation (INC-010, 2026-08-13)

Implemented across three files, all added/fixed the same day, closing a
chain of three silent-success bugs found investigating why 2 products
(99459, 103525) never got a computed wholesale price despite `sync.yml`
reporting green every time:

**`products-reader.ts`** — a product whose `perPricelistPrices` entry is
missing for the base pricelist (common right after creation — Shoptet
propagation lag) is excluded from the run's results and recorded in
`incompleteCodes`, instead of the old behavior of fabricating `basePrice=0`
and letting it flow through as a "valid" (but wrong) price. Same treatment
applied when `getProductDetail()` itself returns `null`/`undefined` — this
used to be a bare `if (!detail) continue` with zero record kept anywhere.

**`pricing-bridge.ts`** — every `validateInput`/`validateResult` failure,
engine `rejected` result, or thrown exception is now logged
(`console.warn` naming the SKU + tier + reason) and collected into a
`failures` array returned to the caller, instead of a bare
`catch (e) { /* Ignore calculation errors for specific products */ }` that
discarded the failure with no trace at all.

**`sync-orchestrator.ts`** — `isSuccess` now factors in both
`incompleteCodes.length` and `pricingFailures.length`, not just
write-failure counts. On any non-success: `lastSync` is deliberately **not**
advanced (so the affected product re-enters the next incremental window
instead of aging out of it), and the function `throw`s at the end — which
propagates through `run-real-sync.ts`'s `catch` block to a non-zero exit
code, which fails the GitHub Actions job, which fires the issue-notification
step that already existed in `sync.yml` (from INC-006) but had never
actually triggered for this failure class because nothing before today ever
threw for it.

**What Stage 4 does *not* catch** (the gap Stage 5 exists to close): a bug
in the code path itself that makes it silently process *zero* products
without ever reaching an invalid-data branch. `getProductDetail()` reading
`json.data.product` instead of `json.data` returned `undefined` for every
call, unconditionally — but the *caller* only routes that into
`incompleteCodes` when it has a specific change to attribute the failure
to. When `changes.length === 0` for a given run (most runs, most of the
time), there was nothing to attribute anything to, so nothing looked wrong
— the run just did less work than it should have, forever, with a clean
`SUCCESS`. Stage 4 hardens what a run does with problems it encounters;
it cannot invent problems a code-path bug prevented it from encountering
in the first place.

### 3.5 Stage 5 — Reconciliation (implemented 2026-08-13)

**Status: built.** `cloudflare-worker/src/cli/reconcile-pricelist-drift.ts`
+ `.github/workflows/reconcile-pricelist-drift.yml`. See
`docs/PROGRESS_LOG.md`'s 2026-08-13 "Stage 5 postaveno" entry for the build
log; not yet run against production even once as of that entry — a manual
`workflow_dispatch` verification run is the recommended next step before
trusting the first scheduled run.

**The question Stage 5 answers, that Stages 1-4 structurally cannot:**
"has every run's `SUCCESS` actually corresponded to correct output, over
weeks of unattended operation?" A read-only audit script
(`audit-catalog-drift-all.ts`, currently a scratchpad prototype, not yet in
`cloudflare-worker/src/cli/`) answered this for the live catalog on
2026-08-13: for each of the 10 tier pricelists, it recomputes the expected
price via the *same production function* (`calculateProductsPricing`) from
the live base pricelist, and diffs it against what Shoptet actually has
written. Result: 812 of 16,705 products (~4.9%) had a wrong or entirely
missing tier price, accumulated silently over the 12 days `getProductDetail()`
was broken, with every individual sync run reporting `SUCCESS` throughout.

**Why this must be independent of the sync run's own reporting**: Stage 4
can only be as good as the code doing the reporting. A bug in the reporting
code itself (which is exactly what INC-010 was) makes Stage 4 blind to its
own blind spot. Stage 5 doesn't ask the sync run "did you succeed" — it
independently re-derives the answer from first principles (live base price
+ policy config) and compares against observed reality, so it catches bugs
Stage 4 has no way to catch by construction, not just bugs Stage 4 happened
to miss by omission.

**Shape as built:** daily scheduled GitHub Actions workflow (`0 3 * * *`,
off-peak from the 15-minute `sync.yml` cron) + `workflow_dispatch`. On
finding an alert (or failing its own self-check, see below), it `throw`s —
routing into the same fail-closed → GitHub-issue mechanism Stage 4 uses
(upload log artifact, create/update a `price-integrity`-labeled issue), so
a Stage 5 finding is exactly as loud as a Stage 4 one.

**Debounce** (the open design question, now resolved): a product entirely
missing from a tier pricelist alerts immediately — there is no legitimate
reason a product with a computed expected price has zero entry in a live
tier pricelist. A *value* mismatch only alerts once it has persisted across
two separate runs, tracked via `.reconciliation_state.json` (committed to
the repo, same pattern as `.sync_state.json`) keyed by `${code}::${tier}`
with a `firstSeen` date — a price that changed 10 minutes ago and hasn't
been picked up by the 15-minute sync cron yet is not a bug, and alerting on
it immediately would just train people to ignore the alert.

**Alert format** (specified verbatim by the client, preserved exactly):

```
Tahle cena měla být X. Shoptet má Y. Rozdíl = Z. Produkt {code}
(tier {tier}) nebyl synchronizován. -> ALERT.
```

**Self-check (meta-validation) — Stage 5 validating itself.** Before
evaluating alerts, the script asserts its own run was meaningful: base
pricelist returned ≥5,000 products (mirrors Stage 2 Guard A's
`MIN_EXPECTED_PRODUCTS` pattern), at least `5,000 × (tier count − 1)`
product×tier combinations were actually checked, at least 5 tier
pricelists were found, and pricing-bridge calculation failures didn't
exceed 50% of products. **Why this exists**: "zero alerts" is
indistinguishable from "reconciliation silently broke and checked almost
nothing" — the *exact* shape of INC-010 itself (a run reporting `SUCCESS`
because it never reached a branch that would say otherwise). Without this,
Stage 5 could have the same blind spot it exists to catch. A self-check
failure is reported as a distinct error (`RECONCILIATION SELF-CHECK
SELHAL`) from a normal drift alert, and fails the run either way — the
model does not recurse into "validate the validator's validator"; one
absolute-threshold self-check is the deliberately-terminal answer to "how
many meta-levels are enough."

### 3.6 Stage 4/5 extended to the coupon pipeline (INC-011, 2026-08-13)

The same two stages were built for the coupon pipeline (`discountCoupon` /
`minPriceRatio` fields) the same day, in direct response to INC-011: a live
spot-check found 61 product codes (122 pricelist entries — ZR20 and ZR25
both) with `discountCoupon=TRUE` despite Rule 4's absolute-precedence lock,
and confirmed *no* verification had ever been done for ZR6–ZR18 or the
GUEST/"Hlavný cenník" pricelist. Same root-cause family as INC-010:
`sync-coupon-fields-single-product.ts` only runs on a Shoptet
`product:create`/`product:update` webhook that doesn't reliably fire, and
every scheduled/plošný fallback (`coupon-fields.yml` and siblings) was
archived to `.github/workflows-archive/` on 2026-08-12 with nothing put in
its place.

**Stage 4** (`sync-coupon-fields-single-product.ts`): the same silent-success
shape as INC-010's `sync-orchestrator.ts` before its fix — `CouponSalesWriter
.processTierBatch()`'s `stats.failed` was logged but never propagated, so a
partial write failure (e.g. one Shoptet 5xx on one batch) exited 0. Fixed:
the script now `throw`s if `stats.failed > 0` on any pricelist after the
write loop.

**Stage 5** (`cloudflare-worker/src/cli/reconcile-coupon-drift.ts` +
`.github/workflows/reconcile-coupon-drift.yml`, daily `30 3 * * *`,
staggered 30 minutes after the pricing reconciliation): read-only, mirrors
`reconcile-pricelist-drift.ts`'s structure exactly, but the source of truth
is `computeCouponWrites()` (`cloudflare-worker/src/coupon/compute-coupon-
writes.ts`) instead of `calculateProductsPricing()`, and it checks all 11
pricelists computeCouponWrites() produces items for — the 10 ZR tiers *plus*
GUEST (`ALL_PRICELISTS_MAP`), which is how this model answers §1.2's earlier
open question of "does the coupon rule apply the same way on the guest/
default pricelist" — GUEST is simply one more entry in the same map, no
special-cased logic. `productMaxDiscount` is deliberately left `undefined`
when re-deriving expected values, mirroring the fixed, safe convention in
`sync-coupon-fields-live.ts`/`sync-coupon-fields-single-product.ts` — reading
it from the pricelist's own `sales.minPriceRatio` (or the feed's `maxDiscount`
column) would be exactly the circular-dependency bug `coupon-sales-writer.ts`
documents as fixed 2026-08-06 (the coupon output would become its own input).

The ZR20/ZR25 lock check is a **separate, immediate-alert category**, ahead
of the generic per-item diff — an explicit design choice, not an
implementation detail: Rule 4 has no legitimate exception, so any
`discountCoupon=true` observed on a locked tier is reported on its own
(`ALERT -- ZR20/ZR25 lock porušen`), distinct from ordinary value mismatches,
and it does **not** go through the two-run debounce a value mismatch does —
same reasoning as a pricelist entry missing entirely in §3.5's model (no
legitimate transient cause exists for either). A `minPriceRatio` mismatch is
only compared/alerted when the coupon is actually enabled on at least one
side (`expected.applyDiscountCoupon || actual.discountCoupon`) — comparing it
when both sides agree the coupon is off produced a large false-positive
count in this script's first live run (many products carry a stale/never-
explicitly-set `minPriceRatio=0.000` instead of the engine's `1.0000` when
`discountCoupon=false`, which is checkout-invisible either way).

**First live read-only run** (before any write) found: 122 confirmed
ZR20/ZR25 lock violations, 0 entirely-missing records, and 13,460 first-seen
value mismatches spread across every tier (ZR4–ZR18 + GUEST) — the first real
verification those tiers had ever had. **A full-catalog live write** was then
run via the existing `sync-coupon-fields-live.ts` (unchanged — it already
used the safe `productMaxDiscount=undefined` convention, so its output
matches exactly what the reconciliation script calls "expected"): all 11
pricelists, 16,706 products each, 0 failures, with a pre-write rollback
snapshot per pricelist (`CouponSalesWriter`'s existing snapshot behavior). A
second independent read-only reconciliation run afterward confirmed **0
alerts of any kind across all 183,766 product×pricelist combinations**,
self-check passing. Full detail, per-tier write counts, and the open
follow-up item (see below) are in `INCIDENTS.md`'s INC-011, seventh and
eighth findings.

**Known open inconsistency (not yet fixed, low current risk):**
`sync-coupon-fields-diff.ts` — a different, diff-aware write script not
currently triggered by any active cron (its siblings were archived
2026-08-12) — still reads the feed's `maxDiscount` column as
`productMaxDiscount` (lines 185–186), unlike `sync-coupon-fields-live.ts`,
`sync-coupon-fields-single-product.ts`, and `reconcile-coupon-drift.ts`,
which all agree on leaving it `undefined`. This is dormant today (nothing
runs that script), but re-enabling or manually invoking it with `--live`
before fixing that line could reintroduce exactly the kind of drift this
section just closed. Fix it to match the other three call sites before any
future use.

## 4. Scaling This

**More products.** The engine is O(products) per sync run with no per-product
external calls beyond the batched Shoptet writes — the feed is streamed
(`CsvParserStream`), not loaded fully into memory. The main scaling lever is
`MIN_EXPECTED_PRODUCTS` (Stage 2 guard A) and `MAX_CHANGE_RATIO`'s
denominator, both of which must be re-tuned per catalog size (§2 step 7) —
an unmodified `MIN_EXPECTED_PRODUCTS = 5000` on a 2,000-product client either
never lets a legitimate small catalog sync, or (worse) is silently too low to
catch a real truncation. Stage 1's `assertNoCrossFileConflicts()` is O(n²)
over the *number of policy files*, not products, so it doesn't degrade with
catalog growth — the per-file product-code lists themselves are compared via
`Set` lookups, O(products) per pair.

**More clients.** Each client is a fully separate deploy: own Worker, own KV
namespace, own GitHub Actions secrets/workflows, own copy of the policy JSON
files (this repo's structure assumes one client per repo instance, per
`ENGINE_TECHNICAL_TEMPLATE.md` §1). Stage 1 and Stage 3 both run per-deploy
already — nothing changes there. Stage 2's thresholds are the one place that
must be explicitly reset per client (§2 step 7); there is currently no
mechanism to derive them automatically from catalog size, so this is a
manual onboarding step that should be checklisted, not assumed.

**More concurrent sync runs.** The existing conflict-handling strategy
(`ENGINE_TECHNICAL_TEMPLATE.md` §5 — `git merge -X ours` with a
`--ours`-forced fallback for `sync.yml`, `git pull --rebase --autostash` for
`coupon-fields.yml`) already assumes overlapping runs are normal, not
exceptional, and is designed to degrade safely (a "lost" state-file merge
only widens the next incremental window). Scaling to more overlapping runs
(e.g. a client with a higher webhook volume) doesn't require new
architecture, but does raise the odds of Stage 2's Guard B tripping more
often on legitimate rapid-fire changes — if a client's real business pattern
regularly produces >30% simultaneous changes (e.g. a storewide flash sale
toggling on/off), `MAX_CHANGE_RATIO` itself, not just `--force`, may need
revisiting for that client, since routinely forcing past a safety fuse
defeats its purpose.

## 5. Worked Example: Adding a "Flash Sale" Policy File

Suppose a new client needs a `flash-sale-products.json` file — like
`clearance-sale-products.json`, but for short, non-clearance promotional
windows that can independently overlap with an existing clearance sale or
override. Where does validation for this new file go, at each stage?

**Stage 1 (config.ts, static conflict check).** Add the new file's product
codes as a fourth source to the `assertNoCrossFileConflicts()` call
(`config.ts:103-107`):

```ts
assertNoCrossFileConflicts({
    'zero-discount-products.json': zeroDiscountProducts as string[],
    'clearance-sale-products.json': Object.keys(clearanceSaleProducts as Record<string, ClearanceEntry>),
    'product-max-discount-overrides.json': Object.keys(productMaxDiscountOverrides as Record<string, number>),
    'flash-sale-products.json': Object.keys(flashSaleProducts as Record<string, FlashSaleEntry>)
});
```

This alone extends the existing `O(n²)` pairwise check to cover the new
file automatically — no new logic needed, just adding it to the input map.
If a product ends up in both `clearance-sale-products.json` and
`flash-sale-products.json`, the module fails to load with a specific error
naming both files and the code, exactly like the existing three-file case.

**Stage 2 (sync script, dynamic/data-driven check).** If flash sales are
meant to be short-lived and toggle frequently, that's exactly the kind of
legitimate-but-large change Guard B (§3.2) is tuned to distinguish from a
feed bug. Two choices: (a) leave `MAX_CHANGE_RATIO` as-is and require
`--force` for the (presumably rare, deliberate) moment a flash sale goes
live across a large slice of the catalog, treating it the same as any other
large deliberate change; or (b) if flash sales are expected to be routine
and large, add a dedicated ratio guard scoped to just the flash-sale subset
(new local check inside `sync-coupon-fields-diff.ts`, alongside Guard A/B,
before the live-write block at line 250) so an anomalous flash-sale-specific
spike can be caught without raising the blanket 30% threshold for everything
else. Either way, the check belongs at write-time, in the sync script — not
in `config.ts`, because whether a given flash-sale change is "plausible" is
a function of the live feed data volume, which Stage 1 (module load, no
feed access) has no visibility into.

**Stage 3 (vitest).** Add a new `describe` block in
`compute-coupon-writes.test.ts` mirroring the existing three-way interaction
tests (§4.3): flash sale + tier + coupon combinations (shallower than
ceiling leaves room; deeper blocks outright; locked tiers stay locked during
a flash sale), plus a variant of the margin-safety test confirming coupon
room still never exceeds the effective cap when a flash-sale entry is the
binding limit. If `flash-sale-products.json` is meant to merge into
`PRODUCT_LIMITS` (`config.ts:109-115`) at a specific priority relative to
clearance and overrides, add a `pricing-parity.test.ts` profile exercising
that specific priority ordering — this is exactly the class of interaction
that went undocumented before the clearance-vs-override gap was flagged in
`ENGINE_TECHNICAL_TEMPLATE.md` §7, and a new merge source is the moment to
close it explicitly rather than repeat it.

**The general rule for extending this model**: a new *static policy file*
gets a Stage 1 entry; a new *behavior that depends on live feed data volume
or shape* gets a Stage 2 guard; a new *decision-logic rule or interaction*
gets a Stage 3 test. Most new policy files need all three — skipping any one
stage re-opens exactly the failure mode that stage exists to close.
