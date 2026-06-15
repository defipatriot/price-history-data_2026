// =============================================================================
// ratio-history-probe.js  —  discovery for the LST exchange-rate backfill
// =============================================================================
//
// Writes NOTHING. Discovers, per LST/compounder, how to read its exchange rate
// today AND how the rate changes over time (which tx action bumps it, and whether
// the event/state carries the numbers to recompute it). The output lets us build
// the real ratio-history backfill that computes LST_USD(day) = base_USD × ratio.
//
// For each token it:
//   1. resolves the rate-bearing contract:
//        cw20 LST  → query {minter:{}} on the cw20 → the hub
//        amp vault → the contract is the `factory/{creator}/…` creator address
//   2. probes current-state queries ({state}, {exchange_rate}, {config},
//      {share_value}, {total_supply}) and prints what each returns
//   3. tx_search recent txs on that contract → prints the distinct actions and,
//      for each, any event attributes that look rate-bearing (exchange_rate,
//      total_utoken/ustake, bonded, tvl, minted, share, utoken, etc.)
//
// Run it from the Actions tab (or locally) — no env needed beyond optional LCD
// overrides. Paste the output back and the real backfill gets built from it.
//
// Env: LCD_PRIMARY / LCD_FALLBACK (defaults below), SAMPLE_PAGES (default 1).
// =============================================================================

'use strict';

const https = require('https');

const LCD_PRIMARY  = process.env.LCD_PRIMARY  || 'https://terra-lcd.publicnode.com';
const LCD_FALLBACK = process.env.LCD_FALLBACK || 'https://terra-rest.publicnode.com';
const SAMPLE_PAGES = Number(process.env.SAMPLE_PAGES || 1);

// Candidate tokens. `kind:'cw20'` → resolve hub via {minter}. `kind:'vault'` →
// the id IS the vault contract (creator of the factory denom). Addresses lifted
// from tla-chain-registry/2026/current.json.
const CANDIDATES = [
    { symbol: 'ampLUNA', base: 'LUNA', kind: 'cw20',  id: 'terra1ecgazyd0waaj3g7l9cmy5gulhxkps2gmxu9ghducvuypjq68mq2s5lvsct' },
    { symbol: 'arbLUNA', base: 'LUNA', kind: 'cw20',  id: 'terra1se7rvuerys4kd2snt6vqswh9wugu49vhyzls8ymc02wl37g2p2ms5yz490' },
    { symbol: 'bLUNA',   base: 'LUNA', kind: 'cw20',  id: 'terra17aj4ty4sz4yhgm08na8drc0v03v2jwr3waxcqrwhajj729zhl7zqnpc0ml' },
    { symbol: 'ampROAR', base: 'ROAR', kind: 'vault', id: 'terra1vklefn7n6cchn0u962w3gaszr4vf52wjvd4y95t2sydwpmpdtszsqvk9wy' },
    { symbol: 'ampCAPA', base: 'CAPA', kind: 'vault', id: 'terra186rpfczl7l2kugdsqqedegl4es4hp624phfc7ddy8my02a4e8lgq5rlx7y' },
];

const RATE_KEYS = ['exchange_rate', 'exchangerate', 'total_utoken', 'total_ustake', 'utoken', 'ustake', 'bonded', 'tvl', 'minted', 'share', 'amount', 'total_shares', 'total_assets'];

function httpGet(url, t = 20000) {
    return new Promise((res, rej) => {
        const r = https.get(url, { headers: { Accept: 'application/json', 'User-Agent': 'aDAO-ratio-probe/1.0' } }, (x) => {
            let b = ''; x.on('data', c => b += c); x.on('end', () => {
                if (x.statusCode >= 200 && x.statusCode < 300) { try { res(JSON.parse(b)); } catch { rej(new Error('bad JSON')); } }
                else rej(new Error(`HTTP ${x.statusCode} ${b.slice(0, 140)}`)); });
        });
        r.on('error', rej); r.setTimeout(t, () => r.destroy(new Error('timeout')));
    });
}
async function lcdGet(p) { try { return await httpGet(LCD_PRIMARY + p); } catch (e) { return await httpGet(LCD_FALLBACK + p); } }
async function smartQuery(contract, q) {
    const b64 = Buffer.from(JSON.stringify(q)).toString('base64');
    const r = await lcdGet(`/cosmwasm/wasm/v1/contract/${contract}/smart/${b64}`);
    return r?.data;
}
async function tryQuery(contract, q) { try { return { ok: true, data: await smartQuery(contract, q) }; } catch (e) { return { ok: false, err: e.message.slice(0, 80) }; } }

