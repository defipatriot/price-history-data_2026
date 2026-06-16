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

## ⭐ Get a full year instead of 90 days — add a free CoinGecko key

The keyless public API caps `market_chart` history at ~90 days (and 404s thin
coins like stLUNA). A **free CoinGecko Demo key** lifts this to **365 days** and
unlocks the thin coins — it's the single biggest improvement here.

1. Get a free demo key at coingecko.com → Developers → "Demo" plan (no card).
2. In this repo: Settings → Secrets and variables → Actions → New repository secret
   → name `COINGECKO_API_KEY`, value = the key.
3. Re-run the Action (`mode = full`). Leave `coingecko_pro` = `false` (it's a demo key).

For history older than a year (toward genesis), you'd need a paid CoinGecko plan.

## The Tier-2 / no-feed tokens (ampCAPA, ampROAR, xASTRO) — RESOLVED elsewhere

Three tokens have no CoinGecko feed. Their USD is `base × on-chain ratio`
(PRICING-DOCTRINE). The ratio history is **NOT built in this repo** — that work
is done, and it lives in the `network-and-prices` cron, not here.

What happened (2026-06-15): we surveyed every reachable Terra phoenix-1 archive
node (TFL `rpc-terra.tfl.foundation` / `phoenix-rpc.terra.dev`, publicnode,
polkachu) to read each hub's `{state}.exchange_rate` at past heights — **none
serve historical state** (all pruned or dead). The tx-log reconstruction idea was
also rejected: only arbLUNA emits `exchange_rate` in-event; the amp hubs emit only
deltas, so it would need a fragile accounting replay. So the ratio path became
**forward-capture**: `network-and-prices` already queries all 6 LST rates hourly
and now appends them to `network-and-prices-data_2026/data/ratio-history.json`
each end-of-day, and a one-time consolidator recovered history from existing daily
archives. The UI computes `LST_USD(day) = base_USD(day) × rate(day)` by joining
that file against `daily-prices.json` here.

**Cleanup note:** the dead exploration scripts `ratio-history-backfill.*` and
`ratio-history-probe.*` may still be sitting in this repo — they're orphans (the
working solution is in network-and-prices) and are safe to delete.

## Run it (Actions tab)

1. **Sample first:** Actions → "Price History Backfill" → Run workflow →
   `mode = sample`. Writes nothing; the log prints each token's coverage (days,
   date range, confidence) and which tokens are amount-only. Confirm it looks right.
2. **Full:** Run again with `mode = full`. Publishes `daily-prices.json` +
   `coverage.json` + `heartbeat.json`.

## Forward maintenance (later, optional)
Historical backfill is one-time. To keep prices current going forward, the
`network-and-prices` cron already captures live prices hourly — a daily archive
there is the natural forward path. Re-running this Action also tops up the series
(it overwrites with the latest full pull).

## Recent changes
- **1.0.2** (2026-06-15) — ratio path RESOLVED: no Terra archive node exists, so
  ampCAPA/ampROAR/xASTRO ratio history is forward-capture in `network-and-prices`
  (not this repo). Stale "ratio-history-backfill below" section corrected; flagged
  the dead `ratio-history-backfill.*` / `ratio-history-probe.*` orphans for removal.
- **1.0.1** (2026-06-15) — after the first sample run: EURE id fixed to
  `monerium-eur-money-2` (+ legacy `monerium-eur-money` stitched for older history);
  confirmed working LST ids promoted (ampLUNA `eris-amplified-luna`, arbLUNA
  `eris-arbitrage-luna`, bLUNA `backbone-labs-staked-luna`, all low-confidence);
  clearer 404 messaging; prominent free-Demo-key guidance (90→365 days); ratio-
  history path documented for ampCAPA/ampROAR/xASTRO.
- **1.0.0** — initial build. CoinGecko `market_chart` daily backfill; tiered
  confidence; explicit `unavailable[]` for no-feed tokens; UTC-daily down-sampling
  unit-tested; `sample`/`full` modes; optional CG key support.
