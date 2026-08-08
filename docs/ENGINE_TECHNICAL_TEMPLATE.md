# Shoptet Pricing Engine — Technical Template for New Client Deployments

Engineering reference describing how this pricing/coupon/loyalty engine is
built and what must be configured (or rebuilt) for a new Shoptet client. The
engine was originally implemented for **okfish.sk** (owner: Jan Lančarič,
L-Code Dynamics); okfish is used throughout as a concrete illustration, but
everything here is written as a template for deploying the same architecture
on any other Shoptet e-shop. This is an honest engineering document, not
marketing copy — known bugs, gaps, and unresolved edge cases are included
deliberately, because they matter when scoping a new client engagement.

## 1. Architecture Overview

The system has two independent runtime halves that share pricing logic via
imported JSON policy files, but do **not** share a process or deploy
pipeline. This split is structural to the design and applies to any client
deployment, not just okfish.

**A. Node/TypeScript batch jobs** (repo root `src/`, `scripts/`) — run only
inside GitHub Actions, on cron or `repository_dispatch` (webhook). They talk
directly to the Shoptet Private API to write real prices, coupon fields, and
pricelist entries. They are the only part of the system with **write** access
to Shoptet.

**B. Cloudflare Worker** (`cloudflare-worker/src/index.ts`) — a stateless
edge process backed by Workers KV. It serves read-only, low-latency HTTP
endpoints consumed by JS running on the client's storefront (product-discount
badges, feed generation, an orders dashboard), plus a webhook receiver that
forwards Shoptet events into GitHub Actions. It also hosts a **second,
independent implementation** of the tier-pricing math
(`cloudflare-worker/src/engine/`) because it cannot import the root engine
(different deploy boundary, no Node.js APIs on Workers).

Data flow, end to end (client-agnostic — the master feed URL and product
codes are the only per-client inputs):

```
Master product feed (MASTER_FEED_URL, CSV — per-client)
        │
        ▼
scripts/run-real-sync.ts  ──►  Shoptet Private API (real prices, per-tier
  (root engine, src/core/)      pricelists, product fields)
        │
        ├──► cloudflare-worker/src/cli/sync-products.ts ──► Workers KV
        │      (product-discount badge cache, offset sync)
        │
        └──► cloudflare-worker/src/cli/sync-coupon-fields-diff.ts
               (coupon-policy.json → sales.discountCoupon / minPriceRatio
                fields on every tier pricelist item)
        ▼
Cloudflare Worker (index.ts) — GET /v1/product-discount/:code/:tier,
  GET /v1/discount/:hash, POST /v1/webhook/shoptet, orders dashboard
        ▼
Frontend JS on the client's storefront (FTP-deployed, outside CI):
  cart/catalog/detail price-badge scripts, coupon-lock UI
        ▼
Shopper's browser (badges, cart totals, coupon-lock UI)
```

Two engines exist because the Worker cannot import root's `PricingEngine`
(Decimal.js + Node fs/streams, no Worker-compatible build). Instead
`cloudflare-worker/src/engine/config.ts` imports the **same JSON policy
files** (`src/config/policies/policy-v1.json`, `product-max-discount-overrides.json`,
`zero-discount-products.json`, `clearance-sale-products.json`) directly from
the root repo path, so both engines are configured from one source of truth
even though the arithmetic is implemented twice. `tests/pricing-parity.test.ts`
exists specifically to catch the two implementations drifting apart (121
combinations, both engines compared for byte-identical output). **This
parity test is what makes the dual-engine architecture safe to reuse for a
new client** — any new policy JSON, tier count, or discount rule must be
re-verified against it, not assumed correct because it "looks like" the
okfish config.

A third, separate 1:1 port (`desktop-app/lib/pricingEngine.js`) exists inside
the Electron admin app used to preview prices before committing policy
changes — it must be kept in sync manually; there is no automated parity test
against it. For a new client this desktop app either needs re-branding/
re-pointing at the new config, or the parity gap needs to be closed first.

## 2. Pricing Engine Core

### Root engine (`src/core/PricingEngine.ts` + `src/policies/*.ts`)

