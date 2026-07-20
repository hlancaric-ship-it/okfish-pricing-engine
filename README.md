# Shoptet Pricing Engine 🚀

A highly-performant, immutable pricing engine designed specifically for Shoptet e-shops. It processes huge datasets (100k+ products) applying complex business rules like highest discounts, loyalty tiers, brand limits, and strict rounding. 

## Features
- **Extreme Performance**: Processes 100,000 products with 10 different tier lists in under 5 seconds natively in Node.js.
- **Golden Dataset Testing**: Protected against any accidental math regressions via strictly verified CSV test outputs.
- **Versioned Policies**: JSON-based configurations separate business logic from the TypeScript engine.
- **Immutable & Extensible architecture**: Uses a pure Command pattern and an Engine Builder for total safety.

## Getting Started

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Generate Tariffs (CLI):**
   Runs the engine using `policy-v1.json` on any CSV data.
   ```bash
   npm run generate
   ```

3. **Run tests:**
   ```bash
   npm test
   ```

4. **Run Benchmark:**
   ```bash
   npm run benchmark
   ```

## Documentation
- [Architecture](docs/Architecture.md)
- [Pricing Policies](docs/Pricing.md)
- [Import Formats](docs/Import.md)
- [Testing & Golden Datasets](docs/Testing.md)
- [Roadmap & API SDK](ROADMAP.md)
