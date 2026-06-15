// =============================================================================
// price-history-backfill.js  —  daily USD price history for TLA tokens (CoinGecko)
// =============================================================================
//
// One-time (then optional forward) backfill of DAILY USD prices for every TLA
// token CoinGecko can give us history for. Feeds the Portfolio Tracker P&L and
// any "then → now" USD valuation.
//
// HONEST-COVERAGE design (the key constraint Camron flagged):
//   • Tier-1 deep assets (LUNA, USDC, ATOM, WBTC, ETH, ROAR, CAPA, ASTRO, …) have
//     a CoinGecko id → daily history is reliable. confidence = "high".
//   • Tier-2 LST / derivative tokens (ampLUNA, arbLUNA, bLUNA, ampCAPA, ampROAR,
//     xASTRO) are priced live as `base × on-chain ratio` (PRICING-DOCTRINE), and
//     the on-chain ratio is PRUNED historically — so we CANNOT reconstruct their
//     past USD from chain. If CoinGecko happens to list one, we take it but mark
//     confidence = "low" (coingecko-direct; doctrine says don't fully trust small
//     caps). If it has no CG id and no history, we DO NOT fabricate a number —
//     the token goes in `unavailable[]` with a reason, and the UI shows token
//     amount then→now with "historical USD unavailable for this token."
//
// So the output explicitly separates: priced[] (with confidence) vs unavailable[]
// (with reason). No silent zeros, no fake derivations. (Design Principle #1.)
//
// Source: CoinGecko /coins/{id}/market_chart?vs_currency=usd&days=max
//   → { prices: [[ts_ms, usd], ...] }  (free tier returns daily granularity for
//      ranges > 90d; we down-sample to one point per UTC day regardless).
//   The public endpoint caps history (often ~365d) unless a key is set; we record
//   the ACTUAL earliest date per token (honest horizon), never claim "from genesis."
//
// MODE (RUN_MODE, mirrors the nft backfills): sample (default, dry-run — probes
//   each id's availability + a few points, writes NOTHING) | full (writes data).
//
// Outputs (to GITHUB_REPO, default price-history-data_2026, 2026/ year-folder):
//   2026/data/daily-prices.json   { schemaVersion, builtAt, vs_currency, source,
//                                   tokens: { SYMBOL: { cg_id, confidence,
//                                     earliest_date, latest_date, point_count,
//                                     points: [[YYYY-MM-DD, usd], ...] } },
//                                   unavailable: [ { symbol, reason } ] }
//   2026/data/coverage.json       compact per-token coverage summary (for tooltips)
//   2026/heartbeat.json           freshness + status + per-token ok flags
//
// Env:  GITHUB_TOKEN, GITHUB_REPO (default defipatriot/price-history-data_2026),
//       GITHUB_BRANCH (default main), RUN_MODE (sample|full),
//       COINGECKO_API_KEY (optional — demo or pro key; raises rate limits),
//       COINGECKO_PRO (=1 if the key is a Pro key, else demo),
//       DAYS (default "max"), REQUEST_SPACING_MS (default 2500 — be gentle).
// =============================================================================

'use strict';

const https = require('https');

let ErrorLog;
try { ({ ErrorLog } = require('../lib/error-reporter.js')); }
catch { ErrorLog = class { constructor(){ this._e = []; } add(s,e){ this._e.push({ step: s, message: String(e && e.message || e) }); } list(){ return this._e; } count(){ return this._e.length; } }; }

// ----------------------------------------------------------------------------- config
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/price-history-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const YEAR_DIR      = '2026';
const RUN_MODE      = (process.env.RUN_MODE || 'sample').toLowerCase();
const DAYS          = process.env.DAYS || 'max';
const SPACING_MS    = Number(process.env.REQUEST_SPACING_MS || 2500);
const SCHEMA_VERSION = 1;
const FORWARD_CADENCE_HOURS = 24;

const CG_KEY = process.env.COINGECKO_API_KEY || null;
const CG_PRO = process.env.COINGECKO_PRO === '1' || process.env.COINGECKO_PRO === 'true';
const CG_BASE = CG_PRO ? 'https://pro-api.coingecko.com/api/v3' : 'https://api.coingecko.com/api/v3';
const CG_KEY_HEADER = CG_PRO ? 'x-cg-pro-api-key' : 'x-cg-demo-api-key';

