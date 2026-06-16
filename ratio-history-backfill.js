// =============================================================================
// ratio-history-backfill.js  —  exact historical LST/amp exchange rates
// =============================================================================
//
// Reads each hub/vault {state}.exchange_rate at PAST block heights on an ARCHIVE
// node — no accounting replay, no estimation. Probe (2026-06-15) confirmed every
// hub exposes {state}.exchange_rate; an archive node lets us read that same query
// at any past height. Two transports are supported, because public archive access
// on Terra is usually RPC, not LCD:
//   • lcd-header : GET the LCD smart-query with `x-cosmos-block-height: N`
//   • rpc-abci   : Tendermint RPC /abci_query?path=…&data=0x…&height=N (archive)
//
// MODE (RUN_MODE):
//   • survey (default) : test a LIST of candidate endpoints/methods and report
//     which one actually serves historical state (ampCAPA rate must vary across
//     heights). Writes nothing. Run this FIRST.
//   • full : build weekly ratio series for ampCAPA, ampROAR (+ optional LUNA
//     LSTs) using ARCHIVE_ENDPOINT + ARCHIVE_METHOD, and publish.
//
// Output (GITHUB_REPO=price-history-data_2026, 2026/):
//   data/ratio-history.json   { tokens:{ ampCAPA:{ hub, base, points:[[date,rate]] }…},
//                               unavailable:[] }   heartbeat-ratio.json
//   USD: LST_USD(day) = base_USD(day) × rate(day)  (join daily-prices.json).
//
// Env: RUN_MODE, ARCHIVE_ENDPOINT, ARCHIVE_METHOD (lcd-header|rpc-abci),
//   WEEKS (default 130), GITHUB_TOKEN/REPO/BRANCH.
// =============================================================================

'use strict';
const https = require('https');

let ErrorLog;
try { ({ ErrorLog } = require('../lib/error-reporter.js')); }
catch { ErrorLog = class { constructor(){this._e=[];} add(s,e){this._e.push({step:s,message:String(e&&e.message||e)});} count(){return this._e.length;} }; }

const RUN_MODE = (process.env.RUN_MODE || 'survey').toLowerCase();
const WEEKS    = Number(process.env.WEEKS || 130);
const ARCHIVE_ENDPOINT = process.env.ARCHIVE_ENDPOINT || '';      // set after survey for full
const ARCHIVE_METHOD   = process.env.ARCHIVE_METHOD   || '';      // 'lcd-header' | 'rpc-abci'
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO   || 'defipatriot/price-history-data_2026';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const YEAR_DIR = '2026'; const SCHEMA_VERSION = 1; const WEEK_MS = 7*864e5;

// Candidate archive endpoints to survey (method:endpoint). Edit/extend freely.
const CANDIDATES = [
    { method: 'rpc-abci',   endpoint: 'https://rpc-terra.tfl.foundation' },
    { method: 'rpc-abci',   endpoint: 'https://phoenix-rpc.terra.dev' },
    { method: 'rpc-abci',   endpoint: 'https://terra-rpc.publicnode.com' },
    { method: 'rpc-abci',   endpoint: 'https://terra-rpc.polkachu.com' },
    { method: 'lcd-header', endpoint: 'https://phoenix-lcd.terra.dev' },
    { method: 'lcd-header', endpoint: 'https://terra-lcd.publicnode.com' },
];

