# price-history-data_2026

One-time (then optional forward) **daily USD price history** for TLA tokens,
pulled from CoinGecko. Feeds the Portfolio Tracker "then → now" P&L.

The backfill script, workflow, and package.json live **in this repo** and run as
a manual GitHub Action — same model as the nft backfills.

## The honest-coverage rule (why some tokens have no USD history)

Per `PRICING-DOCTRINE.md`, TLA prices split into two tiers:

- **Tier-1 deep assets** (LUNA, USDC, USDT, WBTC, ATOM, ETH, PAXG, EURE, INJ,
  WSTETH, BNB, OSMO, stLUNA, stATOM, SOLID, SWTH, ROAR, CAPA, ASTRO) have a
  CoinGecko id → reliable daily history. `confidence: "high"`.
- **Tier-2 LST / derivative tokens** (ampLUNA, arbLUNA, bLUNA, ampCAPA, ampROAR,
  xASTRO) are priced live as `base × on-chain ratio`. The on-chain ratio is
  **pruned historically**, so their past USD can't be reconstructed from chain.
  If CoinGecko happens to list one (e.g. bLUNA), we take it but mark
  `confidence: "low"` (doctrine: small-cap CG feeds are weak). If there's no feed,
  the token is recorded in **`unavailable[]` with a reason — no fabricated number.**

So the consuming UI does exactly what Camron specified: for `unavailable[]` tokens
it shows **token amount then → now** with a note like *"historical USD unavailable
for this token."* No silent zeros (Design Principle #1).

## Output (`2026/`)

| File | Contents |
|---|---|
| `data/daily-prices.json` | `tokens: { SYMBOL: { cg_id, confidence, earliest_date, latest_date, point_count, points: [[YYYY-MM-DD, usd], …] } }` + `unavailable: [{ symbol, reason }]` |
| `data/coverage.json` | compact per-token `{ has_history, confidence, earliest, latest, points }` (or `reason`) for tooltips |
| `heartbeat.json` | freshness, status, per-token ok flags |

Series are one point per UTC day (last reading of the day). `earliest_date` is the
**actual** earliest day CoinGecko returned — the public API often caps history
(~365d) without a key, so the data is honestly "history from `earliest_date`,"
never a false "from genesis."

## Run it (Actions tab)

1. **Sample first:** Actions → "Price History Backfill" → Run workflow →
   `mode = sample`. Writes nothing; the log prints each token's coverage (days,
   date range, confidence) and which tokens are amount-only. Confirm it looks right.
2. **Full:** Run again with `mode = full`. Publishes `daily-prices.json` +
   `coverage.json` + `heartbeat.json`.

### Optional: more history / higher limits
Add a CoinGecko key as a repo secret `COINGECKO_API_KEY`
(Settings → Secrets and variables → Actions). Set the `coingecko_pro` input to
`true` only if it's a Pro key. Without a key it still works — just slower (the
`request_spacing_ms` input paces calls to avoid 429s) and with a shorter window.

## Forward maintenance (later, optional)
Historical backfill is one-time. To keep prices current going forward, the
`network-and-prices` cron already captures live prices hourly — a daily archive
there is the natural forward path. Re-running this Action also tops up the series
(it overwrites with the latest full pull).

## Recent changes
- **1.0.0** — initial build. CoinGecko `market_chart` daily backfill; tiered
  confidence; explicit `unavailable[]` for no-feed tokens; UTC-daily down-sampling
  unit-tested; `sample`/`full` modes; optional CG key support. cg_id list lifted
  verbatim from the live `network-and-prices` `TOKEN_REGISTRY`.
