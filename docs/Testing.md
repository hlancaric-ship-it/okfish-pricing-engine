# Testing

We use `vitest` for fast execution.

## Unit Tests
Every single policy has strict unit tests located in `tests/`.

## Golden Dataset
We utilize Golden Dataset testing (snapshot testing) for integration.
1. `fixtures/products.csv` contains multiple complex products mapping edge-cases.
2. `fixtures/expected/` contains what the output CSV for every loyalty tier *should* look like.
3. `tests/golden.test.ts` runs the generator and strictly matches output. If the math changes by a single cent, the CI pipeline breaks.

To update the golden dataset, run:
```bash
npx tsx scripts/generate_golden.ts
```
*(Only do this if you intentionally changed business rules or policies, and manually verify the diff)*
