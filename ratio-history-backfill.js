// =============================================================================
// ratio-history-backfill.js  —  exact historical LST/amp exchange rates
// =============================================================================
//
// Reconstructs each token's daily exchange rate by reading its hub/vault {state}
// at PAST block heights on an ARCHIVE node — no accounting replay, no estimation.
// Probe (2026-06-15) confirmed every hub exposes {state}.exchange_rate; archive
// nodes (TFL) let us read that same query at any past height via the
// `x-cosmos-block-height` header. So: pick a block per day, read the rate, done.
//
// Primary targets are the NO-FEED tokens (ampCAPA, ampROAR) that have no
// CoinGecko history at all. The LUNA LSTs are included optionally — they're
// already CG-validated to ~1%, but this gives exact + pre-CG-window history.
//
// Output (GITHUB_REPO, default price-history-data_2026, 2026/):
//   data/ratio-history.json   { tokens: { ampCAPA: { hub, base, decimals,
//                               earliest_date, points:[[YYYY-MM-DD, rate]] }, … },
//                               unavailable:[{symbol,reason}] }
//   heartbeat.json
//
// To get USD: LST_USD(day) = base_USD(day) × rate(day), joining ratio-history
// against daily-prices.json (CAPA, ROAR, LUNA are all priced there).
//
// MODE (RUN_MODE): sample = validate the archive endpoint + print rates at a few
//   historical heights, write nothing | full = build the series + publish.
//
// Env: ARCHIVE_LCD (must be an ARCHIVE LCD honoring x-cosmos-block-height),
//   ARCHIVE_LCD_FALLBACK, WEEKS (default 130 ≈ 2.5y; capped by archive horizon),
//   RUN_MODE, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH.
//
// Default ARCHIVE_LCD is the TFL archive LCD; override if you have a better one.
// If sample mode shows the same rate at every height, the endpoint is NOT archive
// — point ARCHIVE_LCD at a real archive (e.g. a Polkachu/Chainstack archive LCD).
// =============================================================================

'use strict';

const https = require('https');

let ErrorLog;
try { ({ ErrorLog } = require('../lib/error-reporter.js')); }
catch { ErrorLog = class { constructor(){ this._e=[]; } add(s,e){ this._e.push({step:s,message:String(e&&e.message||e)}); } list(){return this._e;} count(){return this._e.length;} }; }

const ARCHIVE_LCD          = process.env.ARCHIVE_LCD          || 'https://phoenix-lcd.terra.dev';
const ARCHIVE_LCD_FALLBACK = process.env.ARCHIVE_LCD_FALLBACK || 'https://terra-lcd.publicnode.com';
const WEEKS    = Number(process.env.WEEKS || 130);
const RUN_MODE = (process.env.RUN_MODE || 'sample').toLowerCase();
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/price-history-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const YEAR_DIR = '2026';
const SCHEMA_VERSION = 1;
const WEEK_MS = 7 * 864e5;

