// Token Radar — the value model.
//
// One sealed snapshot in, one ranked board out. The board ranks every pre-token
// protocol the snapshot carries (the watchlist is the floor, never the ceiling)
// by the implied value of the token it does not yet record.
//
// The implied value is derived from the snapshot's own figures only:
//
//   peers      = protocols of the same category whose token already trades;
//                peerMultiple = median of their mcap_usd / tvl_usd
//   sizeCurve  = 0.9 x (tvl_usd / 1e8)^-0.18, clamped to [0.25, 2.2]
//                (smaller vaults of capital carry higher FDV/TVL multiples)
//   sectorMult = 0.55 x peerMultiple + 0.45 x sizeCurve
//   momentum   = 1 + 0.0035 x clamp(change_7d, -50, 100)   (null growth: 1.0)
//   tenure     = 0.55 + 0.45 x min(ageDays, 1460) / 1460   (unknown age: 0.75)
//   implied    = max(1, round(tvl_usd x sectorMult x momentum x tenure))
//
// No protocol name is ever special-cased: the same function scores every row.

export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

export const MODEL_VERSION = 'radar-m2';
export const MODEL_CONSTANTS = {
  peer_weight: 0.55,
  size_weight: 0.45,
  size_curve_coef: 0.9,
  size_curve_exp: -0.18,
  size_min: 0.25,
  size_max: 2.2,
  momentum_coef: 0.0035,
  momentum_floor: -50,
  momentum_cap: 100,
  tenure_floor: 0.55,
  tenure_range: 0.45,
  tenure_days: 1460,
  unknown_tenure: 0.75,
} as const;

const DAY_MS = 86_400_000;
const GROWTH_SLOPE = 1.2; // points of growth that count as one step of momentum

export interface Factors {
  peer_multiple: number | null;
  peer_count: number;
  size_curve: number;
  sector_multiple: number;
  growth_pct: number | null;
  momentum: number;
  tenure: number;
  age_days: number | null;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (!listedAt) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

// A name ending in a release marker is a pool of a protocol, not a protocol of its own.
const VERSIONED = /\s(?:V\d+(?:\.\d+)?|v\d+(?:\.\d+)?|\d+\.\d+)$/;

const POOL_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const WRAP_WORDS = /\b(?:wrapped|staked|staking|bridged)\b/i;
const EXCHANGES = /^(?:binance|coinbase|bybit|kraken|bitget|okx|bitfinex|gemini)\b/i;

// A board row names a protocol of its own, never a wrapped, staked or bridged wrapper of
// one whose token already trades: the same exclusions that built the watchlist's rule.
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p)
    && !POOL_CATEGORIES.has(p.category ?? '')
    && !VERSIONED.test(p.name)
    && !WRAP_WORDS.test(p.name)
    && !EXCHANGES.test(p.name);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Peer mcap/TVL medians per category, plus the global fallback. */
export function peerMultiples(protocols: SnapshotProtocol[]): { byCategory: Record<string, number>; global: number; counts: Record<string, number> } {
  const ratios: Record<string, number[]> = {};
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const r = p.mcap_usd / p.tvl_usd;
    if (!Number.isFinite(r) || r <= 0 || r > 500) continue;
    const cat = p.category ?? 'Uncategorised';
    (ratios[cat] ??= []).push(r);
    all.push(r);
  }
  const byCategory: Record<string, number> = {};
  const counts: Record<string, number> = {};
  for (const [cat, rs] of Object.entries(ratios)) {
    byCategory[cat] = median(rs);
    counts[cat] = rs.length;
  }
  return { byCategory, global: median(all), counts };
}