Policies run in priority order — `BasePricePolicy` (10) →
`HighestDiscountPolicy` (20, picks whichever is cheaper between action price
and loyalty price) → `BrandLimitPolicy` / `CategoryLimitPolicy` (50) →
`ProductMaxDiscountPolicy` (60, product override wins over brand/category) →
`RoundingPolicy` (100). This priority chain is generic and does not need to
change per client; what changes is the **content** of the policy JSON files
(which brands/categories/products have limits, and what those limits are).

### Worker engine (`cloudflare-worker/src/engine/pricing.ts`, `config.ts`)

This is the engine actually driving live product-discount badges
(`GET /v1/product-discount/:code/:tier` in `index.ts:420`). Core function is
`calculateAllTierPrices()` (`pricing.ts:107`):

1. Parse `basePrice` from `price`/`priceVat`/`standardPrice`.
2. Parse `actionPrice`/`salePrice`; if it isn't actually below `basePrice`,
   treat it as no-op (line 125) — guards against stale/uncleared promo fields
   left in the feed (confirmed live on an okfish product, LOWRANCE 111139 —
   the class of bug is generic to any feed that can leave a promo field set
   after a sale ends).
3. Resolve the active discount cap via `resolveActiveLimit()` (line 71):
   **product override → brand limit → category limit**, read from
   `PRODUCT_LIMITS`/`BRAND_LIMITS`/`CATEGORY_LIMITS` in `config.ts`, **never**
   from the feed's own `maxDiscount` column (deliberate — see §7, circular-
   dependency note at `pricing.ts:62-70`).
4. For each of the client's loyalty tiers (`config.ts` `TIER_NAMES`, sourced
   from `policy-v1.json.loyaltyTiers`), pick the lower of loyalty price vs.
   action price, then apply the cap.

**Tier count and naming are entirely client-configurable.** okfish.sk uses
ten tiers named `ZR4`–`ZR25`, where the numeric suffix encodes the discount
percentage (`ZR4 = 4%` … `ZR25 = 25%`). A new client may define any number
of tiers with any naming scheme — the engine only requires a ratio per tier
in `policy-v1.json.loyaltyTiers` and a mapping from tier name to Shoptet
pricelist ID. The "name encodes the percentage" convention is convenient but
not required by the code; it was an okfish-specific choice for internal
clarity.

**The clearance-vs-cap precedence rule (originally INC-004,
`pricing.ts:143-164`).** If a discount cap is active AND the product has an
action/sale price, the action price wins outright — it is never
floor-clamped up to the cap, and never overridden by a deeper loyalty-tier
discount. The cap only clamps a *loyalty-only* price (no action price
present). This was a real production bug on okfish.sk: a clearance-priced
product had its markdown incorrectly raised to a fresh discount cap the
moment the cap was set. Fixed 2026-08-04, regression-tested via
`tests/pricing-parity.test.ts` (`action-price-steeper-than-cap` profile,
121/121 combinations). **This class of bug is generic — any client running
simultaneous clearance sales and category/brand discount caps needs this
fix, not just okfish.**

**`PRODUCT_LIMITS` merge order** (`config.ts:67-73`): zero-discount products
(0%) → active clearance-sale entries (`clearanceSaleProducts`, percent,
possibly date-windowed via `resolveClearancePct()`, `config.ts:55-60`) →
`productMaxDiscountOverrides` (highest priority, last spread wins). Clearance
entries are what actually makes the clearance-vs-cap fix take effect for
sale-flagged products — they populate `PRODUCT_LIMITS` so the "cap + action
price present" branch fires and locks in the intended discount instead of
letting the deepest loyalty tier win by being numerically lower.

**Documented open caveat (not fully resolved):** the fix makes action price
win when a cap AND action price coexist, but it does so by treating clearance
entries as if they were `PRODUCT_LIMITS` overrides. If a product has a real
independent `productMaxDiscountOverrides` entry that is *shallower* than its
clearance discount, the two sources are merged into a single number by object
spread — `productMaxDiscountOverrides` silently wins over the clearance
percentage because it's spread last (`config.ts:70-72`), with no code path
that reasons about "clearance price vs. override cap" as two separate
concepts once both apply to the same product. There is no test exercising
that specific overlap (see §7/§8), so its real-world behavior is unverified.
**Any new client that uses both clearance sales and per-product overrides
should be told this is an open, unresolved gap before go-live**, not
presented as fully handled.