function rateAttrs(tr) {
    const hits = [];
    for (const ev of tr?.events || []) {
        if (ev.type !== 'wasm' && ev.type !== 'reply') continue;
        for (const kv of ev.attributes || []) {
            const k = String(kv.key || '').toLowerCase();
            if (RATE_KEYS.some(rk => k.includes(rk)) && k !== 'amount') hits.push(`${kv.key}=${kv.value}`);
        }
    }
    return hits;
}

async function probeContract(label, contract) {
    console.log(`\n   contract: ${contract}`);
    // current-state queries
    for (const q of [{ state: {} }, { exchange_rate: {} }, { config: {} }, { share_value: { amount: '1000000' } }, { total_supply: {} }]) {
        const name = Object.keys(q)[0];
        const r = await tryQuery(contract, q);
        if (r.ok) console.log(`   ✓ {${name}} → ${JSON.stringify(r.data).slice(0, 260)}`);
        else console.log(`   ✗ {${name}} → ${r.err}`);
    }
    // recent tx actions + rate-bearing attrs
    const qstr = encodeURIComponent(`wasm._contract_address='${contract}'`);
    let resp = null;
    try { resp = await lcdGet(`/cosmos/tx/v1beta1/txs?query=${qstr}&order_by=ORDER_BY_DESC&page=1&limit=100`); }
    catch (e) { console.log(`   ✗ tx_search failed: ${e.message}`); return; }
    const txs = resp?.tx_responses || [];
    console.log(`   tx_search: total=${resp?.total ?? 'n/a'}, sampling ${txs.length}`);
    const actionCounts = {}, actionSample = {}, attrSample = {};
    for (const tr of txs) {
        for (const m of tr?.tx?.body?.messages || []) {
            const msg = m?.msg; if (!msg || typeof msg !== 'object') continue;
            const key = Object.keys(msg)[0]; if (!key) continue;
            actionCounts[key] = (actionCounts[key] || 0) + 1;
            if (!actionSample[key]) actionSample[key] = JSON.stringify(msg[key]).slice(0, 120);
            if (!attrSample[key]) { const hits = rateAttrs(tr); if (hits.length) attrSample[key] = hits.slice(0, 6); }
        }
    }
    console.log(`   actions: ${JSON.stringify(actionCounts)}`);
    for (const k of Object.keys(actionSample)) {
        console.log(`     • ${k}  msg=${actionSample[k]}`);
        if (attrSample[k]) console.log(`        rate-attrs: ${attrSample[k].join('  ')}`);
    }
}

async function run() {
    console.log(`\n🔬 ratio-history-probe — ${new Date().toISOString()} — writes nothing\n`);
    for (const c of CANDIDATES) {
        console.log(`\n══════════ ${c.symbol}  (base ${c.base}, ${c.kind})  id=${c.id}`);
        let contract = c.id;
        if (c.kind === 'cw20') {
            const mr = await tryQuery(c.id, { minter: {} });
            if (mr.ok) { contract = mr.data?.minter || c.id; console.log(`   {minter} → hub = ${contract}`); }
            else { console.log(`   ✗ {minter} failed (${mr.err}) — probing the cw20 itself`); }
            // also show token_info for current supply
            const ti = await tryQuery(c.id, { token_info: {} });
            if (ti.ok) console.log(`   token_info: ${JSON.stringify(ti.data).slice(0, 160)}`);
        }
        await probeContract(c.symbol, contract);
    }
    console.log(`\n\nDone. Paste this whole log back — the {state}/{exchange_rate} shape + the`);
    console.log(`rate-bearing action (harvest/reinvest/bond/donate…) tell us how to rebuild`);
    console.log(`each daily ratio from the tx log. (xASTRO is on Neutron/Astroport — handled separately.)`);
}

if (require.main === module) run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
