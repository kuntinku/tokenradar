// Local mirror of the seven gate rows in RULES.txt ("The gate"), run against an /output tree.
//   node tools/gatecheck.mjs out
// It is a development check, not the scorer: it reads the same files and applies the same caps.
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const out = process.argv[2] ?? 'out';
const snap = JSON.parse(readFileSync(process.env.SNAPSHOT ?? '/root/makefun/token-radar-01-kit/input/snapshot.json', 'utf8'));
const known = new Set(snap.protocols.map((p) => p.slug));
const watch = new Set(snap.watchlist);

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const results = [];
function row(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail ?? 'ok' });
  } catch (err) {
    results.push({ name, ok: false, detail: err.message });
  }
}
function fail(msg) { throw new Error(msg); }

function walk(dir, base = dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p, base));
    else files.push(p);
  }
  return files;
}

row('dashboard_files', () => {
  const d = join(out, 'dashboard');
  if (!existsSync(d)) fail('no dashboard/');
  const paths = walk(d);
  if (paths.length > 400) fail(`${paths.length} files`);
  let bytes = 0;
  const kinds = new Set();
  for (const p of paths) {
    const rel = p.slice(d.length + 1);
    bytes += statSync(p).size;
    for (const seg of rel.split('/')) {
      if (!NAME.test(seg)) fail(`bad name: ${rel}`);
    }
    const ext = rel.includes('.') ? rel.slice(rel.lastIndexOf('.')) : '';
    kinds.add(ext);
    const text = readFileSync(p, 'utf8');
    if (ext === '.html') {
      for (const m of text.matchAll(/\b(?:href|src|action|poster|data|srcset)\s*=\s*["']([^"']*)["']/gi)) {
        if (/https?:\/\//i.test(m[1])) fail(`network address in an attribute: ${rel}`);
      }
      for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) {
        if (/https?:\/\//i.test(m[1])) fail(`network address in a style body: ${rel}`);
      }
    }
    if (ext === '.css' && /https?:\/\//i.test(text)) fail(`network address in ${rel}`);
    if (ext === '.js' || ext === '.mjs') {
      for (const m of text.matchAll(/\b(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g)) {
        if (/https?:\/\//i.test(m[1])) fail(`network address in an import: ${rel}`);
      }
      if (/\brequire\s*\(\s*['"]https?:/i.test(text) || /\bimport\s*\(\s*['"]https?:/i.test(text)) fail(`network address in ${rel}`);
    }
  }
  if (bytes > 4_194_304) fail(`${bytes} bytes`);
  if (!kinds.has('.html')) fail('no .html');
  if (!kinds.has('.css')) fail('no .css');
  if (!kinds.has('.js')) fail('no .js');
  return `${paths.length} files, ${bytes} bytes`;
});

let board = null;
row('board_file', () => {
  const p = join(out, 'board.json');
  const buf = readFileSync(p);
  if (buf.length > 8_388_608) fail(`${buf.length} bytes`);
  const doc = JSON.parse(buf.toString('utf8'));
  const rows = Array.isArray(doc) ? doc : doc.rows;
  if (!Array.isArray(rows)) fail('no rows array');
  if (rows.length < 100 || rows.length > 4000) fail(`${rows.length} rows`);
  const seen = new Set();
  for (const r of rows) {
    if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) fail(`bad slug ${JSON.stringify(r.slug)}`);
    if (!known.has(r.slug)) fail(`invented slug ${r.slug}`);
    if (seen.has(r.slug)) fail(`duplicate slug ${r.slug}`);
    seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.trim() === '') fail(`empty name on ${r.slug}`);
    if (!Number.isInteger(r.rank) || r.rank <= 0) fail(`bad rank on ${r.slug}`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) fail(`bad implied value on ${r.slug}`);
    if (!Array.isArray(r.farm_steps)) fail(`no farm_steps on ${r.slug}`);
  }
  board = rows;
  return `${rows.length} rows, ${buf.length} bytes`;
});

row('sorted_by_value', () => {
  if (board === null) fail('board did not load');
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i += 1) if (ranks[i] !== i + 1) fail(`ranks are not 1..N (${ranks[i]} at ${i + 1})`);
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i += 1) {
    if (byRank[i].implied_value_usd > byRank[i - 1].implied_value_usd) fail(`value rises at rank ${byRank[i].rank}`);
  }
  if (new Set(board.map((r) => r.implied_value_usd)).size === 1) fail('every implied value is the same');
  return 'ranks 1..N, values descend';
});

row('coverage', () => {
  if (board === null) fail('board did not load');
  const have = new Set(board.map((r) => r.slug));
  const missing = [...watch].filter((s) => !have.has(s));
  if (missing.length > 0) fail(`missing ${missing.length}: ${missing.slice(0, 5).join(', ')}`);
  return `${watch.size}/${watch.size} watchlist slugs covered`;
});

row('farm_steps', () => {
  if (board === null) fail('board did not load');
  for (const r of board) {
    if (!Array.isArray(r.farm_steps) || r.farm_steps.length < 3 || r.farm_steps.length > 12) fail(`${r.slug}: ${r.farm_steps?.length} steps`);
    for (const s of r.farm_steps) {
      const t = String(s).trim();
      if (t.length < 20 || t.length > 600) fail(`${r.slug}: a step of ${t.length} characters`);
    }
  }
  return `every row carries 3..12 steps of 20..600 characters`;
});

function imageSize(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) {
    return { kind: 'png', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { kind: 'jpeg', h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

row('screenshots', () => {
  const d = join(out, 'screenshots');
  if (!existsSync(d)) fail('no screenshots/');
  const names = readdirSync(d).filter((n) => !n.startsWith('.')).sort();
  if (names.length < 3 || names.length > 4) fail(`${names.length} images`);
  const notes = [];
  for (const n of names) {
    if (!NAME.test(n)) fail(`bad name ${n}`);
    const p = join(d, n);
    const buf = readFileSync(p);
    if (buf.length > 524_288) fail(`${n} is ${buf.length} bytes`);
    const size = imageSize(buf);
    if (size === null) fail(`${n} is not a whole PNG or JPEG`);
    const long = Math.max(size.w, size.h);
    const short = Math.min(size.w, size.h);
    if (long > 1440) fail(`${n} long side ${long}`);
    if (short < 800) fail(`${n} short side ${short}`);
    notes.push(`${n} ${size.w}x${size.h} ${buf.length}B`);
  }
  return notes.join('; ');
});

row('dossier_matches', () => {
  const p = join(out, 'dossier.json');
  const want = buildDossier(out, { text_max_bytes: 65_536 });
  const have = readFileSync(p);
  if (have.length > 1_572_864) fail(`${have.length} bytes`);
  if (Buffer.compare(want, have) !== 0) fail(`dossier.json differs from buildDossier (${have.length} vs ${want.length} bytes)`);
  const text = JSON.parse(have.toString('utf8'));
  const sourceBytes = text.text ? Buffer.byteLength(text.text, 'utf8') : null;
  return `${have.length} bytes, source text ${sourceBytes ?? '?'} bytes`;
});

let bad = 0;
for (const r of results) {
  if (!r.ok) bad += 1;
  process.stdout.write(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(18)} ${r.detail}\n`);
}
process.stdout.write(bad === 0 ? 'all seven gate rows pass\n' : `${bad} gate row(s) failed\n`);
process.exit(bad === 0 ? 0 : 1);
