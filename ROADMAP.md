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
