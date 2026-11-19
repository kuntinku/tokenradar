# Token Radar

A pre-token protocol board for the `token-radar-01` bounty. `main.ts` is the entry: a Node 22
program using only the standard library, reading the sealed `/input/snapshot.json` and writing
`board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json` into `/output`.

## The model (`radar-m2`)

Every pre-token protocol is scored by the same formula; no protocol name is special-cased. The
snapshot's own live-token protocols set the market's FDV/TVL norm:

```
peer   = median(mcap_usd / tvl_usd) of same-category protocols whose token trades
         (global median when a category has fewer than two trading peers)
size   = clamp(0.9 * (tvl_usd / 1e8)^-0.18, 0.25, 2.2)
sector = 0.55 * peer + 0.45 * size
growth = 1 + 0.0035 * clamp(change_7d, -50, 100)       (unknown growth: 1)
tenure = 0.55 + 0.45 * min(age_days, 1460) / 1460      (unknown age: 0.75)
implied_value_usd = max(1, round(tvl_usd * sector * growth * tenure))
```

Wrapped, staked, bridged, versioned and exchange products are set aside; protocols with a trading
token are never ranked with the pre-token board. The board covers all 40 watchlist slugs and adds
the protocols below the watchlist floor, 198 rows in all. Each row carries a farm plan derived
from its category, chains, TVL and age.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/kit/input/snapshot.json
node tools/gatecheck.mjs out
```

`tools/gatecheck.mjs` is a local mirror of the seven gate rows in the kit's RULES.txt: dashboard
files and offline-only sources, board shape, rank/value ordering, watchlist coverage, farm steps,
screenshot dimensions and byte-for-byte `dossier.json` match against `buildDossier`.

## Dashboard

`dashboard/index.html`, `app.css` and `app.js` read `../data.js`, which the entry writes from the
snapshot. The page is offline and framework-free: sortable and filterable board, per-protocol detail
with the value breakdown and farm plan, and a view of the live-token protocols set aside. Three
screenshots (1440x900) were captured from the generated output with headless Chromium: board,
detail and filtered views.

The `vendor/makefun-board.ts` library is the kit's own dossier builder, shipped unchanged because
the scorer compares `dossier.json` byte for byte with what that library writes.

Licensed MIT; see LICENSE.
