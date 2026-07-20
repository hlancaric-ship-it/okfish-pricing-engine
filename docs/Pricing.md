# Pricing Policies

The engine processes pricing sequentially. The order is determined by `priority`:

1. **BasePricePolicy (Priority 10)**
   Initializes the price based on standard `price`.

2. **HighestDiscountPolicy (Priority 20)**
   Evaluates `actionPrice` (sale) vs. `customerTier` (loyalty discount). Whichever provides a cheaper final price is applied. If loyalty is forbidden for the product, it uses the sale price.

3. **BrandLimitPolicy & CategoryLimitPolicy (Priority 50)**
   Checks if the brand or category restricts maximum discount (e.g. Apple max 5%). It clamps the final price if necessary to preserve margins.

4. **ProductMaxDiscountPolicy (Priority 60)**
   Strict product-level margin protection (`maxDiscount` from CSV). Overrides all previous discounts if they exceed the allowed bounds.

5. **RoundingPolicy (Priority 100)**
   Rounds the final price to two decimal places (halves up).