## 3. Coupon Policy System

`src/coupon/CouponPolicy.ts` is a **standalone** decision layer, not wired
into the `PricingEngine` command pipeline — it's invoked separately by the
Worker's coupon-writing CLIs.

`CouponPolicy.decide()` (`CouponPolicy.ts:22-56`), in strict order:

1. **Rule 4 (checked first, absolute precedence)** — the customer's tier is
   in the client's configured `lockedTiers` list (from
   `coupon-policy.json.lockedTiers`; for okfish.sk this is `["ZR20","ZR25"]`,
   its two deepest tiers) → no coupon, `maxDiscount = 0`. Locked tiers
   already sit at max loyalty discount; stacking a coupon on top is
   disallowed by business policy, no exceptions. **Which tiers get locked
   (if any) is a business decision per client, not a code default.**
2. **Rule 1** — `productMaxDiscount === 0` → no coupon.
3. **Rule 2** — `productMaxDiscount` set and below the standard ceiling →
   coupon room = `productMaxDiscount − max(productDiscount, tierDiscount)`,
   if positive.
4. **Rule 3** — product's own discount already ≥ the standard ceiling → no
   coupon.
5. **Rule 5 (default)** — coupon room = `standardLimit − max(productDiscount, tierDiscount)`.

`standardLimit` (okfish default: 0.20, i.e. 20%) and `lockedTiers` are
constructor parameters, defaulted from `coupon-policy.json` — the same file
the desktop admin app edits, loaded once at module init
(`coupon-config.ts:36-41`), so a policy change (disable a brand/product,
change the ceiling, add a tier to the lock) takes effect on the **next cron
run**, no code deploy needed. **This ceiling value is the single most
important business parameter to confirm with any new client during
onboarding** — it directly caps how much stacked discount a shopper can ever
reach.

`cloudflare-worker/src/coupon/compute-coupon-writes.ts` is the caller that
turns this per-request `decide()` call into an actual write payload for all
of the client's pricelists (N loyalty tiers + 1 guest pricelist):

- `resolveEffectiveLimit()` (line 43) mirrors the pricing engine's
  Product → Brand → Category fallback exactly — deliberately, so the coupon
  layer never grants more room than the real pricing engine would ever apply.
- `computeItem()` (line 80) first checks `couponDisabled` (product code in
  `coupon-policy.json.disabledProducts`, or brand in `disabledBrands`,
  case-insensitive) — short-circuits to no-coupon before `CouponPolicy.decide()`
  even runs.
- Both `productDiscount` and the raw tier discount are clamped to
  `effectiveLimit` before being handed to `decide()` (lines 108-113) so the
  coupon math never assumes an unreachable discount depth.
- `minPriceRatio = 1 − maxDiscount` (line 122) is the literal value written
  to Shoptet's `sales.minPriceRatio` field, **per pricelist**, relative to
  that pricelist's own (already tier-discounted) price — not the combined
  tier+coupon total off the base price (documented explicitly in the
  `CouponWriteItem.minPriceRatio` comment, lines 59-68).
- Guests (mapped via `tier-pricelist-map.ts`, typically Shoptet's default
  pricelist ID 1, "Hlavný cenník" for a Czech/Slovak store) get 0% tier
  discount and are explicitly excluded from the `lockedTiers` check
  (`customerTier: undefined` passed for them, line 172) — they're capped the
  same as any ordinary tier.

`coupon-policy.json` (`src/config/policies/coupon-policy.json`) is the
per-client business-policy file. For okfish.sk it currently holds:
`defaultMaxDiscount: 20`, `lockedTiers: ["ZR20","ZR25"]`, both disabled-lists
empty. Entries support a plain string (permanently disabled) or a
`{value, validFrom?, validTo?}` object for a time-boxed disable window,
re-evaluated fresh on every cron run (`coupon-config.ts:22-34`). **A new
client deployment starts by writing this file from scratch** for their tier
count, ceiling, and any locked tiers or disabled brands/products.

## 4. Loyalty Tier System (Client-Configurable)

