// Token Radar — the page. Renders window.RADAR, which main.ts writes into data.js.
'use strict';

const $ = (sel) => document.querySelector(sel);
const RADAR = window.RADAR;
const M = RADAR.meta;

const usd = (n) => {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
};
const pct = (g) => (g === null || g === undefined) ? '—' : `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`;
const age = (d) => (d === null || d === undefined) ? 'unknown' : `${d.toLocaleString('en-US')}d`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

// --- header stats ---
$('#stats').replaceChildren(
  ...[
    ['Snapshot', M.as_of],
    ['Protocols tracked', M.protocols_total.toLocaleString('en-US')],
    ['Pre-token', M.pre_token_total.toLocaleString('en-US')],
    ['Watchlist covered', `${M.watchlist_size}/${M.watchlist_size}`],
    ['Rows ranked', M.board_size.toLocaleString('en-US')],
  ].map(([k, v]) => {
    const w = el('div');
    w.append(el('dt', '', k), el('dd', k.startsWith('Watchlist') ? 'good' : '', v));
    return w;
  }),
);

// --- filter controls ---
const cats = ['all categories', ...M.categories.map((c) => c.name)];
const chainsSet = new Set();
for (const r of RADAR.rows) for (const c of r.chains) chainsSet.add(c);
const chains = ['all chains', ...[...chainsSet].sort()];
const fill = (sel, list) => {
  sel.replaceChildren(...list.map((v) => el('option', '', v)));
};
fill($('#category'), cats);
fill($('#chain'), chains);

const state = { q: '', category: 'all categories', chain: 'all chains', sort: 'implied', onlyWatch: false, view: 'board', slug: null, liveView: false };
const params = new URLSearchParams(location.search);
if (params.get('view') === 'detail' && params.get('slug')) { state.view = 'detail'; state.slug = params.get('slug'); }
if (params.get('cat')) state.category = decodeURIComponent(params.get('cat'));
if (params.get('chain')) state.chain = decodeURIComponent(params.get('chain'));
if (params.get('only') === 'watchlist') state.onlyWatch = true;
if (params.get('q')) state.q = params.get('q');
if (params.get('sort')) state.sort = params.get('sort');

function syncControls() {
  $('#q').value = state.q;
  $('#category').value = state.category;
  $('#chain').value = state.chain;
  $('#sort').value = state.sort;
  $('#onlyWatch').checked = state.onlyWatch;
}
syncControls();

$('#q').addEventListener('input', (e) => { state.q = e.target.value.toLowerCase(); render(); });
$('#category').addEventListener('change', (e) => { state.category = e.target.value; render(); });
$('#chain').addEventListener('change', (e) => { state.chain = e.target.value; render(); });
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; render(); });
$('#onlyWatch').addEventListener('change', (e) => { state.onlyWatch = e.target.checked; render(); });
$('#reset').addEventListener('click', () => {
  Object.assign(state, { q: '', category: 'all categories', chain: 'all chains', sort: 'implied', onlyWatch: false, view: 'board', slug: null, liveView: false });
  syncControls(); render();
});
$('#showLive').addEventListener('click', () => { state.liveView = !state.liveView; render(); });

// --- data shaping ---
function filtered() {
  let rows = RADAR.rows.filter((r) => {
    if (state.onlyWatch && !r.on_watchlist) return false;
    if (state.category !== 'all categories' && (r.category ?? 'Uncategorised') !== state.category) return false;
    if (state.chain !== 'all chains' && !r.chains.includes(state.chain)) return false;
    if (state.q) {
      const hay = `${r.name} ${r.slug} ${r.category ?? ''} ${r.chains.join(' ')}`.toLowerCase();
      if (!hay.includes(state.q)) return false;
    }
    return true;
  });
  const key = state.sort;
  rows = [...rows].sort((a, b) => {
    if (key === 'implied') return b.implied_value_usd - a.implied_value_usd;
    if (key === 'multiple') return b.multiple - a.multiple;
    if (key === 'tvl') return b.tvl_usd - a.tvl_usd;
    if (key === 'growth') return (b.change_7d ?? -999) - (a.change_7d ?? -999);
    if (key === 'age') return (b.age_days ?? -1) - (a.age_days ?? -1);
    return 0;
  });
  return rows;
}
const maxImplied = RADAR.rows.reduce((m, r) => Math.max(m, r.implied_value_usd), 1);
const bySlug = new Map(RADAR.rows.map((r) => [r.slug, r]));