// hub/vault contracts (resolved + confirmed by the probe). exchange_rate lives in
// {state} for all of them (utoken/ustake units → human rate is the same number).
const TARGETS = [
    { symbol: 'ampCAPA', base: 'CAPA', hub: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y' },
    { symbol: 'ampROAR', base: 'ROAR', hub: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy' },
    // LUNA LSTs (optional — already CG-validated ±1%; exact/longer history if wanted)
    { symbol: 'ampLUNA', base: 'LUNA', hub: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk', optional: true },
    { symbol: 'bLUNA',   base: 'LUNA', hub: 'terra1l2nd99yze5fszmhl5svyh5fky9wm4nz4etlgnztfu4e8809gd52q04n3ea', optional: true },
    { symbol: 'arbLUNA', base: 'LUNA', hub: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m', optional: true },
];

// ----------------------------------------------------------------------------- http
function httpGet(url, headers = {}, t = 25000) {
    return new Promise((res, rej) => {
        const u = new URL(url);
        const r = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: 'application/json', 'User-Agent': 'aDAO-ratio-backfill/1.0', ...headers } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0,120)}`)); });
        });
        r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
    });
}
async function lcdGet(path, headers = {}) {
    try { return await httpGet(ARCHIVE_LCD + path, headers); }
    catch (e) { return await httpGet(ARCHIVE_LCD_FALLBACK + path, headers); }
}
// Smart query at an optional historical height (archive LCD honors the header).
async function stateAt(contract, height) {
    const b64 = Buffer.from(JSON.stringify({ state: {} })).toString('base64');
    const headers = height ? { 'x-cosmos-block-height': String(height) } : {};
    const r = await lcdGet(`/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`, headers);
    return r?.data;
}
function rateOf(state) {
    if (!state) return null;
    if (state.exchange_rate != null) return Number(state.exchange_rate);
    // fallback: total_utoken / total_ustake (or _native/_usteak variants)
    const u = state.total_utoken ?? state.total_uluna ?? state.total_native;
    const s = state.total_ustake ?? state.total_usteak ?? state.total_lp_supply;
    return (u != null && s) ? Number(u) / Number(s) : null;
}

// ----------------------------------------------------------------------------- block ↔ time
let TIP = null;
async function tip() {
    if (TIP) return TIP;
    const r = await lcdGet('/cosmos/base/tendermint/v1beta1/blocks/latest');
    TIP = { height: Number(r.block.header.height), time: Date.parse(r.block.header.time) };
    return TIP;
}
const blockTimeCache = new Map();
async function blockTime(height) {
    if (blockTimeCache.has(height)) return blockTimeCache.get(height);
    const r = await lcdGet(`/cosmos/base/tendermint/v1beta1/blocks/${height}`);
    const t = Date.parse(r.block.header.time);
    blockTimeCache.set(height, t);
    return t;
}
// Binary-search the height whose block time is closest to (<=) targetMs.
// `floor` is the earliest height the archive can serve (the honest horizon).
async function heightForTime(targetMs, floor) {
    const t = await tip();
    if (targetMs >= t.time) return t.height;
    let lo = floor, hi = t.height, ans = floor;
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        let bt; try { bt = await blockTime(mid); } catch { lo = mid + 1; continue; }
        if (bt <= targetMs) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
}
// Find the earliest height the archive still serves (probe down by halving).
async function findFloor() {
    const t = await tip();
    let h = 1;
    try { await blockTime(1); return 1; } catch {}
    // ascend from a small height until one resolves, then we have a floor bound
    for (const cand of [1000000, 3000000, 5000000, 7000000, 9000000, 11000000, Math.floor(t.height/2)]) {
        if (cand >= t.height) break;
        try { await blockTime(cand); return cand; } catch {}
    }
    return Math.floor(t.height * 0.9); // worst case: only recent history
}

// ----------------------------------------------------------------------------- github
function ghReq(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'aDAO-ratio-backfill', Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ if(res.statusCode>=200&&res.statusCode<300){try{resolve(JSON.parse(d));}catch{resolve(d);}}else reject(new Error(`GitHub ${method} ${apiPath}: ${res.statusCode} ${d.slice(0,160)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publish(path, obj, msg) {
    const content = JSON.stringify(obj, null, 2);
    const apiPath = `/repos/${GITHUB_REPO}/contents/${path}`;
    let sha = null; try { sha = (await ghReq('GET', apiPath + `?ref=${GITHUB_BRANCH}`)).sha; } catch {}
    const body = { message: msg, content: Buffer.from(content).toString('base64'), branch: GITHUB_BRANCH };
    if (sha) body.sha = sha;
    return ghReq('PUT', apiPath, body);
}

// ----------------------------------------------------------------------------- modes
async function runSample() {
    console.log('🔬 sample — validating archive endpoint; writing nothing.\n');
    console.log(`   ARCHIVE_LCD = ${ARCHIVE_LCD}`);
    const t = await tip();
    console.log(`   tip height=${t.height}  time=${new Date(t.time).toISOString()}`);
    const floor = await findFloor();
    const fT = await blockTime(floor).catch(() => null);
    console.log(`   earliest reachable height≈${floor}  (${fT ? new Date(fT).toISOString().slice(0,10) : 'n/a'})\n`);

    const probe = TARGETS.find(x => x.symbol === 'ampCAPA');
    const heights = [t.height, t.height - 500000, t.height - 2000000, Math.max(floor, t.height - 6000000)];
    console.log(`   ampCAPA rate at descending heights (must DIFFER if archive works):`);
    let prev = null, archiveOk = false;
    for (const h of heights) {
        try {
            const st = await stateAt(probe.hub, h === t.height ? null : h);
            const r = rateOf(st);
            const when = await blockTime(h).catch(() => null);
            console.log(`     height ${h}  (${when ? new Date(when).toISOString().slice(0,10) : '?'})  rate=${r}`);
            if (prev != null && r != null && Math.abs(r - prev) > 1e-9) archiveOk = true;
            prev = r;
        } catch (e) { console.log(`     height ${h}  ✗ ${e.message}`); }
    }
    console.log(`\n   archive historical reads ${archiveOk ? 'WORK ✅ — run RUN_MODE=full' : 'do NOT vary ❌ — endpoint is pruned; set ARCHIVE_LCD to a real archive LCD'}`);
}

async function runFull() {
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing — refusing full run.');
    const errors = new ErrorLog();
    const t = await tip();
    const floor = await findFloor();
    const floorTime = await blockTime(floor).catch(() => t.time);
    console.log(`   tip=${t.height} (${new Date(t.time).toISOString().slice(0,10)})  floor≈${floor} (${new Date(floorTime).toISOString().slice(0,10)})`);

    // weekly target timestamps (oldest→newest), clamped to the archive horizon
    const targets = [];
    for (let i = WEEKS; i >= 0; i--) {
        const ts = t.time - i * WEEK_MS;
        if (ts >= floorTime) targets.push(ts);
    }
    // resolve a height per weekly target once (shared across tokens)
    const heightByTs = new Map();
    for (const ts of targets) heightByTs.set(ts, await heightForTime(ts, floor));

    const tokensOut = {}; const unavailable = [];
    for (const tok of TARGETS) {
        // confirm the hub answers at all
        let liveRate = null; try { liveRate = rateOf(await stateAt(tok.hub, null)); } catch {}
        if (liveRate == null) { unavailable.push({ symbol: tok.symbol, reason: 'hub {state} unreadable' }); console.log(`  ✗ ${tok.symbol}: hub unreadable`); continue; }
        const points = [];
        for (const ts of targets) {
            const h = heightByTs.get(ts);
            try {
                const r = rateOf(await stateAt(tok.hub, h === t.height ? null : h));
                if (r != null && Number.isFinite(r) && r > 0) points.push([new Date(ts).toISOString().slice(0,10), r]);
            } catch (e) { /* skip this week */ }
        }
        // dedup by date, keep ascending
        const byDay = new Map(points.map(p => [p[0], p[1]]));
        const series = [...byDay.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
        if (!series.length) { unavailable.push({ symbol: tok.symbol, reason: 'no historical points resolved' }); continue; }
        tokensOut[tok.symbol] = { hub: tok.hub, base: tok.base, earliest_date: series[0][0], latest_date: series[series.length-1][0], point_count: series.length, granularity: 'weekly', points: series };
        console.log(`  ✓ ${tok.symbol.padEnd(8)} ${series.length} weekly points (${series[0][0]}→${series[series.length-1][0]})  latest rate ${series[series.length-1][1].toFixed(6)}`);
    }

    const out = { schemaVersion: SCHEMA_VERSION, builtAt: new Date().toISOString(), source: 'archive-lcd-state', note: 'LST_USD(day) = base_USD(day) × rate(day); join base from daily-prices.json', archive_lcd: ARCHIVE_LCD, weeks_requested: WEEKS, tokens: tokensOut, unavailable };
    await publish(`${YEAR_DIR}/data/ratio-history.json`, out, `ratio-history: ${Object.keys(tokensOut).length} tokens`);
    await publish(`${YEAR_DIR}/heartbeat-ratio.json`, { schemaVersion: SCHEMA_VERSION, capturedAt: new Date().toISOString(), status: errors.count()?'partial':'ok', token_count: Object.keys(tokensOut).length, unavailable_count: unavailable.length, error_count: errors.count() }, 'ratio heartbeat');
    console.log(`\n✅ published ratio-history — ${Object.keys(tokensOut).length} tokens, ${unavailable.length} unavailable`);
}

async function run() {
    console.log(`\n📈 ratio-history-backfill — ${new Date().toISOString()} — mode=${RUN_MODE}\n`);
    if (RUN_MODE === 'sample') await runSample(); else await runFull();
}
if (require.main === module) run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
module.exports = { rateOf };
