# Architecture

The Pricing Engine is designed around safety, speed, and testability.

## 1. Immutability
`PricingEngine` does not mutate data directly. It evaluates an array of `PricingPolicy` plugins, which in turn yield `PricingCommand` events. Only at the very end does the engine reduce those commands into a final read-only `PricingResult`.

## 2. Engine Builder & JSON Config
`EngineBuilder` abstracts away the creation of the engine. To ensure rules are consistent across the system, you configure it via `.fromConfig('path-to-policy.json')`. This reads:
- `loyaltyTiers`
- `brandLimits`
- `categoryLimits`

Once `build()` is called, the Engine is **frozen** and prevents further policy injection.

## 3. Streaming architecture
We use `csv-parse` and stream handling so we can pipe multi-gigabyte files into the engine without crashing RAM. 
