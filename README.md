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

For history older than a year (toward genesis), you'd need a paid CoinGecko plan
**or** the ratio-history path below.

## The Tier-2 / no-feed tokens (ampCAPA, ampROAR, xASTRO) — the ratio path

Three tokens have no CoinGecko feed at all. Their live price is `base × on-chain
ratio` (PRICING-DOCTRINE), and the chain prunes the historical ratio — so there's
no shortcut to their past USD. The way to recover it (Camron's idea, and it's the
right one):

**Reconstruct the daily exchange-rate from the tx log**, then compute
`LST_USD(day) = base_USD(day) × ratio(day)` using the base series we already have
(CAPA, ROAR, ASTRO are all priced here). The ratio steps up on each Eris hub
harvest/compound tx, so a `ratio-history-backfill` can `tx_search` each LST's hub
for those events and build a daily ratio series — the same tx-log backfill pattern
as the vote/lock job. This also extends the LUNA-LSTs (ampLUNA/arbLUNA/bLUNA)
beyond CoinGecko's window, all the way to genesis.

That's a separate, focused build (it needs a probe to confirm each hub's address +
rate-event shape first — exactly how the vote/lock keys were nailed down). Until
it's built, these tokens stay in `unavailable[]` and the UI shows amount-only.
Note this is a **completeness** follow-up: the assets that dominate Portfolio
Tracker P&L (LUNA, the LUNA-LSTs, USDC, ATOM, …) are already covered above.

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
- **1.0.1** (2026-06-15) — after the first sample run: EURE id fixed to
  `monerium-eur-money-2` (+ legacy `monerium-eur-money` stitched for older history);
  confirmed working LST ids promoted (ampLUNA `eris-amplified-luna`, arbLUNA
  `eris-arbitrage-luna`, bLUNA `backbone-labs-staked-luna`, all low-confidence);
  clearer 404 messaging; prominent free-Demo-key guidance (90→365 days); ratio-
  history path documented for ampCAPA/ampROAR/xASTRO.
- **1.0.0** — initial build. CoinGecko `market_chart` daily backfill; tiered
  confidence; explicit `unavailable[]` for no-feed tokens; UTC-daily down-sampling
  unit-tested; `sample`/`full` modes; optional CG key support.
