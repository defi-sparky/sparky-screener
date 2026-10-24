const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { execFile } = require('child_process');

// ---- env: ./.env first, then ~/.config/gmgn/.env (the CLI reads that one too)
for (const f of [path.join(__dirname, '..', '.env'), path.join(os.homedir(), '.config/gmgn/.env')]) {
  try { for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = l.match(/^\s*([A-Z_]+)\s*=\s*"?([^"\r]*)"?/); if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  } } catch {}
}
const KEY = process.env.GMGN_API_KEY, PORT = process.env.PORT || 3000;   // GMGN is optional now (smart money, snipers, bundlers)
const RC_KEY = process.env.RUGCHECK_API_KEY, RC_HEADER = process.env.RUGCHECK_HEADER || 'X-API-KEY';

// ---- GMGN field names (best effort from the public docs; verify with /api/debug/<address>)
// Rates are treated as fractions (0.25 = 25%). Flip FRACTION if your debug output shows percents.
const FRACTION = true;
const FIELDS = {
  honeypot: /honeypot/i, rug: /rug_ratio/i,
  mintRenounced: /renounced_mint|mint_renounced/i, freezeRenounced: /renounced_freeze|freeze_renounced/i,
  top10: /top_?10.*(rate|ratio|percent)/i, dev: /(dev|creator).*(hold|percent|rate|ratio)/i,
  holders: /^holder_count$/i, ath: /^ath.*market_cap$|^ath_mc$/i,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const s10 = (x, lo, hi) => clamp(10 * (x - lo) / (hi - lo), 0, 10);
const n = x => (x == null || x === '' || isNaN(+x)) ? null : +x;
const pct = v => v == null ? null : (FRACTION ? v * 100 : v);

function find(o, re, d = 0) {            // first scalar whose key matches, searching nested objects
  if (!o || typeof o !== 'object' || d > 4) return undefined;
  for (const [k, v] of Object.entries(o)) if (re.test(k) && (v === null || typeof v !== 'object')) return v;
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Array.isArray(v)) { const r = find(v, re, d + 1); if (r !== undefined) return r; }
}
const isFalse = v => v === false || v === 0 || v === '0' || v === 'false';
const isTrue = v => v === true || v === 1 || v === '1' || v === 'true';

function gm(args) {
  return new Promise((resolve, reject) => {
    execFile('gmgn-cli', [...args, '--raw'], { timeout: 25000, env: process.env, shell: process.platform === 'win32', maxBuffer: 8e6 },
      (err, out) => { if (err) return reject(new Error((out || err.message).toString().slice(0, 160)));
        try { const j = JSON.parse(out); resolve(j.data ?? j); } catch { reject(new Error('GMGN returned non-JSON')); } });
  });
}
async function j(u) { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(r.status + ' ' + new URL(u).host); return r.json(); }

// ---- candidate sources (no keys needed)
const fromGecko = d => { const a = d.attributes, t = h => a.transactions?.[h] || {};
  return { pool: a.address, addr: (d.relationships?.base_token?.data?.id || '').replace('solana_', ''), sym: (a.name || '').split(' / ')[0],
    mc: n(a.market_cap_usd) || n(a.fdv_usd), liq: n(a.reserve_in_usd) || 0, v1: n(a.volume_usd?.h1) || 0, v24: n(a.volume_usd?.h24) || 0,
    mk: t('h24').buyers != null ? t('h24').buyers + (t('h24').sellers || 0) : null, m30b: t('m30').buys ?? null,
    b24: t('h24').buys || 0, s24: t('h24').sells || 0, t1: (t('h1').buys || 0) + (t('h1').sells || 0),
    ch24: n(a.price_change_percentage?.h24) || 0, created: a.pool_created_at ? Date.parse(a.pool_created_at) : 0 }; };
const fromDex = p => ({ pool: p.pairAddress, addr: p.baseToken.address, sym: p.baseToken.symbol, name: p.baseToken.name, info: p.info, mk: null, m30b: null, mc: p.marketCap || p.fdv, liq: p.liquidity?.usd || 0,
  v1: p.volume?.h1 || 0, v24: p.volume?.h24 || 0, b24: p.txns?.h24?.buys || 0, s24: p.txns?.h24?.sells || 0,
  t1: (p.txns?.h1?.buys || 0) + (p.txns?.h1?.sells || 0), ch24: p.priceChange?.h24 || 0, created: p.pairCreatedAt || 0 });