// Token → CoinGecko id + confidence tier. cg_id values are lifted verbatim from
// the live network-and-prices cron's TOKEN_REGISTRY (the single source of truth).
//   tier 'high' = deep asset, CoinGecko reliable (PRICING-DOCTRINE Tier-1).
//   tier 'low'  = small/derivative; CG-direct is a weak feed (Tier-2) — attempt,
//                 but flag low confidence. No cg_id → it lands in unavailable[].
const TOKENS = {
    // Tier-1 (deep, trustworthy on CoinGecko)
    LUNA:   { cg_id: 'terra-luna-2',        tier: 'high' },
    USDC:   { cg_id: 'usd-coin',            tier: 'high' },
    USDT:   { cg_id: 'tether',              tier: 'high' },
    WBTC:   { cg_id: 'wrapped-bitcoin',     tier: 'high' },
    PAXG:   { cg_id: 'pax-gold',            tier: 'high' },
    EURE:   { cg_id: 'euroe-stablecoin',    tier: 'high' },
    INJ:    { cg_id: 'injective-protocol',  tier: 'high' },
    ATOM:   { cg_id: 'cosmos',              tier: 'high' },
    ETH:    { cg_id: 'ethereum',            tier: 'high' },
    WETH:   { cg_id: 'ethereum',            tier: 'high' },   // proxy via ETH
    WSTETH: { cg_id: 'wrapped-steth',       tier: 'high' },
    BNB:    { cg_id: 'binancecoin',         tier: 'high' },
    WBNB:   { cg_id: 'wbnb',                tier: 'high' },
    OSMO:   { cg_id: 'osmosis',             tier: 'high' },
    // EURE = Monerium EURe. CG renamed it: current id 'monerium-eur-money-2'
    // (since 2026-02-16); older history is under the legacy id below — stitched
    // when a key gives a long enough window (free tier won't reach it anyway).
    EURE:   { cg_id: 'monerium-eur-money-2', legacy_cg_id: 'monerium-eur-money', tier: 'high' },
    STLUNA: { cg_id: 'stride-staked-luna',  tier: 'high', note: 'thin coin — market_chart may 404 without a CoinGecko key' },
    STATOM: { cg_id: 'stride-staked-atom',  tier: 'high' },
    SOLID:  { cg_id: 'solid-2',             tier: 'high' },
    SWTH:   { cg_id: 'switcheo',            tier: 'high' },
    ROAR:   { cg_id: 'lion-dao',            tier: 'high' },
    CAPA:   { cg_id: 'capapult',            tier: 'high' },
    ASTRO:  { cg_id: 'astroport-fi',        tier: 'high' },

    // Tier-2 derivatives. These three CG ids are CONFIRMED working (probe
    // 2026-06-15) — kept low-confidence per PRICING-DOCTRINE (small-cap CG feed).
    bLUNA:   { cg_id: 'backbone-labs-staked-luna', tier: 'low', note: 'LST — CG-direct; doctrine says weak feed' },
    ampLUNA: { cg_id: 'eris-amplified-luna',       tier: 'low', note: 'LST — CG-direct confirmed; live price is LUNA×ratio' },
    arbLUNA: { cg_id: 'eris-arbitrage-luna',       tier: 'low', note: 'LST — CG-direct confirmed; live price is LUNA×ratio' },
    // No CG feed — historical USD only reconstructable via base×ratio (see the
    // ratio-history path in the README). Until then: amount-only in the UI.
    ampCAPA: { cg_id: null, tier: 'low', note: 'no CG feed — derive via CAPA×ratio (ratio-history backfill)' },
    ampROAR: { cg_id: null, tier: 'low', note: 'no CG feed — derive via ROAR×ratio (ratio-history backfill)' },
    xASTRO:  { cg_id: null, tier: 'low', note: 'no CG feed — derive via ASTRO×ratio (ratio-history backfill)' },
};

