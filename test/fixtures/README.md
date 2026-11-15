# Test fixtures

## `apps.yaml`, `stacks/*.tf`

Real: copied from `BreakthruDevelopment/30-apps-infra` (`apps.yaml` from main on 2026-11-14; the `stacks/` files are
excerpts at commit `5e5ad6a`, lines kept verbatim).

## `prices/` (SYNTHETIC)

**These are not recorded responses.** The build sandbox's egress blocked all four price hosts
(`pricing.us-east-1.amazonaws.com`, `prices.azure.com`, `cloudbilling.googleapis.com`, `apexapps.oracle.com`), so they
were written by hand from each vendor's documented format. The prices are invented but plausible, and each file also
holds rows that must NOT match (Windows, Spot, other regions, other instance types, free tiers), so the matchers are
tested against noise.

| File | Shape it imitates |
| --- | --- |
| `aws-<serviceCode>.csv` | AWS Price List Bulk API CSV: five metadata lines, a header, one record per line, all fields quoted |
| `azure-all.json` | Azure Retail Prices API page: `Items[]` with `retailPrice`, `meterName`, `tierMinimumUnits`, ...; the test fetcher filters it by the `serviceName` in the `$filter` |
| `gcp-services.json`, `gcp-skus-<serviceId>.json` | Cloud Billing Catalog `services.list` and `services.skus.list`: `{ units, nanos }` prices, `tieredRates` |
| `oci-products.json` | Oracle price list: `items[].currencyCodeLocalizations[].prices[]` (`PAY_AS_YOU_GO`, `rangeMin`/`rangeMax`) |

What this means: the PARSERS and the engine around them are tested, but each `sku-map.ts` matcher (part numbers, meter
names, descriptions) is a best reading of the documented formats and is **unconfirmed against a live response**. Issue
31.9's first live refresh is where they are confirmed; a matcher that finds nothing just shows "not listed".
To replace a fixture with a real response, save it under the same name; `test/price-ingest.test.ts` states the
expected micro-dollar values per row, so a changed price shows up as one clear failure.