async function candidates(mode, q) {
  if (mode === 'search') return ((await j('https://api.dexscreener.com/latest/dex/search?q=' + encodeURIComponent(q))).pairs || []).filter(p => p.chainId === 'solana').map(fromDex);
  const g = await j(`https://api.geckoterminal.com/api/v2/networks/solana/${mode === 'new' ? 'new_pools' : 'trending_pools'}?page=1`);
  return (g.data || []).map(fromGecko);
}

// ---- technical analysis: RSI(14) + Fibonacci retracement
function rsi(cl, k = 14) { if (cl.length < k + 1) return null; let g = 0, l = 0;
  for (let i = 1; i <= k; i++) { const d = cl[i] - cl[i - 1]; d >= 0 ? g += d : l -= d } g /= k; l /= k;
  for (let i = k + 1; i < cl.length; i++) { const d = cl[i] - cl[i - 1]; g = (g * (k - 1) + Math.max(d, 0)) / k; l = (l * (k - 1) + Math.max(-d, 0)) / k }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l); }
const ema = (a, k) => { const m = 2 / (k + 1); let e = a[0]; return a.map((v, i) => i ? (e = v * m + e * (1 - m)) : e); };
function macd(cl) {
  const e12 = ema(cl, 12), e26 = ema(cl, 26), line = e12.map((v, i) => v - e26[i]), sig = ema(line, 9), hist = line.map((v, i) => v - sig[i]), L = cl.length - 1;
  let cross = false; for (let i = Math.max(1, L - 4); i <= L; i++) if (line[i - 1] <= sig[i - 1] && line[i] > sig[i]) cross = true;
  return { hist: hist[L], prev: hist[L - 1], cross };
}
function kdj(cs, k = 9) {
  let K = 50, D = 50, J = 50;
  for (let i = 0; i < cs.length; i++) { const w = cs.slice(Math.max(0, i - k + 1), i + 1), hh = Math.max(...w.map(c => c[2])), ll = Math.min(...w.map(c => c[3]));
    const rsv = hh === ll ? 50 : (cs[i][4] - ll) / (hh - ll) * 100; K = 2 / 3 * K + rsv / 3; D = 2 / 3 * D + K / 3; J = 3 * K - 2 * D; }
  return { k: K, d: D, j: J };
}
async function chart(p, tf) {
  const [unit, agg] = tf.split(':'), mins = unit === 'hour' ? 60 * agg : +agg;
  const g = await j(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.pool}/ohlcv/${unit}?aggregate=${agg}&limit=200&currency=usd`);
  const cs = (g.data?.attributes?.ohlcv_list || []).slice().reverse(); if (cs.length < 30) return null;
  const len = cs.length, cl = cs.map(c => c[4]), last = cl[len - 1]; let hi = -1, lo = Infinity, hiI = 0, loI = 0;
  cs.forEach((c, i) => { if (c[2] > hi) { hi = c[2]; hiI = i } if (c[3] < lo) { lo = c[3]; loI = i } });
  const R = rsi(cl), rng = hi - lo, up = hiI > loI, M = x => p.mc * x / last; if (!rng || R == null) return null;
  const f = r => hi - rng * r, zTop = f(.5), zBot = f(.618), sl = f(.786) * .97;
  const inZone = up && last <= zTop * 1.03 && last >= sl;
  // dump patterns: one big green candle into the high, then -80% with no bounce / support held for 1h+ after a dump
  const after = cs.slice(hiI), minAfter = Math.min(...after.map(c => c[3])), minI = hiI + after.findIndex(c => c[3] === minAfter);
  let bigGreen = false; for (let i = Math.max(0, hiI - 3); i <= hiI; i++) if (cs[i][4] / cs[i][1] - 1 >= .5) bigGreen = true;
  const bounced = last / minAfter - 1 >= .25, devDumped = bigGreen && last / hi - 1 <= -.8 && !bounced;
  const dumpedAny = minAfter / hi - 1 <= -.5, holdsSupport = dumpedAny && !devDumped && (len - 1 - minI) * mins >= 60 && last >= minAfter * .98;
  return { rsi: R, up, inZone, above: up && last > zTop * 1.03, eLo: M(zBot), eHi: M(zTop), sl: M(sl), macd: macd(cl), kdj: kdj(cs), devDumped, holdsSupport, dumpedAny };
}

// ---- holder history, to tell whether holders are growing between checks
const HF = process.env.VERCEL ? '/tmp/.holders.json' : path.join(__dirname, '..', '.holders.json'); let HIST = {};
try { HIST = JSON.parse(fs.readFileSync(HF, 'utf8')); } catch {}
function holdersGrowing(ca, h) {
  if (h == null) return null;
  const now = Date.now(), arr = (HIST[ca] ||= []);
  const ref = arr.find(x => now - x.t >= 10 * 60e3 && now - x.t <= 24 * 36e5);
  if (!arr.length || now - arr.at(-1).t > 5 * 60e3) { arr.push({ t: now, h }); if (arr.length > 30) arr.shift();
    const ks = Object.keys(HIST); if (ks.length > 500) delete HIST[ks[0]]; try { fs.writeFileSync(HF, JSON.stringify(HIST)); } catch {} }
  return ref ? h > ref.h : null;
}

// ---- the original Memecoin Hunter report: Whale + Dev + Team + Chart = /40
function hunter(p, o, x) {
  const { R, dev, lp, mintOn, freezeOn, ch } = x, H = o.holders, V = p.v24, T = p.b24 + p.s24, mk = p.mk, notes = [];
  // 1. whale check
  const inC = H != null && H > 2000 && V > 1e6 && T > 2e4, outC = H != null && H < 800 && V < 2e5;
  let ws = inC ? 8 + clamp((H / 2000 + V / 1e6 + T / 2e4) / 3 - 1, 0, 1) * 2
    : outC ? 1 + 3 * clamp((H / 800 + V / 2e5) / 2, 0, 1)
    : 4 + (s10(H ?? 0, 800, 2000) + s10(V, 2e5, 1e6) + s10(T, 0, 2e4)) / 30 * 3.9;
  if (o.top10Flow === 'selling') ws -= 2; else if (o.top10Flow === 'buying') ws += 1;
  ws = clamp(ws, 0, 10);
  const whale = { score: ws, label: inC || (!outC && ws >= 7) ? 'WHALE IN' : 'WHALE OUT', holders: H, makers: mk, volPerMaker: mk ? V / mk : null,
    holdPerMaker: mk && H != null ? H / mk : null, txs: T, flow: o.top10Flow || null, profit: o.top10Profit || null };
  // 2. dev check
  const creatorRug = (R?.risks || []).some(r => /creator.*(rug|histor)|rugged/i.test(r.name || ''));
  const devSold = !!R && !!R.creator && n(R.creatorBalance) === 0;
  let ds = 5;
  if (dev != null) { if (dev < 5) ds += 2; else { ds -= 2; notes.push(`Dev holds ${dev.toFixed(1)}%`); } }
  if (lp != null) ds += lp >= 50 ? 1.5 : -2;
  if (mintOn === false && freezeOn === false) ds += 1;
  if (devSold) { ds -= 5; notes.push('Dev wallet holds 0 (sold out, or never held)'); }
  if (creatorRug) { ds -= 4; notes.push('Creator has a rug history'); }
  if (ch?.devDumped) { ds -= 5; notes.push('One big green candle then -80% with no bounce: DEV DUMPED'); }
  if (ch?.holdsSupport) { ds += 1.5; notes.push('Price held support for 1h+ after the dump'); }
  ds = clamp(ds, 0, 10);
  const badDev = devSold || creatorRug || !!ch?.devDumped || ds < 4;
  const devR = { score: ds, label: badDev ? 'BAD DEV / RUG RISK' : ds >= 6 ? 'GOOD DEV' : 'UNCLEAR (missing data)', dev, lp, dumped: !!ch?.devDumped, support: !!ch?.holdsSupport, notes };
  // 3. team / community
  const grow = holdersGrowing(p.addr, H);
  let ts, tl;
  if (grow === true && mk > 5000) { ts = 8 + clamp(mk / 5000 - 1, 0, 1) * 2; tl = 'STRONG TEAM'; }
  else if (H >= 1000 && H <= 3000 && T > 15000) { ts = 6 + clamp(T / 15000 - 1, 0, 1); tl = 'ACTIVE TEAM'; }
  else if (H != null && H < 500 && T < 5000) { ts = 1 + 2 * clamp((H / 500 + T / 5000) / 2, 0, 1); tl = 'DEAD TEAM'; }
  else { ts = 3 + (s10(H ?? 0, 0, 3000) + s10(T, 0, 2e4)) / 20 * 3 + (grow ? 1 : 0); tl = 'AVERAGE TEAM'; }
  const team = { score: clamp(ts, 0, 10), label: tl, growing: grow };
  // 4. alive or dead
  const noBuys30 = p.m30b != null ? p.m30b === 0 : null, dropping = p.t1 < (T / 24) * .7;
  const checks = { vol: V > 5e5, tx1h: p.t1 > 1e4, holders: H != null && H > 1000, ath: o.ath != null && o.ath > -85 };
  const state = (V < 2e4 && noBuys30 === true && o.ath != null && o.ath <= -90) ? 'DEAD' : Object.values(checks).every(Boolean) ? 'ALIVE' : 'DYING';
  const alive = { state, checks, noBuys30, dropping, dyingMatch: V < 1e5 && dropping && grow !== true };
  // 5. chart (MACD, KDJ, RSI, trend)
  let cs = 3;
  if (ch) { cs = 5; const m = ch.macd, k = ch.kdj;
    cs += m.hist > 0 ? 1.5 : -1; if (m.cross) cs += 1.5; if (m.hist > m.prev) cs += .5;
    if (k.k > k.d) cs += 1; if (k.j < 20) cs += .5; if (k.j > 100) cs -= 1.5;
    if (ch.rsi > 70) cs -= 2; else if (ch.rsi >= 40 && ch.rsi <= 60) cs += 1;
    cs += ch.up ? 1 : -2; if (ch.devDumped) cs -= 3; }
  const chartR = { score: clamp(cs, 0, 10), macd: ch?.macd || null, kdj: ch?.kdj || null, rsi: ch?.rsi ?? null, signal: o.signal || null };
  // final verdict
  const total = whale.score + devR.score + team.score + chartR.score;
  const verdict = total >= 27 ? 'STRONG BUY' : total >= 22 ? 'GAMBLE / QUICK SCALP ONLY' : "DON'T BUY";
  const m = verdict === 'STRONG BUY' ? [2, 5] : [1.3, 1.6];
  const levels = verdict === "DON'T BUY" ? null : { entry: o.entry, entryLo: o.entryLo, entryHi: o.entryHi, tp1: o.entry * m[0], tp2: o.entry * m[1], sl: o.sl };
  return { whale, dev: devR, team, alive, chart: chartR, total, verdict, levels };
}

// ---- RugCheck: authorities, top holders, insiders, LP lock, creator balance
async function rc(mint) {
  const url = `https://api.rugcheck.xyz/v1/tokens/${mint}/report`, h = { accept: 'application/json' };
  if (RC_KEY) h[RC_HEADER] = RC_KEY;
  let r = await fetch(url, { headers: h });
  if ((r.status === 401 || r.status === 403) && RC_KEY) r = await fetch(url, { headers: { accept: 'application/json' } }); // read endpoints are public
  if (!r.ok) throw new Error('RugCheck ' + r.status); return r.json();
}
// All-time high from daily candles (everything since the pool was created)
async function athOf(p) {
  const g = await j(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.pool}/ohlcv/day?aggregate=1&limit=1000&currency=usd`);
  const cs = g.data?.attributes?.ohlcv_list || []; if (!cs.length) return null;
  const hi = Math.max(...cs.map(c => c[2])), last = cs[0][4]; return hi > 0 && last > 0 ? { pct: (last / hi - 1) * 100, mc: p.mc * hi / last } : null;
}

// ---- the scoring from the prompt (score /50, hard filters first)
async function analyze(p, tf, fast) {
  const nap = () => sleep(fast ? 500 : 2200);
  const o = { sym: p.sym, addr: p.addr, mc: p.mc, liq: p.liq, v24: p.v24, ch24: p.ch24, ageH: p.created ? (Date.now() - p.created) / 36e5 : null };
  const miss = [], rej = [], warn = [], notes = [];
  o.vmc = p.mc ? p.v24 / p.mc * 100 : 0;
  const t24 = p.b24 + p.s24, buyR = t24 ? p.b24 / t24 : .5;

  let R = null; try { R = await rc(p.addr); } catch (e) { miss.push('RugCheck'); o.err = e.message; }
  let top10 = null, insider = null, dev = null, lp = null, mintOn = null, freezeOn = null;
  if (R) {
    const mk = new Set(); (R.markets || []).forEach(m => [m.pubkey, m.liquidityA, m.liquidityB, m.mintLP].forEach(x => x && mk.add(x)));
    const hs = (R.topHolders || []).filter(h => !mk.has(h.address) && !mk.has(h.owner));   // drop pool accounts
    if (hs.length) { top10 = hs.slice(0, 10).reduce((a, h) => a + (n(h.pct) || 0), 0); insider = hs.filter(h => h.insider).reduce((a, h) => a + (n(h.pct) || 0), 0); }
    const sup = n(R.token?.supply), cb = n(R.creatorBalance); if (sup > 0 && cb != null) dev = cb / sup * 100;
    const lps = (R.markets || []).map(m => n(m.lp?.lpLockedPct)).filter(x => x != null); if (lps.length) lp = Math.max(...lps);
    if (R.token) { mintOn = R.token.mintAuthority != null; freezeOn = R.token.freezeAuthority != null; }
    if (R.rugged) rej.push('Flagged rugged');
    (R.risks || []).filter(x => x.level === 'danger').forEach(x => warn.push(x.name));
    if (top10 == null) miss.push('holders'); if (dev == null) miss.push('dev');
  }
  // token fee (Token-2022 transfer fee) and narrative (on-chain metadata + socials)
  if (R) {
    o.fee = n(R.transferFee?.pct) ?? 0; o.name = R.tokenMeta?.name || p.name; o.holders = n(R.totalHolders);
    try { const uri = R.tokenMeta?.uri, url = uri && new URL(uri.replace('ipfs://', 'https://ipfs.io/ipfs/'));
      if (url && url.protocol === 'https:' && !/^(localhost|\d+\.\d+\.\d+\.\d+|\[)/.test(url.hostname))
        o.desc = String((await (await fetch(url, { signal: AbortSignal.timeout(6000) })).json()).description || '').slice(0, 400);
    } catch {}
  }
  o.links = [...(p.info?.websites || []).map(w => ({ l: 'Website', u: w.url })), ...(p.info?.socials || []).map(x => ({ l: x.type, u: x.url }))];
  // optional GMGN layer: smart money, snipers, bundlers
  let sniper = null, bundler = null, smart = null;
  if (KEY) try {
    const h = await gm(['token', 'holders', '--chain', 'sol', '--address', p.addr]);
    const list = Array.isArray(h) ? h : (h?.list || h?.holders || []);
    const tg = re => list.filter(x => re.test(JSON.stringify(Object.entries(x).filter(([k]) => /tag/i.test(k)))));
    const sh = arr => arr.reduce((a, x) => a + (pct(n(x.amount_percentage)) || 0), 0);
    if (list.length) { sniper = sh(tg(/sniper/i)); bundler = sh(tg(/bundl/i)); smart = tg(/smart_degen|renowned/i).length;
      const top = list.slice(0, 10), gv = (x, re) => n(find(x, re));   // top 10 holders: in profit? buying or selling?
      const pnl = top.map(x => [gv(x, /^unrealized_profit$/), gv(x, /^realized_profit$/)]).filter(a => a[0] != null || a[1] != null);
      if (pnl.length) o.top10Profit = { up: pnl.filter(a => (a[0] || 0) + (a[1] || 0) > 0).length, of: pnl.length };
      const fl = top.map(x => [gv(x, /buy_volume/), gv(x, /sell_volume/)]).filter(a => a[0] != null && a[1] != null);
      if (fl.length) { const bu = fl.reduce((t, a) => t + a[0], 0), se = fl.reduce((t, a) => t + a[1], 0); o.top10Flow = se > bu ? 'selling' : 'buying'; }
    }
  } catch (e) { o.gmgnErr = e.message; }
  const crowd = (sniper || 0) + (insider || 0) + (bundler || 0);
  Object.assign(o, { top10, insider, sniper, bundler, smart, dev, lp });

  const bad = (c, why) => c && rej.push(why);
  bad(mintOn === true, 'Mint authority active'); bad(freezeOn === true, 'Freeze authority active');
  bad(lp != null && lp < 50, 'LP not locked/burned'); bad(dev != null && dev > 5, 'Dev holds > 5%'); bad(top10 != null && top10 > 35, 'Top 10 > 35%');
  bad(crowd > 25, 'Insiders/snipers/bundlers > 25%'); bad(p.liq < 15000 || (p.mc && p.liq / p.mc < .05), 'Thin liquidity');

  // % from ATH (daily candles since pool creation)
  try { const a = await athOf(p); if (a) { o.ath = a.pct; o.athMc = a.mc; } await nap(); } catch (e) { notes.push('ATH: ' + e.message); }
  if (o.ath == null) miss.push('ATH');
  if (p.mk == null && p.pool) try {                     // makers (unique traders) and 30m buys
    const t = (await j(`https://api.geckoterminal.com/api/v2/networks/solana/pools/${p.pool}`)).data?.attributes?.transactions || {};
    if (t.h24?.buyers != null) p.mk = t.h24.buyers + (t.h24.sellers || 0); p.m30b = t.m30?.buys ?? null; await nap();
  } catch (e) { notes.push('Makers: ' + e.message); }
  o.makers = p.mk;
  bad(o.ath != null && o.ath <= -80, 'Down 80%+ from ATH'); bad(p.ch24 <= -80, 'Down 80%+ in 24h');

  // room to run, demand, smart money, distribution + dev, chart
  let room = p.mc < 3e5 ? 9 : p.mc < 1e6 ? 6 : p.mc < 5e6 ? 3 : 1;
  if (o.ageH != null) room += o.ageH >= 1 && o.ageH <= 48 ? 1 : o.ageH > 168 ? -2 : 0;
  room = clamp(room, 0, 10);
  const demand = (s10(o.vmc, 0, 50) + s10(buyR, .45, .6) + s10(t24, 0, 10000)) / 3;
  const sm = smart == null ? null : s10(smart, 0, 3);
  const dist = (top10 == null && dev == null) ? 4 : 10 - clamp(((top10 ?? 20) - 10) / 25 * 5, 0, 5) - clamp(crowd / 25 * 3, 0, 3) - clamp((dev || 0) / 5 * 2, 0, 2);
  let ch = null, cs = 3;
  try { ch = await chart(p, tf); await nap(); } catch (e) { notes.push('Candles: ' + e.message); }
  if (ch) { cs = ch.rsi > 70 ? 3 : ch.rsi >= 40 && ch.rsi <= 60 ? 9 : ch.rsi < 30 ? 5 : 6; if (ch.inZone) cs += 1; if (!ch.up) cs -= 3; cs = clamp(cs, 0, 10); }
  else miss.push('candles');
  o.scores = { room, demand, smart: sm, dist, chart: cs };
  const base = room + demand + dist + cs;
  o.total = sm == null ? base * 1.25 : base + sm;          // no smart-money data: scale the other four checks to /50
  if (sm == null) notes.push('No smart-money data (needs GMGN); total scaled from 4 checks.');
  o.state = (p.v24 < 20000 || p.t1 < 5 || p.ch24 <= -90) ? 'DEAD' : (p.v1 > 100000 && p.t1 > 1000 && p.ch24 > -85) ? 'ALIVE' : 'DYING';
  o.verdict = rej.length ? 'REJECT' : o.total >= 40 ? 'HIGH' : o.total >= 32 ? 'MEDIUM' : 'SKIP';
  if (ch) { o.rsi = ch.rsi; o.signal = ch.up ? (ch.inZone ? 'In buy zone' : ch.above ? 'Wait for pullback' : 'Broke down') : 'Downtrend';
    o.entry = ch.up && !ch.above ? (ch.eLo + ch.eHi) / 2 : p.mc; o.entryLo = ch.eLo; o.entryHi = ch.eHi; o.sl = ch.sl;
  } else { o.entry = p.mc; o.sl = p.mc * .8; }
  o.tp1 = o.entry * 2; o.tp2 = o.entry * 5; o.tp3 = o.entry * 10;
  if (o.verdict === 'HIGH') notes.push('Aim for 5x to 10x; sell half at TP1.'); if (o.verdict === 'MEDIUM') notes.push('Scalp: aim for 2x to 4x.');
  o.h = hunter(p, o, { R, dev, lp, mintOn, freezeOn, ch }); o.state = o.h.alive.state;
  if (p.mk == null) miss.push('makers'); if (o.holders == null) miss.push('holders');
  o.rej = rej; o.miss = miss; o.warn = warn; o.notes = notes; return o;
}

