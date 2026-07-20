# Import and Export formats

## Input Format (Shoptet Export)
The application expects standard Shoptet CSV structure delimited by `;`.
Important mapped headers:
- `code` (Mapped to SKU)
- `price` (Base Price)
- `actionPrice` (Sale Price)
- `maxDiscount` (Optional product limitation)
- `manufacturer` (Used for BrandLimitPolicy)
- `categoryText` (Used for CategoryLimitPolicy)

## Output Format
Generates files corresponding to the specific Tier (e.g. `ZR20.csv`).
Delimited by `;`.
- `Code`: SKU
- `Price`: The final computed price

Output files can be zipped via the built in Express Server for easy download.