Tiers are defined once in `src/config/policies/policy-v1.json.loyaltyTiers`
as ratios. For okfish.sk this is ten tiers, `ZR4: 0.04` … `ZR25: 0.25`, with
the tier name literally encoding its discount percentage — a naming
convention, not a code requirement. A new client can use any tier count,
names, or ratios. `TIER_PRICELIST_MAP`
(`cloudflare-worker/src/coupon/tier-pricelist-map.ts:6-17`) maps each tier
name to its Shoptet pricelist ID (for okfish: ZR4→2, ZR6→5, … ZR25→29);
pricelist 1 is reserved for guests and is hard-blocked from tier/coupon
writes — this guest-protection guard should be re-verified against the new
client's actual pricelist layout during setup, since Shoptet's default
pricelist ID can vary by store configuration.

**How the frontend resolves a shopper's tier**: the storefront JS does
**not** read a `priceRatio` field from `dataLayer` directly on okfish.sk. It
reads `window.shoptet.customer.email`, looks it up in a global
`window.vipDiscounts` map (`email → flat discount percent`, populated
separately, presumably by another injected script/data source), and derives
the tier name as `` `ZR${discount}` `` — identical logic duplicated across
multiple frontend files. If no email or no lookup match, the shopper is
treated as a guest. **This mechanism is specific to how okfish's tier data
happens to be surfaced client-side; a new client's storefront integration
must be re-verified, since Shoptet stores can expose customer pricing tier
via different mechanisms** (e.g. a proper `dataLayer.shoptet.customer`
field), and the tier-name-derivation logic (`ZR${discount}`) is only valid
if the new client adopts the same "tier name encodes percent" convention.

The resolved tier is then used purely to pick which
`/v1/product-discount/:code/:tier` Worker endpoint to call for price
display, and — separately — to decide whether to show/hide the coupon input.

**Trust boundary (explicit, and true for any client deployment):** any
client-side "hide the coupon box for locked tiers" logic is **cosmetic
only**. It runs entirely in the browser, reads client-controlled globals,
and can be bypassed by anyone who edits the global discount map, blocks the
script, or submits the coupon form directly. The actual enforcement is
server-side: Shoptet's own checkout rejects (or caps) a coupon whose
discount would push the price below the `sales.minPriceRatio` value written
by `compute-coupon-writes.ts` for that customer's tier/pricelist. The
frontend lock exists only to avoid showing a coupon box that would then fail
or be a no-op at checkout — it is UX, not security or correctness
enforcement, and must never be treated as the real gate, for okfish or any
future client.

## 5. Sync Pipeline

Three GitHub Actions workflows, deliberately staggered so they never race
each other against the same feed snapshot. Schedule/offset values below are
okfish's current configuration — tunable per client based on catalog size
and Shoptet API rate limits:

| Workflow | Schedule | Writes |
|---|---|---|
| `sync.yml` | `*/15 * * * *` + `repository_dispatch` (webhook) | Real prices/pricelists via `scripts/run-real-sync.ts` (root engine); then `cloudflare-worker/src/cli/sync-products.ts` (badge KV cache); then, webhook-only, `sync-coupon-fields-single-product.ts` for the one changed product; then `compute-orders-stock-status.ts` for the orders dashboard |
| `sync-products-worker-cache.yml` | `5,20,35,50 * * * *` (offset +5 min) | Worker KV product-discount cache only — read-only against Shoptet, cannot affect live prices/coupons |
| `coupon-fields.yml` | `10,25,40,55 * * * *` (offset +10 min) | `sales.discountCoupon` / `sales.minPriceRatio` fields via `sync-coupon-fields-diff.ts --live` |

The offsets exist so each job reads a feed snapshot that the previous job has
already finished acting on, rather than running concurrently against a
feed/state that's mid-update.

