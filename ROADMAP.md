# Roadmap

## Phase 1: Engine Foundation (Completed)
- 100k+ products scale benchmarked.
- Stream CSVs.
- Policy Plugins + Immutable Engine.

## Phase 2: Enterprise CI/CD & Testing (Completed)
- GitHub Actions setup.
- Golden Datasets.
- JSON Versioned policies.

## Phase 3: Monorepo & Libraries (Upcoming)
In order to distribute the engine, we will split the repo into workspaces:
1. `@shoptet-pricing/core`: The pure logic (No CSV/Server).
2. `@shoptet-pricing/csv`: Stream utilities.
3. `@shoptet-pricing/cli`: Developer toolkit.

## Phase 4: Shoptet API Synchronization
Future Shoptet Enterprise clients don't use CSVs. We will introduce:
- `ShoptetApiReader`
- `ShoptetApiWriter`
To sync calculations directly against the Shoptet REST API instead of Zip files.

## V1.1 / V2.0 Optimizations
- **Parallel Chunk Upload**: The current 47,860 customers chunk upload takes roughly 5+ minutes (safe and stable). For 200k+ databases, update `src/cli/upload.ts` to use parallel `Promise.all()` with a concurrency limit (e.g. `p-limit`) instead of sequential `for` loops to speed up the Worker import.