// ----------------------------------------------------------------------------- http
function httpGetJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'GET',
            headers: { 'Accept': 'application/json', 'User-Agent': 'aDAO-price-history-backfill/1.0', ...headers } },
            res => { let data = ''; res.on('data', c => data += c); res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch (e) { reject(new Error(`bad JSON: ${data.slice(0,120)}`)); } }
                else reject(new Error(`HTTP ${res.statusCode} ${data.slice(0,160)}`)); }); });
        req.on('error', reject); req.setTimeout(30000, () => req.destroy(new Error('timeout'))); req.end();
    });
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function cgMarketChart(cgId, days, retries = 4) {
    const headers = CG_KEY ? { [CG_KEY_HEADER]: CG_KEY } : {};
    const url = `${CG_BASE}/coins/${encodeURIComponent(cgId)}/market_chart?vs_currency=usd&days=${encodeURIComponent(days)}`;
    let lastErr;
    for (let attempt = 1; attempt <= retries; attempt++) {
        try { return await httpGetJson(url, headers); }
        catch (e) {
            lastErr = e;
            // 429 = rate limit → back off harder; 404 = no such id → don't retry
            if (/HTTP 404/.test(e.message)) throw e;
            const backoff = /HTTP 429/.test(e.message) ? 15000 * attempt : 2000 * attempt;
            if (attempt < retries) await sleep(backoff);
        }
    }
    throw lastErr;
}