export function scoreProtocol(
  p: SnapshotProtocol,
  asOf: string,
  peers: { byCategory: Record<string, number>; global: number; counts: Record<string, number> },
): { implied: number; factors: Factors } {
  const c = MODEL_CONSTANTS;
  const cat = p.category ?? 'Uncategorised';
  const catPeers = peers.counts[cat] ?? 0;
  const peerMultiple = catPeers >= 2 && peers.byCategory[cat] !== undefined ? peers.byCategory[cat]! : peers.global;
  const sizeRaw = c.size_curve_coef * Math.pow(p.tvl_usd / 1e8, c.size_curve_exp);
  const sizeCurve = Math.min(c.size_max, Math.max(c.size_min, sizeRaw));
  const sectorMultiple = c.peer_weight * peerMultiple + c.size_weight * sizeCurve;
  const growth = p.change_7d === null || !Number.isFinite(p.change_7d) ? null : Math.min(c.momentum_cap, Math.max(c.momentum_floor, p.change_7d));
  const momentum = growth === null ? 1 : 1 + c.momentum_coef * growth;
  const age = ageDays(asOf, p.listed_at);
  const tenure = age === null ? c.unknown_tenure : c.tenure_floor + (Math.min(age, c.tenure_days) / c.tenure_days) * c.tenure_range;
  const implied = Math.max(1, Math.round(p.tvl_usd * sectorMultiple * momentum * tenure));
  return {
    implied: Math.min(implied, 99_999_999_999_999),
    factors: {
      peer_multiple: Math.round(peerMultiple * 1000) / 1000,
      peer_count: catPeers,
      size_curve: Math.round(sizeCurve * 1000) / 1000,
      sector_multiple: Math.round(sectorMultiple * 1000) / 1000,
      growth_pct: growth,
      momentum: Math.round(momentum * 1000) / 1000,
      tenure: Math.round(tenure * 1000) / 1000,
      age_days: age,
    },
  };
}

// ---------------------------------------------------------------------------
// Farm plans: derived from the protocol's own record, never from a name list.
// ---------------------------------------------------------------------------

function capitalBand(tvl: number): { capital: number; band: string } {
  if (tvl >= 5_000_000_000) return { capital: 300, band: 'blue-chip scale' };
  if (tvl >= 1_000_000_000) return { capital: 200, band: 'large scale' };
  if (tvl >= 100_000_000) return { capital: 120, band: 'mid scale' };
  return { capital: 60, band: 'small scale' };
}

function holdWeeks(age: number | null): number {
  if (age === null) return 6;
  if (age < 120) return 10;
  if (age < 365) return 8;
  return 6;
}

function primaryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Open a supply position: deposit $${capital} of USDC as collateral on ${p.name} (${chain}), then borrow under 40% LTV so the account shows real usage without liquidation risk.`;
  }
  if (c.includes('dex') || c.includes('swap')) {
    return `Swap $${capital} through ${p.name}'s busiest pair on ${chain}, then park half of it in one of its stable-stable pools so volume and liquidity both credit your wallet.`;
  }
  if (c.includes('yield') || c.includes('farm') || c.includes('allocator') || c.includes('curator')) {
    return `Deposit $${capital} into ${p.name}'s largest active vault on ${chain} and leave the receipt token untouched for the full farming window.`;
  }
  if (c.includes('derivativ') || c.includes('perpetual') || c.includes('basis')) {
    return `Fund $${capital} of margin on ${p.name} (${chain}) and keep one small delta-neutral position open, adjusting it once a week.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of ${p.name}'s yield-bearing asset on ${chain} and hold it through at least two monthly snapshots.`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Delegate $${capital} of the native staking asset through ${p.name} on ${chain} and keep the liquid receipt in the same wallet.`;
  }
  if (c.includes('launch') || c.includes('ido')) {
    return `Register the wallet on ${p.name}, join one sale or campaign with $${capital}, and complete every quest the platform lists.`;
  }
  if (c.includes('insurance') || c.includes('cover')) {
    return `Buy $${capital} of cover on ${p.name} for a 90-day term on ${chain} and renew once before it expires.`;
  }
  return `Put $${capital} of USDC to work inside ${p.name} on ${chain} — its deepest pool or vault — and keep the position open.`;
}

export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

export function farmSteps(p: SnapshotProtocol, age: number | null, onWatchlist: boolean): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const { capital } = capitalBand(p.tvl_usd);
  const weeks = holdWeeks(age);
  const steps: FarmStep[] = [
    {
      text: `Set up a dedicated wallet for ${p.name} only, funded with what you plan to deploy plus gas on ${chain}; keep the seed offline.`,
      cost: 'about $2-5 of gas',
      time: '10 minutes',
    },
    {
      text: primaryAction(p, capital, chain),
      cost: `$${capital} of capital plus gas`,
      time: '20 minutes',
    },
    {
      text: `Return weekly and make one genuine interaction — a deposit, a swap, a vote or a rebalance — so the wallet accrues activity across many snapshot dates.`,
      cost: 'about $1-3 of gas a week',
      time: '5 minutes a week',
    },
    {
      text: `Hold the position for at least ${weeks} weeks; ${age === null ? `${p.name} has no recorded launch date, so assume a long qualification window` : `${p.name} has run about ${age} days without a token, so early and consistent users tend to be weighted`}.`,
      cost: `the $${capital} stays deployed`,
      time: `${weeks} weeks`,
    },
  ];
  if (onWatchlist) {
    steps.push({
      text: `${p.name} is on the house watchlist (TVL at or above the floor, no token recorded): treat it as a priority target and check its docs or blog monthly for a points program.`,
      cost: 'no fee',
      time: '10 minutes a month',
    });
  }
  steps.push(
    {
      text: `Watch for an official points or rewards page and follow only links published by ${p.name} itself; never connect the farming wallet to a claim page you reached from chat or social media.`,
      cost: 'nothing to check',
      time: '10 minutes',
    },
    {
      text: `Keep a short farm log: wallet address, dates, amounts and transaction hashes, so a future claim form can be filled from your own records.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  );
  return steps.map((s) => {
    let t = `${s.text} Cost: ${s.cost}. Time: ${s.time}.`;
    if (t.length > 600) t = `${t.slice(0, 596)}...`;
    if (t.trim().length < 20) t = `${t} Track the position weekly and keep records.`;
    return t;
  });
}

// ---------------------------------------------------------------------------
// The board.
// ---------------------------------------------------------------------------

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  factors: Factors;
  farm_steps: string[];
}

export interface RadarMeta {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  constants: typeof MODEL_CONSTANTS;
  watchlist_size: number;
  protocols_total: number;
  pre_token_total: number;
  board_size: number;
  categories: { name: string; pre_token: number; live: number; peer_multiple: number }[];
  peers_global: number;
}

export interface RadarData {
  meta: RadarMeta;
  rows: {
    rank: number; slug: string; name: string; category: string | null; chains: string[];
    tvl_usd: number; change_7d: number | null; listed_at: string | null;
    age_days: number | null; implied_value_usd: number; multiple: number;
    on_watchlist: boolean; factors: Factors; farm_steps: string[];
  }[];
  live: { slug: string; name: string; category: string | null; chains: string[]; tvl_usd: number; mcap_usd: number | null; change_7d: number | null }[];
}

function slugCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const peers = peerMultiples(snapshot.protocols);
  const watch = new Set(snapshot.watchlist);
  const candidates = snapshot.protocols.filter(isRankable);
  const scored = candidates.map((p) => {
    const { implied, factors } = scoreProtocol(p, snapshot.as_of, peers);
    return { p, implied, factors, watch: watch.has(p.slug) };
  });
  // Rank 1 is the most valuable: implied value descends, slug breaks ties deterministically.
  scored.sort((a, b) => b.implied - a.implied || slugCompare(a.p.slug, b.p.slug));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    token_status: 'pre-token' as const,
    on_watchlist: s.watch,
    age_days: s.factors.age_days,
    implied_value_usd: s.implied,
    multiple: Math.round((s.implied / s.p.tvl_usd) * 1000) / 1000,
    factors: s.factors,
    farm_steps: farmSteps(s.p, s.factors.age_days, s.watch),
  }));

  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 30)
    .map((p) => ({
      slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
    }));

  const catNames = new Map<string, { pre: number; live: number }>();
  for (const p of snapshot.protocols) {
    const cat = p.category ?? 'Uncategorised';
    const e = catNames.get(cat) ?? { pre: 0, live: 0 };
    if (isPreToken(p)) e.pre += 1; else e.live += 1;
    catNames.set(cat, e);
  }
  const categories = [...catNames.entries()]
    .map(([name, e]) => ({ name, pre_token: e.pre, live: e.live, peer_multiple: Math.round((peers.byCategory[name] ?? peers.global) * 1000) / 1000 }))
    .sort((a, b) => b.pre_token - a.pre_token);

  const radar: RadarData = {
    meta: {
      as_of: snapshot.as_of,
      source: snapshot.source,
      floor_usd: snapshot.floor_usd,
      model_version: MODEL_VERSION,
      constants: MODEL_CONSTANTS,
      watchlist_size: snapshot.watchlist.length,
      protocols_total: snapshot.protocols.length,
      pre_token_total: candidates.length,
      board_size: board.length,
      categories,
      peers_global: Math.round(peers.global * 1000) / 1000,
    },
    rows: board.map((r) => ({
      rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
      tvl_usd: r.tvl_usd, change_7d: r.change_7d, listed_at: r.listed_at,
      age_days: r.age_days, implied_value_usd: r.implied_value_usd, multiple: r.multiple,
      on_watchlist: r.on_watchlist, factors: r.factors, farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The gate's board.json shape check, run before anything is written. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100) return `only ${board.length} rows, the gate takes 100 to 4000`;
  let rank = 1;
  let prevValue = Number.POSITIVE_INFINITY;
  const seen = new Set<string>();
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) {
    if (r.rank !== rank) return `rank ${r.rank} where ${rank} expected`;
    if (!known.has(r.slug)) return `unknown slug ${r.slug}`;
    if (seen.has(r.slug)) return `duplicate slug ${r.slug}`;
    seen.add(r.slug);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `bad implied value on ${r.slug}`;
    }
    if (r.implied_value_usd > prevValue) return `value rises at rank ${rank}`;
    prevValue = r.implied_value_usd;
    if (!r.name || typeof r.name !== 'string') return `empty name on ${r.slug}`;
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      return `${r.slug} carries ${r.farm_steps.length} farm steps`;
    }
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `farm step of ${t.length} characters on ${r.slug}`;
    }
    rank += 1;
  }
  const missed = snapshot.watchlist.filter((s) => !seen.has(s));
  if (missed.length > 0) return `watchlist slugs missing from the board: ${missed.slice(0, 5).join(', ')}`;
  const values = new Set(board.map((r) => r.implied_value_usd));
  if (board.length >= 2 && values.size === 1) return 'every row carries the same implied value';
  return null;
}

/** The snapshot out of its text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    for (const k of ['slug', 'name']) if (typeof p[k] !== 'string') throw new Error(`protocol ${i} lacks ${k}`);
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) throw new Error(`protocol ${i} lacks a TVL`);
    return {
      slug: p.slug as string,
      name: p.name as string,
      category: (p.category as string | null) ?? null,
      chains: Array.isArray(p.chains) ? (p.chains as string[]) : [],
      tvl_usd: p.tvl_usd as number,
      change_7d: (p.change_7d as number | null) ?? null,
      mcap_usd: (p.mcap_usd as number | null) ?? null,
      listed_at: (p.listed_at as string | null) ?? null,
      gecko_id: (p.gecko_id as string | null) ?? null,
      symbol: (p.symbol as string | null) ?? null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** dashboard/data.js: the board's data beside the page, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `// Generated by main.ts from the sealed snapshot (${radar.meta.as_of}). Do not edit by hand.\nwindow.RADAR = ${JSON.stringify(radar)};\n`;
}