// --- board ---
function boardView(main) {
  const rows = filtered();
  const head = el('div', 'context');
  const title = el('h2', '', state.liveView ? 'Protocols whose token already trades' : 'Pre-token board');
  const chips = el('div', 'chips');
  chips.append(el('span', 'chip', `model ${M.model_version}`));
  chips.append(el('span', 'chip amber', `watchlist floor ${usd(M.floor_usd)}`));
  if (state.onlyWatch) chips.append(el('span', 'chip amber', 'watchlist only'));
  if (state.category !== 'all categories') chips.append(el('span', 'chip blue', state.category));
  if (state.chain !== 'all chains') chips.append(el('span', 'chip blue', state.chain));
  if (state.q) chips.append(el('span', 'chip blue', `“${state.q}”`));
  head.append(title, el('span', 'count', `${rows.length.toLocaleString('en-US')} of ${M.board_size.toLocaleString('en-US')} rows · sorted by ${state.sort.replace(/^\w/, (c) => c.toUpperCase())}`));
  main.append(head, chips);

  const card = el('div', 'card scroll');
  const table = el('table');
  const thead = el('thead');
  const hr = el('tr');
  for (const [label, key] of [['', ''], ['Protocol', ''], ['TVL', 'tvl'], ['7d', 'growth'], ['No token for', 'age'], ['Implied value', 'implied'], ['Multiple', 'multiple'], ['Value', '']]) {
    const th = el('th', '', label);
    if (key) {
      th.addEventListener('click', () => { state.sort = key; syncControls(); render(); });
      if (key === state.sort) th.style.color = 'var(--mint)';
    }
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  const list = state.liveView ? RADAR.live : rows;
  for (const r of list) {
    const tr = el('tr');
    if (!state.liveView && state.view === 'detail' && state.slug === r.slug) tr.className = 'selected';
    const cRank = el('td', 'rank', state.liveView ? '·' : String(r.rank));
    const cName = el('td', 'name');
    if (r.on_watchlist && !state.liveView) cName.append(el('span', 'watch', ''), el('span', '', r.name));
    else cName.append(el('span', '', r.name));
    const meta = el('span', 'meta', `${r.category ?? 'Uncategorised'} · ${r.chains.slice(0, 4).join(', ')}${r.chains.length > 4 ? ` +${r.chains.length - 4}` : ''}`);
    cName.append(meta);
    const cTvl = el('td', '', usd(r.tvl_usd));
    const cG = el('td', `growth ${r.change_7d == null ? 'na' : r.change_7d >= 0 ? 'pos' : 'neg'}`, pct(r.change_7d));
    const cAge = el('td', '', age(r.age_days));
    const cImp = el('td', 'value', state.liveView ? usd(r.mcap_usd ?? 0) : usd(r.implied_value_usd));
    const cMul = el('td', 'mutl', state.liveView ? (r.mcap_usd && r.tvl_usd ? (r.mcap_usd / r.tvl_usd).toFixed(2) + '×' : '—') : `${r.multiple.toFixed(2)}×`);
    const cBar = el('td');
    const bar = el('div', 'bar');
    const fillBar = el('i');
    const frac = state.liveView ? (r.mcap_usd ?? 0) / Math.max(...RADAR.live.map((x) => x.mcap_usd ?? 0)) : r.implied_value_usd / maxImplied;
    fillBar.style.width = `${Math.max(2, Math.min(100, frac * 100)).toFixed(1)}%`;
    bar.append(fillBar);
    cBar.append(bar);
    tr.append(cRank, cName, cTvl, cG, cAge, cImp, cMul, cBar);
    if (!state.liveView) {
      tr.addEventListener('click', () => { state.view = 'detail'; state.slug = r.slug; render(); window.scrollTo(0, 0); });
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  card.append(table);
  main.append(card);
  const foot = el('footer', '', `Board ranked by implied value of the token not yet recorded · snapshot ${M.source} · ${M.pre_token_total} of ${M.protocols_total} tracked protocols record no token · watchlist fully covered (${M.watchlist_size}/${M.watchlist_size})`);
  main.append(foot);
}

// --- detail ---
function detailView(main, row) {
  const back = el('button', 'back', '← back to the board');
  back.addEventListener('click', () => { state.view = 'board'; state.slug = null; render(); });
  main.append(back);

  const card = el('div', 'card detail');
  const head = el('div', 'detail-head');
  const left = el('div');
  left.append(el('h2', '', row.name));
  const chips = el('div', 'chips');
  chips.append(el('span', 'chip amber', `rank #${row.rank}`));
  chips.append(el('span', 'chip', row.category ?? 'Uncategorised'));
  for (const c of row.chains.slice(0, 6)) chips.append(el('span', 'chip blue', c));
  if (row.on_watchlist) chips.append(el('span', 'chip amber', 'on watchlist'));
  const subline = el('p', 'subline', `no token recorded in DefiLlama's snapshot of ${M.as_of} · listed ${row.listed_at ?? 'date unknown'} · ${row.age_days === null ? 'age unknown' : `${row.age_days.toLocaleString('en-US')} days without a token`}`);
  left.append(chips, subline);
  const big = el('div', 'big');
  big.append(el('div', 'label', 'Implied token value'));
  big.append(el('div', 'v', usd(row.implied_value_usd)));
  big.append(el('div', 'rankline', `${row.multiple.toFixed(2)}× TVL · TVL ${usd(row.tvl_usd)}`));
  head.append(left, big);
  card.append(head);

  const grid = el('div', 'grid');

  // why this value
  const why = el('div', 'block');
  why.append(el('h3', '', 'Why this value'));
  const f = row.factors;
  const kv = (k, v, hi) => { const r0 = el('div', 'kv'); r0.append(el('span', '', k), el('span', hi ? 'hi' : '', v)); return r0; };
  why.append(
    kv('TVL (snapshot)', usd(row.tvl_usd)),
    kv(f.peer_count >= 2
      ? `Peer multiple — median mcap/TVL of ${f.peer_count} trading peers in ${row.category ?? 'its category'}`
      : `Peer multiple — global median over every trading protocol (${f.peer_count} same-category peers is too few to set a norm)`,
      `${f.peer_multiple.toFixed(2)}×`),
    kv('Size curve — smaller capital base, richer multiple', `${f.size_curve.toFixed(2)}×`),
    kv('Sector multiple — 0.55 × peer + 0.45 × size', `${f.sector_multiple.toFixed(2)}×`, true),
    kv(`Momentum — 7-day TVL change ${pct(f.growth_pct)}`, `${f.momentum.toFixed(2)}×`),
    kv('Tenure — longer unissued, more established', `${f.tenure.toFixed(2)}×`),
    kv('Implied value = TVL × sector × momentum × tenure', usd(row.implied_value_usd), true),
  );
  why.append(el('p', 'note small', `The peer multiple comes from the snapshot itself: every same-category protocol whose token already trades sets the market's own FDV/TVL norm. Nothing about ${row.name} is hardcoded.`));

  // record
  const rec = el('div', 'block');
  rec.append(el('h3', '', 'Record'));
  rec.append(
    kv('Chains', String(row.chains.length)),
    kv('Top chain', row.chains[0] ?? '—'),
    kv('TVL', usd(row.tvl_usd)),
    kv('7-day change', pct(row.change_7d)),
    kv('Listed on DefiLlama', row.listed_at ?? 'unknown'),
    kv('Age', age(row.age_days)),
    kv('Market cap', 'none recorded — the token does not exist yet'),
    kv('Implied value / TVL', `${row.multiple.toFixed(2)}×`),
  );
  rec.append(el('p', 'note small', row.on_watchlist
    ? `${row.name} is one of the snapshot's ${M.watchlist_size} watchlist protocols: TVL at or above the ${usd(M.floor_usd)} floor with no token recorded and no wrapped or staked parent.`
    : `${row.name} sits below the ${usd(M.floor_usd)} watchlist floor. The watchlist is the floor, never the ceiling: this is an early row the radar keeps so a small protocol's token is not missed.`));

  // farm plan
  const plan = el('div', 'block');
  plan.append(el('h3', '', 'Farm plan'));
  const steps = el('ol', 'steps');
  for (const s of row.farm_steps) {
    const li = el('li', '', s);
    steps.append(li);
  }
  plan.append(steps);

  // peers
  const peerBlock = el('div', 'block');
  peerBlock.append(el('h3', '', `Trading peers in ${row.category ?? 'its category'}`));
  const peers = RADAR.live.filter((p) => (p.category ?? 'Uncategorised') === (row.category ?? 'Uncategorised') && p.mcap_usd).slice(0, 6);
  if (peers.length === 0) {
    peerBlock.append(el('p', 'note small', 'No same-category protocol in the snapshot has a trading token, so the global peer median of ' + M.peers_global.toFixed(2) + '× sets the norm.'));
  } else {
    const pt = el('table', 'peers');
    const ph = el('thead'); const phr = el('tr');
    for (const l of ['Protocol', 'TVL', 'Market cap', 'mcap/TVL']) phr.append(el('th', '', l));
    ph.append(phr); pt.append(ph);
    const pb = el('tbody');
    for (const p of peers) {
      const tr0 = el('tr');
      tr0.append(
        el('td', '', p.name),
        el('td', '', usd(p.tvl_usd)),
        el('td', '', usd(p.mcap_usd ?? 0)),
        el('td', 'value', ((p.mcap_usd ?? 0) / p.tvl_usd).toFixed(2) + '×'),
      );
      pb.append(tr0);
    }
    pt.append(pb);
    peerBlock.append(pt);
    peerBlock.append(el('p', 'note small', `These six set the median ${f.peer_multiple.toFixed(2)}× the model reads for ${row.category ?? 'this category'}.`));
  if (f.peer_count < 2) peerBlock.append(el('p', 'note small', `Only ${f.peer_count} same-category protocol${f.peer_count === 1 ? '' : 's'} trades a token, so the model falls back to the global median ${f.peer_multiple.toFixed(2)}×.`));
  }
  grid.append(why, rec, plan, peerBlock);
  card.append(grid);
  main.append(card);
  const foot = el('footer', '', `Implied value is this board's own claim, not make.fun's: it says what the token would be worth if the protocol's record stayed as it is. Nothing here predicts whether or when a token is issued.`);
  main.append(foot);
}

// --- live set aside: the protocols of the same universe whose token already trades ---
$('#liveNote').textContent = `${RADAR.live.length} protocols in the same snapshot already carry a token. They calibrate the model's peer multiple and are never ranked with the pre-token board.`;
const liveList = el('div', 'livelist');
for (const p of RADAR.live.slice(0, 4)) {
  const r0 = el('div', 'kv');
  r0.append(el('span', '', p.name), el('span', '', `${usd(p.mcap_usd ?? 0)} · ${p.tvl_usd ? ((p.mcap_usd ?? 0) / p.tvl_usd).toFixed(2) : '—'}×`));
  liveList.append(r0);
}
$('#liveNote').after(liveList);

// --- render ---
function render() {
  const main = $('#main');
  main.replaceChildren();
  if (state.liveView) { boardView(main); return; }
  if (state.view === 'detail') {
    const row = bySlug.get(state.slug);
    if (row) { detailView(main, row); return; }
  }
  boardView(main);
}
render();