const TARGETS = [
    { symbol: 'ampCAPA', base: 'CAPA', hub: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y' },
    { symbol: 'ampROAR', base: 'ROAR', hub: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy' },
    { symbol: 'ampLUNA', base: 'LUNA', hub: 'terra10788fkzah89xrdm27zkj5yvhj9x3494lxawzm5qq3vvxcqz2yzaqyd3enk', optional: true },
    { symbol: 'bLUNA',   base: 'LUNA', hub: 'terra1l2nd99yze5fszmhl5svyh5fky9wm4nz4etlgnztfu4e8809gd52q04n3ea', optional: true },
    { symbol: 'arbLUNA', base: 'LUNA', hub: 'terra1r9gls56glvuc4jedsvc3uwh6vj95mqm9efc7hnweqxa2nlme5cyqxygy5m', optional: true },
];

// ----------------------------------------------------------------------------- http
function httpGet(url, headers = {}, t = 25000) {
    return new Promise((res, rej) => {
        const u = new URL(url);
        const r = https.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { Accept: 'application/json', 'User-Agent': 'aDAO-ratio/2.0', ...headers } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0,100)}`)); });
        });
        r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
    });
}

// ---- protobuf (only the two length-delimited fields we need) ----
function varint(n) { const b = []; while (n > 0x7f) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n); return Buffer.from(b); }
function readVarint(buf, i) { let v = 0, s = 0; while (buf[i] & 0x80) { v |= (buf[i] & 0x7f) << s; s += 7; i++; } v |= (buf[i] & 0x7f) << s; return [v >>> 0, i + 1]; }
// QuerySmartContractStateRequest{ address(1):string, query_data(2):bytes }
function encReq(address, queryObj) {
    const a = Buffer.from(address, 'utf8'), q = Buffer.from(JSON.stringify(queryObj), 'utf8');
    return Buffer.concat([Buffer.from([0x0a]), varint(a.length), a, Buffer.from([0x12]), varint(q.length), q]);
}
// QuerySmartContractStateResponse{ data(1):bytes } → the JSON result
function decResp(b64) {
    const buf = Buffer.from(b64, 'base64'); if (!buf.length || buf[0] !== 0x0a) return null;
    const [len, i] = readVarint(buf, 1); return JSON.parse(buf.slice(i, i + len).toString('utf8'));
}

// ---- transport: read a contract's {state} at an optional height ----
async function readState(method, endpoint, contract, height) {
    if (method === 'lcd-header') {
        const b64 = Buffer.from(JSON.stringify({ state: {} })).toString('base64');
        const headers = height ? { 'x-cosmos-block-height': String(height) } : {};
        const r = await httpGet(`${endpoint}/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`, headers);
        return r?.data;
    }
    // rpc-abci
    const dataHex = '0x' + encReq(contract, { state: {} }).toString('hex');
    const path = `/abci_query?path=%22/cosmwasm.wasm.v1.Query/SmartContractState%22&data=${dataHex}` + (height ? `&height=${height}` : '');
    const r = await httpGet(endpoint + path);
    const resp = r?.result?.response;
    if (!resp) throw new Error('no response');
    if (resp.code && resp.code !== 0) throw new Error(`abci code ${resp.code}: ${(resp.log||'').slice(0,80)}`);
    if (!resp.value) throw new Error('empty value');
    return decResp(resp.value);
}
function rateOf(state) {
    if (!state) return null;
    if (state.exchange_rate != null) return Number(state.exchange_rate);
    const u = state.total_utoken ?? state.total_uluna ?? state.total_native;
    const s = state.total_ustake ?? state.total_usteak ?? state.total_lp_supply;
    return (u != null && s) ? Number(u) / Number(s) : null;
}

// ---- block height ↔ time (uses the chosen endpoint) ----
async function tipHeight(method, endpoint) {
    if (method === 'rpc-abci') { const r = await httpGet(`${endpoint}/block`); const h = r.result.block.header; return { height: Number(h.height), time: Date.parse(h.time) }; }
    const r = await httpGet(`${endpoint}/cosmos/base/tendermint/v1beta1/blocks/latest`); return { height: Number(r.block.header.height), time: Date.parse(r.block.header.time) };
}
const btCache = new Map();
async function blockTime(method, endpoint, height) {
    if (btCache.has(height)) return btCache.get(height);
    let t;
    if (method === 'rpc-abci') { const r = await httpGet(`${endpoint}/block?height=${height}`); t = Date.parse(r.result.block.header.time); }
    else { const r = await httpGet(`${endpoint}/cosmos/base/tendermint/v1beta1/blocks/${height}`); t = Date.parse(r.block.header.time); }
    btCache.set(height, t); return t;
}
async function heightForTime(method, endpoint, targetMs, lo, hi) {
    let ans = lo;
    while (lo <= hi) { const mid = Math.floor((lo + hi) / 2); let bt; try { bt = await blockTime(method, endpoint, mid); } catch { lo = mid + 1; continue; } if (bt <= targetMs) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
    return ans;
}

// ----------------------------------------------------------------------------- github
function gh(method, apiPath, body) {
    return new Promise((resolve, reject) => {
        const opts = { hostname: 'api.github.com', path: apiPath, method, headers: { 'User-Agent': 'aDAO-ratio', Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' } };
        if (body) opts.headers['Content-Type'] = 'application/json';
        const req = https.request(opts, res => { let d=''; res.on('data',c=>d+=c); res.on('end',()=>{ if(res.statusCode>=200&&res.statusCode<300){try{resolve(JSON.parse(d));}catch{resolve(d);}}else reject(new Error(`GitHub ${res.statusCode} ${d.slice(0,120)}`)); }); });
        req.on('error', reject); if (body) req.write(JSON.stringify(body)); req.end();
    });
}
async function publish(path, obj, msg) {
    let sha=null; try { const dir=path.split('/').slice(0,-1).join('/'); const name=path.split('/').pop(); const list=await gh('GET',`/repos/${GITHUB_REPO}/contents/${dir}?ref=${GITHUB_BRANCH}`); const it=Array.isArray(list)?list.find(x=>x.name===name):null; sha=it?it.sha:null; } catch {}
    const body={ message:msg, branch:GITHUB_BRANCH, content:Buffer.from(JSON.stringify(obj,null,2)).toString('base64') }; if(sha) body.sha=sha;
    return gh('PUT', `/repos/${GITHUB_REPO}/contents/${path}`, body);
}

// ----------------------------------------------------------------------------- survey
async function runSurvey() {
    console.log('🔭 survey — testing candidate archive endpoints; writing nothing.\n');
    const hub = TARGETS.find(t => t.symbol === 'ampCAPA').hub;
    let winner = null;
    for (const c of CANDIDATES) {
        console.log(`  ${c.method.padEnd(10)} ${c.endpoint}`);
        let tip; try { tip = await tipHeight(c.method, c.endpoint); } catch (e) { console.log(`     ✗ unreachable: ${e.message}\n`); continue; }
        const heights = [null, tip.height - 500000, tip.height - 3000000, tip.height - 7000000];
        const rates = [];
        for (const h of heights) {
            try { const r = rateOf(await readState(c.method, c.endpoint, hub, h)); const when = h ? new Date(await blockTime(c.method,c.endpoint,h).catch(()=>0)).toISOString().slice(0,10) : 'now'; console.log(`     ${String(h ?? tip.height).padStart(9)} (${when})  rate=${r}`); rates.push(r); }
            catch (e) { console.log(`     ${String(h ?? '').padStart(9)}  ✗ ${e.message}`); rates.push(null); }
        }
        const valid = rates.filter(r => r != null);
        const varies = valid.length >= 2 && Math.max(...valid) - Math.min(...valid) > 1e-9;
        console.log(`     → ${varies ? '✅ ARCHIVE (rates vary)' : '❌ no historical variation'}\n`);
        if (varies && !winner) winner = c;
    }
    console.log(winner
        ? `WINNER: ARCHIVE_METHOD=${winner.method}  ARCHIVE_ENDPOINT=${winner.endpoint}\n→ re-run with mode=full and those two inputs set.`
        : `No archive endpoint served historical state. Options: (a) add a paid archive LCD/RPC to CANDIDATES, or (b) switch ampCAPA/ampROAR to forward-capture only.`);
}

// ----------------------------------------------------------------------------- full
async function runFull() {
    if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN missing.');
    if (!ARCHIVE_ENDPOINT || !ARCHIVE_METHOD) throw new Error('set ARCHIVE_ENDPOINT + ARCHIVE_METHOD (run survey first).');
    const m = ARCHIVE_METHOD, ep = ARCHIVE_ENDPOINT;
    const tip = await tipHeight(m, ep);
    const hub0 = TARGETS[0].hub; let floor = 1;
    for (const cand of [1,1000000,3000000,5000000,7000000,9000000,11000000].filter(h=>h<tip.height)) { try { await readState(m,ep,hub0,cand); floor=cand; break; } catch {} }
    const floorTime = await blockTime(m, ep, floor).catch(()=>tip.time);
    console.log(`   ${m} ${ep}\n   tip=${tip.height} (${new Date(tip.time).toISOString().slice(0,10)}) floor≈${floor} (${new Date(floorTime).toISOString().slice(0,10)})`);

    const targets = [];
    for (let i = WEEKS; i >= 0; i--) { const ts = tip.time - i*WEEK_MS; if (ts >= floorTime) targets.push(ts); }
    const heightByTs = new Map();
    for (const ts of targets) heightByTs.set(ts, ts >= tip.time ? tip.height : await heightForTime(m, ep, ts, floor, tip.height));

    const tokensOut = {}, unavailable = [];
    for (const tok of TARGETS) {
        let live=null; try { live = rateOf(await readState(m, ep, tok.hub, null)); } catch {}
        if (live == null) { unavailable.push({ symbol: tok.symbol, reason: 'hub {state} unreadable' }); console.log(`  ✗ ${tok.symbol}`); continue; }
        const byDay = new Map();
        for (const ts of targets) { const h = heightByTs.get(ts); try { const r = rateOf(await readState(m, ep, tok.hub, h >= tip.height ? null : h)); if (r>0 && Number.isFinite(r)) byDay.set(new Date(ts).toISOString().slice(0,10), r); } catch {} }
        const series = [...byDay.entries()].sort((a,b)=>a[0].localeCompare(b[0]));
        if (!series.length) { unavailable.push({ symbol: tok.symbol, reason: 'no historical points' }); continue; }
        tokensOut[tok.symbol] = { hub: tok.hub, base: tok.base, earliest_date: series[0][0], latest_date: series.at(-1)[0], point_count: series.length, granularity: 'weekly', points: series };
        console.log(`  ✓ ${tok.symbol.padEnd(8)} ${series.length} pts (${series[0][0]}→${series.at(-1)[0]}) latest ${series.at(-1)[1].toFixed(6)}`);
    }
    const out = { schemaVersion: SCHEMA_VERSION, builtAt: new Date().toISOString(), source: `${m}:${ep}`, note: 'LST_USD(day)=base_USD(day)×rate(day); join daily-prices.json', tokens: tokensOut, unavailable };
    await publish(`${YEAR_DIR}/data/ratio-history.json`, out, `ratio-history: ${Object.keys(tokensOut).length} tokens`);
    await publish(`${YEAR_DIR}/heartbeat-ratio.json`, { capturedAt: new Date().toISOString(), status: 'ok', token_count: Object.keys(tokensOut).length, unavailable_count: unavailable.length }, 'ratio heartbeat');
    console.log(`\n✅ published — ${Object.keys(tokensOut).length} tokens, ${unavailable.length} unavailable`);
}

async function run() {
    console.log(`\n📈 ratio-history-backfill — ${new Date().toISOString()} — mode=${RUN_MODE}\n`);
    if (RUN_MODE === 'full') await runFull(); else await runSurvey();
}
if (require.main === module) run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
module.exports = { rateOf, encReq, decResp };