// ---- server
const handler = async (req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/api/scan') {
    res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
    try {
      const list = (await candidates(u.searchParams.get('mode') || 'trend', u.searchParams.get('q') || '')).filter(p => p.addr && p.pool)
        .slice(0, clamp(+u.searchParams.get('limit') || 10, 1, 20));
      res.write(JSON.stringify({ meta: { total: list.length, hasKey: !!KEY } }) + '\n');
      for (const p of list) { if (res.destroyed) break; res.write(JSON.stringify(await analyze(p, u.searchParams.get('tf') || 'minute:15')) + '\n'); }
    } catch (e) { res.write(JSON.stringify({ error: e.message }) + '\n'); }
    return res.end();
  }
  if (u.pathname === '/api/list') {                       // candidate addresses only (the page then checks them one by one)
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    try { const l = (await candidates(u.searchParams.get('mode') || 'trend', u.searchParams.get('q') || '')).filter(p => p.addr && p.pool);
      return res.end(JSON.stringify({ list: [...new Set(l.map(p => p.addr))].slice(0, clamp(+u.searchParams.get('limit') || 10, 1, 20)) }));
    } catch (e) { return res.end(JSON.stringify({ error: e.message })); }
  }
  if (u.pathname === '/api/token') {                      // single contract address lookup
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    const ca = (u.searchParams.get('ca') || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return res.end(JSON.stringify({ error: 'That does not look like a Solana token address.' }));
    try {
      const pairs = await j('https://api.dexscreener.com/tokens/v1/solana/' + ca);
      const best = (pairs || []).filter(p => p.baseToken.address === ca).sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
      if (!best) return res.end(JSON.stringify({ error: 'No Solana trading pair found for this address yet.' }));
      return res.end(JSON.stringify(await analyze(fromDex(best), u.searchParams.get('tf') || 'minute:15', true)));
    } catch (e) { return res.end(JSON.stringify({ error: e.message })); }
  }
  if (u.pathname.startsWith('/api/debug')) {          // raw GMGN output, to verify field names
    const a = u.searchParams.get('ca') || u.pathname.split('/').pop(); res.writeHead(200, { 'content-type': 'application/json' });
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a)) return res.end('{"error":"bad address"}');
    const c = ['--chain', 'sol', '--address', a], out = {};
    out.rugcheck = await rc(a).catch(e => ({ error: e.message }));
    if (KEY) for (const k of ['info', 'security', 'holders']) out['gmgn_' + k] = await gm(['token', k, ...c]).catch(e => ({ error: e.message }));
    return res.end(JSON.stringify(out, null, 2));
  }
  const f = path.join(__dirname, '..', 'public', u.pathname === '/' ? 'index.html' : path.basename(u.pathname));
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': f.endsWith('.html') ? 'text/html' : 'text/plain' }); res.end(d); });
};

module.exports = { handler, hunter, macd, kdj, rsi, KEY, PORT };
