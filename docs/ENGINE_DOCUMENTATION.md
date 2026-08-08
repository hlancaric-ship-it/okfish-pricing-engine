# Shoptet Pricing Engine — Technical Reference (okfish.sk)

Internal engineering reference for the pricing/coupon/loyalty system built for
okfish.sk (owner: Jan Lančarič, L-Code Dynamics). This document describes what
the code actually does, including known bugs and gaps — it is not marketing
copy, and should be read alongside `INCIDENTS.md` before making changes.

## 1. Architecture Overview

The system has two independent runtime halves that share pricing logic via
imported JSON policy files, but do **not** share a process or deploy pipeline.

**A. Node/TypeScript batch jobs** (repo root `src/`, `scripts/`) — run only
inside GitHub Actions, on cron or `repository_dispatch` (webhook). They talk
directly to the Shoptet Private API to write real prices, coupon fields, and
pricelist entries. They are the only part of the system with **write** access
to Shoptet.

**B. Cloudflare Worker** (`cloudflare-worker/src/index.ts`) — a stateless
edge process backed by Workers KV. It serves read-only, low-latency HTTP
endpoints consumed by JS running on okfish.sk itself (product-discount badges,
feed generation, an orders dashboard), plus a webhook receiver that forwards
Shoptet events into GitHub Actions. It also hosts a **second, independent
implementation** of the tier-pricing math (`cloudflare-worker/src/engine/`)
because it cannot import the root engine (different deploy boundary, no
Node.js APIs on Workers).

Data flow, end to end:

```
Master product feed (MASTER_FEED_URL, CSV)
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
  GET /v1/discount/:hash, POST /v1/webhook/shoptet, /orders-dashboard-xk92q
        ▼
Frontend JS on okfish.sk (FTP-deployed, outside CI): vip_cart.js,
  vip_catalog.js, vip_detail.js, vip_cart_coupon_lock.js, vip_prices.js
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
combinations, both engines compared for byte-identical output).

A third, separate 1:1 port (`desktop-app/lib/pricingEngine.js`) exists inside
the Electron admin app used to preview prices before committing policy
changes — it must be kept in sync manually; there is no automated parity test
against it.

## 2. Pricing Engine Core

### Root engine (`src/core/PricingEngine.ts` + `src/policies/*.ts`)

Documented (if generically) in `docs/Pricing.md`: policies run in priority
order — `BasePricePolicy` (10) → `HighestDiscountPolicy` (20, picks whichever
is cheaper between action price and loyalty price) → `BrandLimitPolicy` /
`CategoryLimitPolicy` (50) → `ProductMaxDiscountPolicy` (60, product override
wins over brand/category) → `RoundingPolicy` (100).

### Worker engine (`cloudflare-worker/src/engine/pricing.ts`, `config.ts`)

This is the engine actually driving live product-discount badges
(`GET /v1/product-discount/:code/:tier` in `index.ts:420`). Core function is
`calculateAllTierPrices()` (`pricing.ts:107`):

1. Parse `basePrice` from `price`/`priceVat`/`standardPrice`.
2. Parse `actionPrice`/`salePrice`; if it isn't actually below `basePrice`,
   treat it as no-op (line 125) — guards against stale/uncleared promo fields
   left in the feed (confirmed live on LOWRANCE 111139).
3. Resolve the active discount cap via `resolveActiveLimit()` (line 71):
   **product override → brand limit → category limit**, read from
   `PRODUCT_LIMITS`/`BRAND_LIMITS`/`CATEGORY_LIMITS` in `config.ts`, **never**
   from the feed's own `maxDiscount` column (deliberate — see §7, INC/GUEST
   circular-dependency note at `pricing.ts:62-70`).
4. For each of the 10 loyalty tiers (`config.ts` `TIER_NAMES`, sourced from
   `policy-v1.json.loyaltyTiers`), pick the lower of loyalty price vs. action
   price, then apply the cap.

**The clearance-vs-cap precedence rule (INC-004, `pricing.ts:143-164`).** If a
discount cap is active AND the product has an action/sale price, the action
price wins outright — it is never floor-clamped up to the cap, and never
overridden by a deeper loyalty-tier discount. The cap only clamps a
*loyalty-only* price (no action price present). This was a real production
bug: before the fix, VAGNER Magic In-Line 21 had its 18%-off clearance price
incorrectly raised to a fresh 10% cap the moment the cap was set. Fixed
2026-08-04, regression-tested via `tests/pricing-parity.test.ts`
(`action-price-steeper-than-cap` profile, 121/121 combinations).

**`PRODUCT_LIMITS` merge order** (`config.ts:67-73`): zero-discount products
(0%) → active clearance-sale entries (`clearanceSaleProducts`, percent,
possibly date-windowed via `resolveClearancePct()`, `config.ts:55-60`) →
`productMaxDiscountOverrides` (highest priority, last spread wins). Clearance
entries are what actually makes the INC-004 fix take effect for výpredaj
codes — they populate `PRODUCT_LIMITS` so the "cap + action price present"
branch fires and locks in the intended discount instead of letting the raw
25% ZR25 tier win by being numerically lower.

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

## 3. Coupon Policy System

`src/coupon/CouponPolicy.ts` is a **standalone** decision layer, not wired
into the `PricingEngine` command pipeline — it's invoked separately by the
Worker's coupon-writing CLIs.

`CouponPolicy.decide()` (`CouponPolicy.ts:22-56`), in strict order:

1. **Rule 4 (checked first, absolute precedence)** — `customerTier` is
   `ZR20` or `ZR25` (`lockedTiers`, from `coupon-policy.json.lockedTiers`) →
   no coupon, `maxDiscount = 0`. Locked tiers already sit at max loyalty
   discount; stacking a coupon is disallowed by business policy, no
   exceptions.
2. **Rule 1** — `productMaxDiscount === 0` → no coupon.
3. **Rule 2** — `productMaxDiscount` set and below the standard 20% ceiling →
   coupon room = `productMaxDiscount − max(productDiscount, tierDiscount)`,
   if positive.
4. **Rule 3** — product's own discount already ≥ 20% ceiling → no coupon.
5. **Rule 5 (default)** — coupon room = `standardLimit − max(productDiscount, tierDiscount)`.

`standardLimit` (default 0.20) and `lockedTiers` are constructor parameters,
defaulted from `coupon-policy.json` — same file the desktop admin app edits,
loaded once at module init (`coupon-config.ts:36-41`), so a policy change
(disable a brand/product, change the 20% ceiling, add a tier to the lock)
takes effect on the **next cron run**, no code deploy needed.

`cloudflare-worker/src/coupon/compute-coupon-writes.ts` is the caller that
turns this per-request `decide()` call into an actual write payload for all
11 pricelists (10 ZR tiers + guest):

- `resolveEffectiveLimit()` (line 43) mirrors `DiscountLimitPolicy`'s
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
- Guests (`GUEST`, `tier-pricelist-map.ts:29`, pricelist ID 1 / "Hlavný
  cenník") get 0% tier discount and are explicitly excluded from the
  `lockedTiers` check (`customerTier: undefined` passed for them, line 172) —
  they're capped the same as any ordinary tier.

`coupon-policy.json` (`src/config/policies/coupon-policy.json`) currently:
`defaultMaxDiscount: 20`, `lockedTiers: ["ZR20","ZR25"]`, both disabled-lists
empty. Entries support a plain string (permanently disabled) or a
`{value, validFrom?, validTo?}` object for a time-boxed disable window,
re-evaluated fresh on every cron run (`coupon-config.ts:22-34`).

## 4. Loyalty Tier System (ZR4–ZR25)

Ten tiers, defined once in `src/config/policies/policy-v1.json.loyaltyTiers`
as ratios (`ZR4: 0.04` … `ZR25: 0.25`) — tier name literally encodes its
discount percentage. `TIER_PRICELIST_MAP`
(`cloudflare-worker/src/coupon/tier-pricelist-map.ts:6-17`) maps each tier
name to its Shoptet pricelist ID (ZR4→2, ZR6→5, … ZR25→29); pricelist 1 is
reserved for guests and is hard-blocked from tier/coupon writes since INC-003.

**How the frontend resolves a shopper's tier**: the `vip_*.js` family does
**not** read a `priceRatio` field from `dataLayer` directly. It reads
`window.shoptet.customer.email`, looks it up in a global `window.vipDiscounts`
map (`email → flat discount percent`, populated separately, presumably by
another injected script/data source), and derives the tier name as
`` `ZR${discount}` `` (`vip_cart.js:22-30`, `vip_cart_coupon_lock.js:12-17`
— identical logic duplicated in both files). If no email or no lookup match,
the shopper is treated as a guest.

The resolved tier is then used purely to pick which `/v1/product-discount/:code/:tier`
Worker endpoint to call for price display, and — separately — to decide
whether to show/hide the coupon input.

**Trust boundary (explicit):** `vip_cart_coupon_lock.js` disabling the coupon
input for ZR20/ZR25 shoppers is **cosmetic only**. It runs entirely in the
browser, reads client-controlled globals, and can be bypassed by anyone who
edits `window.vipDiscounts`, blocks the script, or submits the coupon form
directly. The actual enforcement is server-side: Shoptet's own checkout
rejects (or caps) a coupon whose discount would push the price below the
`sales.minPriceRatio` value written by `compute-coupon-writes.ts` for that
customer's tier/pricelist. The JS lock exists only to avoid showing a coupon
box that would then fail or be no-ops at checkout — it is UX, not security or
correctness enforcement, and must never be treated as the real gate.

## 5. Sync Pipeline

Three GitHub Actions workflows, deliberately staggered so they never race
each other against the same feed snapshot:

| Workflow | Schedule | Writes |
|---|---|---|
| `sync.yml` | `*/15 * * * *` + `repository_dispatch` (webhook) | Real prices/pricelists via `scripts/run-real-sync.ts` (root engine); then `cloudflare-worker/src/cli/sync-products.ts` (badge KV cache); then, webhook-only, `sync-coupon-fields-single-product.ts` for the one changed product; then `compute-orders-stock-status.ts` for the orders dashboard |
| `sync-products-worker-cache.yml` | `5,20,35,50 * * * *` (offset +5 min) | Worker KV product-discount cache only — read-only against Shoptet, cannot affect live prices/coupons |
| `coupon-fields.yml` | `10,25,40,55 * * * *` (offset +10 min) | `sales.discountCoupon` / `sales.minPriceRatio` fields via `sync-coupon-fields-diff.ts --live` |

The offsets exist so each job reads a feed snapshot that the previous job has
already finished acting on, rather than running concurrently against a
feed/state that's mid-update (`sync-products-worker-cache.yml:5-9`,
`coupon-fields.yml:5-9`).

**Concurrency/conflict handling.** `sync.yml` and `coupon-fields.yml` both
commit a small state file back to the repo (`.sync_state.json`,
`cloudflare-worker/coupon-state.json`) after each run, and both can overlap
if webhooks fire rapidly. `sync.yml` (`sync.yml:74-97`) does `git fetch` +
`git merge -X ours origin/main`, and falls back to
`git checkout --ours .sync_state.json` + forced commit if even that merge
fails — chosen deliberately over `git pull --rebase` after two real
production failures on 2026-08-06 where a rebase interrupted mid-conflict
left the repo in an unresolved index state that broke the next commit step.
`.sync_state.json` is just a timestamp checkpoint, so "losing" a merge only
widens the next incremental sync's window — safe, idempotent.
`coupon-fields.yml` still uses the simpler `git pull --rebase --autostash`
(line 67) — a narrower risk surface since it runs at its own dedicated
offset, not stacked behind another writer in the same job.

**30% safety fuse.** `sync-coupon-fields-diff.ts` (`MAX_CHANGE_RATIO = 0.30`,
line 50) refuses to live-write if more than 30% of all possible
product×pricelist items changed in one run — catches a feed format/mapping
regression that would otherwise silently rewrite most of the catalog's coupon
fields. Override with `--force`. A second guard, `MIN_EXPECTED_PRODUCTS = 5000`,
treats a suspiciously small scanned-product count as a broken/truncated feed
rather than a real tiny catalog.

## 6. Frontend Integration on okfish.sk

The following JS/CSS files run directly on okfish.sk, injected via Shoptet's
theme/snippet system and **deployed by hand over FTP** — they live in this
repo's root for version control, but nothing in CI builds, lints, tests, or
deploys them:

- `vip_cart.js` — cart-page real-discount display (sale + coupon + tier),
  calls `/v1/product-discount/:code/:tier`.
- `vip_catalog.js`, `vip_detail.js` — catalog/detail-page price badges.
- `vip_cart_coupon_lock.js` — cosmetic coupon-input lock for ZR20/ZR25 (§4).
- `vip_cart_coupon_percent.js`, `vip_prices.js`, `vip_registration_hide_types.js` —
  related display/UX helpers.

All of them derive the shopper's tier from `window.shoptet.customer.email` →
`window.vipDiscounts[email]` (not a `dataLayer.shoptet.customer.priceRatio`
field as one might expect from typical Shoptet dataLayer conventions — worth
confirming with whatever script populates `window.vipDiscounts` if this ever
needs debugging).

**No automated test coverage exists for any of these files** — confirmed by
an earlier internal audit and true as of this writing: there is no
`tests/` entry, no headless-browser test, and no CI step that touches the
root-level `.js` files at all. They are validated only by manual QA on the
live site after an FTP deploy. This is a real gap: a regression here is
invisible to `npm test` / the GitHub Actions checks and can only be caught by
someone looking at okfish.sk itself.

## 7. Known Limitations / Open Risks

- **INC-004 (fixed, regression-tested)** — clearance/action price used to be
  incorrectly raised to a newly-set discount cap. Fixed in both engines
  2026-08-04; covered by `tests/pricing-parity.test.ts`
  (`action-price-steeper-than-cap`, 121/121 combos).
- **Clearance-vs-override precedence gap (unresolved)** — when a product has
  *both* an active `clearance-sale-products.json` entry and a distinct
  `product-max-discount-overrides.json` entry, `PRODUCT_LIMITS`
  (`config.ts:67-73`) merges them via plain object spread, so the override
  silently wins with no explicit reasoning about which one should apply. No
  test exercises this combination. Treat as unverified, not as "handled by
  INC-004."
- **Worker isolate cache staleness for clearance windows** — `config.ts`
  evaluates `resolveClearancePct()` once per module load (line 62, `now`
  captured at import time). CLI-driven writers (the real source of live
  prices) always see a fresh `now` because `npx tsx` re-imports the module
  every run. A long-lived Worker isolate serving `/v1/product-discount`,
  however, could keep an old `now` across a clearance window's start/end
  boundary until Cloudflare recycles the isolate or a new deploy happens —
  acknowledged as a known, accepted limitation in the code comment
  (`config.ts:45-52`), not something actively mitigated.
- **Missing three-way interaction test** — no test combines loyalty tier +
  coupon + clearance sale simultaneously on the same product. Each pairwise
  interaction (tier vs. cap, tier vs. coupon, cap vs. clearance) has some
  coverage, but the full three-way combination — e.g. a ZR20 customer, an
  active coupon-eligible product, sitting inside a clearance window — is
  untested. This is a genuine gap, not a resolved edge case.
- **`window.vipDiscounts` provenance is undocumented in this repo** — the
  frontend trust chain assumes this global is populated correctly and
  matches the server-side tier assignment; nothing in this repo verifies
  that assumption at runtime.
- **Desktop app engine port (`desktop-app/lib/pricingEngine.js`)** is a
  manual 1:1 port with no automated parity test against either the root or
  Worker engine — it can silently drift.

## 8. Test Coverage Summary

232 Vitest tests across 17 files (root `tests/` + `cloudflare-worker/tests/`,
confirmed by running `npx vitest --run`), covering:

- Coupon policy precedence — `tests/coupon-policy.test.ts` (23 cases) and
  `cloudflare-worker/tests/compute-coupon-writes.test.ts` (21 cases): rule
  ordering, locked tiers, disabled brands/products, minPriceRatio math.
- Cross-engine pricing parity — `tests/pricing-parity.test.ts` (root vs.
  Worker engine, 121 profile combinations including the INC-004 regression
  case).
- Brand/category/product discount fallback hierarchy.
- Incremental sync correctness (`tests/incremental-sync.test.ts`,
  `tests/incremental-production-run.test.ts` — covers the INC-001 class of
  bug), coupon-sales-writer guest-pricelist protection
  (`cloudflare-worker/tests/coupon-sales-writer.test.ts` — the INC-003 class
  of bug), and products-reader field extraction
  (`cloudflare-worker/tests/products-reader.test.ts`).
- XML/feed safety (`xml-tag-safety.test.ts`, `xml-validation.test.ts`).

**Not covered:**
- All root-level frontend `.js` files (§6) — zero test coverage, FTP-deployed
  outside CI.
- The three-way tier + coupon + clearance interaction (§7).
- The clearance-vs-product-override merge precedence when both apply to the
  same product (§2, §7).
- `desktop-app/lib/pricingEngine.js` parity against the two tested engines.