**Concurrency/conflict handling.** `sync.yml` and `coupon-fields.yml` both
commit a small state file back to the repo (`.sync_state.json`,
`cloudflare-worker/coupon-state.json`) after each run, and both can overlap
if webhooks fire rapidly. `sync.yml` does `git fetch` + `git merge -X ours
origin/main`, and falls back to `git checkout --ours .sync_state.json` +
forced commit if even that merge fails — chosen deliberately over `git pull
--rebase` after two real production failures on okfish.sk where a rebase
interrupted mid-conflict left the repo in an unresolved index state that
broke the next commit step. `.sync_state.json` is just a timestamp
checkpoint, so "losing" a merge only widens the next incremental sync's
window — safe, idempotent. `coupon-fields.yml` still uses the simpler
`git pull --rebase --autostash` — a narrower risk surface since it runs at
its own dedicated offset, not stacked behind another writer in the same job.
**This conflict-handling strategy is a hard-won, generically applicable
lesson — any client deployment running the same overlapping-cron pattern
should keep it rather than "simplifying" back to a plain rebase.**

**30% safety fuse.** `sync-coupon-fields-diff.ts` (`MAX_CHANGE_RATIO = 0.30`)
refuses to live-write if more than 30% of all possible product×pricelist
items changed in one run — catches a feed format/mapping regression that
would otherwise silently rewrite most of the catalog's coupon fields.
Override with `--force`. A second guard, `MIN_EXPECTED_PRODUCTS`
(okfish: 5000), treats a suspiciously small scanned-product count as a
broken/truncated feed rather than a real tiny catalog. **Both thresholds are
per-client tunables** — `MIN_EXPECTED_PRODUCTS` in particular must be reset
to something sane for the new client's actual catalog size, or it will
either never trigger (too low) or false-positive on every run (too high).
These two guards are the primary safety net against a bad feed silently
mass-corrupting live prices, and should be treated as mandatory for any new
deployment, not optional hardening.

## 6. Frontend Integration on the Client's Storefront

A family of JS/CSS files runs directly on the storefront, injected via
Shoptet's theme/snippet system and **deployed by hand over FTP** — they live
in this repo's root for version control, but nothing in CI builds, lints,
tests, or deploys them. On okfish.sk this includes: a cart-page
real-discount display (sale + coupon + tier) that calls
`/v1/product-discount/:code/:tier`; catalog/detail-page price badges; a
cosmetic coupon-input lock for locked tiers (§4); and several smaller
display/UX helper scripts.

All of them derive the shopper's tier from `window.shoptet.customer.email` →
`window.vipDiscounts[email]` on okfish specifically (not a
`dataLayer.shoptet.customer.priceRatio` field as one might expect from
typical Shoptet dataLayer conventions). **For a new client, this frontend
layer needs to be re-implemented against however that store actually exposes
customer identity/tier client-side** — do not assume `window.vipDiscounts`
exists elsewhere; confirm the mechanism (or build one) during discovery.

**No automated test coverage exists for any of these files**, on okfish or
in the template generally — there is no `tests/` entry, no headless-browser
test, and no CI step that touches the root-level `.js` files at all. They
are validated only by manual QA on the live site after an FTP deploy. This
is a real, structural gap in the current approach: a regression here is
invisible to `npm test` / the GitHub Actions checks and can only be caught by
someone looking at the live storefront itself. Any new client engagement
should budget manual QA time around frontend snippet changes, or invest in
closing this gap (e.g. headless browser tests) as part of the deployment.

## 7. Known Limitations / Open Risks

These apply to the engine architecture generally, not only to okfish.sk, and
should inform how a new client engagement is scoped:

- **Clearance-vs-cap precedence bug — fixed, regression-tested** — clearance
  action prices used to be incorrectly raised to a newly-set discount cap.
  Fixed in both engines; covered by `tests/pricing-parity.test.ts`
  (`action-price-steeper-than-cap`, 121/121 combos). Confirmed fixed for
  okfish; any new client using both mechanisms inherits the fix but should
  still get this pairing tested against their real catalog data.
- **Clearance-vs-override precedence gap (unresolved)** — when a product has
  *both* an active clearance-sale entry and a distinct product-max-discount-
  override entry, `PRODUCT_LIMITS` merges them via plain object spread, so
  the override silently wins with no explicit reasoning about which one
  should apply. No test exercises this combination. Treat as unverified for
  any client, not as "handled."