// ----------------------------------------------------------------------------- transform
// CoinGecko prices arrive as [ts_ms, price]. Down-sample to one point per UTC day
// (last reading of each day wins). Returns sorted [[YYYY-MM-DD, price], ...].
function toDailySeries(prices) {
    if (!Array.isArray(prices)) return [];
    const byDay = new Map();
    for (const p of prices) {
        if (!Array.isArray(p) || p.length < 2 || p[0] == null || p[1] == null) continue;
        const ts = Number(p[0]), price = Number(p[1]);
        if (!Number.isFinite(ts) || ts <= 0 || !Number.isFinite(price) || price <= 0) continue;
        const day = new Date(ts).toISOString().slice(0, 10);
        byDay.set(day, price); // later same-day reading overwrites → last-of-day
    }
    return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

// ----------------------------------------------------------------------------- one token
async function backfillToken(symbol, cfg, sampleOnly) {
    const cgId = cfg.cg_id || null;
    if (!cgId) return { symbol, ok: false, reason: cfg.note || 'no CoinGecko id — historical USD unavailable' };
    try {
        const days = sampleOnly ? '90' : DAYS;
        const res = await cgMarketChart(cgId, days);
        let series = toDailySeries(res?.prices);

        // Stitch older history from a legacy id (e.g. EURE's pre-rename id), if any
        // and if not in sample mode. Legacy points fill ONLY dates the current id
        // doesn't already cover (current id wins on overlap).
        if (!sampleOnly && cfg.legacy_cg_id) {
            try {
                const legacy = await cgMarketChart(cfg.legacy_cg_id, days);
                const legacySeries = toDailySeries(legacy?.prices);
                if (legacySeries.length) {
                    const have = new Set(series.map(p => p[0]));
                    series = [...legacySeries.filter(p => !have.has(p[0])), ...series].sort((a, b) => a[0].localeCompare(b[0]));
                }
            } catch { /* legacy is best-effort */ }
        }

        if (!series.length) return { symbol, ok: false, reason: `CoinGecko id "${cgId}" returned no daily price history (thin coin or tier limit — a CoinGecko key may unlock it)` };
        return {
            symbol, ok: true, cg_id: cgId, confidence: cfg.tier === 'high' ? 'high' : 'low',
            tier_note: cfg.note || undefined,
            earliest_date: series[0][0], latest_date: series[series.length - 1][0],
            point_count: series.length, points: sampleOnly ? series.slice(-5) : series,
        };
    } catch (e) {
        const reason = /HTTP 404/.test(e.message)
            ? `CoinGecko has no market_chart for id "${cgId}" (wrong id, or no history on this API tier — try a CoinGecko key)`
            : `fetch failed: ${e.message}`;
        return { symbol, ok: false, reason };
    }
}

// ----------------------------------------------------------------------------- github
function githubApiRequest(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'aDAO-price-history-backfill', 'Authorization': `Bearer ${GITHUB_TOKEN}`, 'Accept': 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let data = ''; res.on('data', c => data += c); res.on('end', () => { if (res.statusCode >= 200 && res.statusCode < 300) { try { resolve(JSON.parse(data)); } catch { resolve(data); } } else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${data.slice(0,200)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publishFile(filePath, contentObj, message) {
    const content = typeof contentObj === 'string' ? contentObj : JSON.stringify(contentObj, null, 2);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${filePath}`;
    let sha = null;
    try { sha = (await githubApiRequest('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch { /* new */ }
    const body = { message, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return githubApiRequest('PUT', apiPath, body);
}

// ----------------------------------------------------------------------------- main
async function run() {
    const startedAt = new Date();
    const errors = new ErrorLog();
    const sampleOnly = RUN_MODE === 'sample';
    console.log(`\n💰 price-history-backfill — ${startedAt.toISOString()} — mode=${RUN_MODE}${CG_KEY ? ` (CG ${CG_PRO ? 'pro' : 'demo'} key set)` : ' (no CG key — public limits apply)'}\n`);

    if (!sampleOnly && !GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing — refusing full run (no publish target).');

    const tokensOut = {}; const unavailable = []; const coverage = {};
    const symbols = Object.keys(TOKENS);
    for (let i = 0; i < symbols.length; i++) {
        const sym = symbols[i];
        const r = await backfillToken(sym, TOKENS[sym], sampleOnly);
        if (r.ok) {
            tokensOut[sym] = { cg_id: r.cg_id, confidence: r.confidence, tier_note: r.tier_note, earliest_date: r.earliest_date, latest_date: r.latest_date, point_count: r.point_count, points: r.points };
            coverage[sym] = { has_history: true, cg_id: r.cg_id, confidence: r.confidence, earliest: r.earliest_date, latest: r.latest_date, points: r.point_count };
            console.log(`  ✓ ${sym.padEnd(8)} ${r.point_count} days (${r.earliest_date}→${r.latest_date})  [${r.confidence}]`);
        } else {
            unavailable.push({ symbol: sym, reason: r.reason });
            coverage[sym] = { has_history: false, reason: r.reason };
            console.log(`  ✗ ${sym.padEnd(8)} ${r.reason}`);
        }
        if (i < symbols.length - 1) await sleep(SPACING_MS); // gentle pacing
    }

    const priced = Object.keys(tokensOut).length;
    console.log(`\n  priced: ${priced}/${symbols.length}   unavailable: ${unavailable.length}`);

    if (sampleOnly) {
        console.log('\n(sample mode — nothing written. Re-run with RUN_MODE=full to publish.)');
        console.log('Tokens in unavailable[] will show amount-only then→now in the UI with a "no historical USD" note.');
        return;
    }

    const daily = { schemaVersion: SCHEMA_VERSION, builtAt: startedAt.toISOString(), vs_currency: 'usd', source: 'coingecko', days_requested: DAYS, token_count: priced, tokens: tokensOut, unavailable };
    const cov   = { schemaVersion: SCHEMA_VERSION, builtAt: startedAt.toISOString(), coverage };
    await publishFile(`${YEAR_DIR}/data/daily-prices.json`, daily, `daily-prices: ${priced} tokens`);
    await publishFile(`${YEAR_DIR}/data/coverage.json`, cov, `price coverage: ${priced} priced / ${unavailable.length} unavailable`);

    const hb = { schemaVersion: SCHEMA_VERSION, capturedAt: startedAt.toISOString(), runId: startedAt.getTime().toString(36),
        status: errors.count() ? 'partial' : 'ok', source: 'coingecko', priced_count: priced, unavailable_count: unavailable.length,
        per_token_ok: Object.fromEntries(symbols.map(s => [s, !!tokensOut[s]])),
        next_expected_run_at: new Date(startedAt.getTime() + FORWARD_CADENCE_HOURS * 3600 * 1000).toISOString(),
        error_count: errors.count(), recent_errors: errors.list() };
    await publishFile(`${YEAR_DIR}/heartbeat.json`, hb, `heartbeat ${hb.status}`);

    console.log(`\n✅ published — ${priced} priced, ${unavailable.length} amount-only.`);
}

if (require.main === module) { run().catch(err => { console.error('FATAL:', err.message); process.exit(1); }); }
module.exports = { toDailySeries, backfillToken, TOKENS };