- **Worker isolate cache staleness for clearance windows** — `config.ts`
  evaluates `resolveClearancePct()` once per module load (`now` captured at
  import time). CLI-driven writers (the real source of live prices) always
  see a fresh `now` because they re-import the module every run. A
  long-lived Worker isolate serving `/v1/product-discount`, however, could
  keep an old `now` across a clearance window's start/end boundary until
  Cloudflare recycles the isolate or a new deploy happens — acknowledged as
  a known, accepted limitation in the code comment, not something actively
  mitigated. This affects any client running time-windowed clearance sales.
- **Missing three-way interaction test** — no test combines loyalty tier +
  coupon + clearance sale simultaneously on the same product. Each pairwise
  interaction has some coverage, but the full three-way combination is
  untested. Genuine gap for any client using all three mechanisms together.
- **Client-side tier-source provenance is undocumented in this repo** — the
  frontend trust chain assumes the tier-lookup global is populated correctly
  and matches the server-side tier assignment; nothing in this repo verifies
  that assumption at runtime. Whatever mechanism a new client uses must be
  independently verified.
- **Desktop admin app engine port** (`desktop-app/lib/pricingEngine.js`) is a
  manual 1:1 port with no automated parity test against either the root or
  Worker engine — it can silently drift, for okfish or any future client
  reusing the desktop app.

## 8. Test Coverage Summary

232 Vitest tests across 17 files (root `tests/` + `cloudflare-worker/tests/`),
covering:

- Coupon policy precedence — `tests/coupon-policy.test.ts` (23 cases) and
  `cloudflare-worker/tests/compute-coupon-writes.test.ts` (21 cases): rule
  ordering, locked tiers, disabled brands/products, minPriceRatio math.
- Cross-engine pricing parity — `tests/pricing-parity.test.ts` (root vs.
  Worker engine, 121 profile combinations including the clearance-vs-cap
  regression case).
- Brand/category/product discount fallback hierarchy.
- Incremental sync correctness, coupon-sales-writer guest-pricelist
  protection, and products-reader field extraction.
- XML/feed safety (`xml-tag-safety.test.ts`, `xml-validation.test.ts`).

**Not covered — true for okfish today, and will remain true for a new
client unless explicitly addressed as part of the engagement:**
- All root-level frontend `.js` files (§6) — zero test coverage, FTP-deployed
  outside CI.
- The three-way tier + coupon + clearance interaction (§7).
- The clearance-vs-product-override merge precedence when both apply to the
  same product (§2, §7).
- `desktop-app/lib/pricingEngine.js` parity against the two tested engines.

## 9. Checklist: What Changes for a New Client

A practical summary of what is genuinely reusable versus what must be
re-authored per client:

**Reusable as-is (architecture/code):**
- Root TypeScript pricing engine and policy pipeline (`src/core/`,
  `src/policies/`).
- Cloudflare Worker engine and its parity-tested arithmetic.
- Coupon decision logic (`CouponPolicy.decide()`) and its rule ordering.
- Sync pipeline structure, staggered cron offsets, and conflict-handling
  strategy (§5).
- Safety fuses (30% change-ratio guard, minimum-product-count guard).

**Must be re-authored per client:**
- `policy-v1.json.loyaltyTiers` — tier names, count, and ratios.
- `coupon-policy.json` — ceiling, locked tiers, disabled brands/products.
- `product-max-discount-overrides.json`, `zero-discount-products.json`,
  `clearance-sale-products.json` — all product/brand/category-specific data.
- `TIER_PRICELIST_MAP` — tier-name-to-Shoptet-pricelist-ID mapping, matched
  against that store's actual pricelist configuration.
- `MASTER_FEED_URL` and feed-parsing assumptions if the new client's feed
  format differs.
- `MIN_EXPECTED_PRODUCTS` safety threshold, sized to the new catalog.
- The entire frontend tier-resolution mechanism (§4, §6) — cannot be assumed
  to carry over; must be verified against how the new store actually
  surfaces customer identity and pricing tier client-side.
- Desktop admin app branding/config pointers, if reused.

**Should be flagged to the client as open risk, not silently inherited as
"solved":**
- Clearance-vs-override merge ambiguity (§2, §7).
- Worker isolate cache staleness at clearance window boundaries (§7).
- Zero frontend test coverage (§6, §8).
- Missing three-way interaction test coverage (§7, §8).
