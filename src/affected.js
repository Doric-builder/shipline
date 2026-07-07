'use strict';
/**
 * shipline/affected — given the files that changed under functions/, compute the
 * MINIMAL set of cloud-function names that actually need redeploying.
 *
 * WHY: every callable lives in ONE Firebase functions codebase, so
 * `firebase deploy --only functions` (no names) redeploys ALL of them on any
 * change. On a real project (~83 functions) that is slow and trips the Cloud
 * Functions write-ops quota. If your index.js is a pure barrel —
 *   exports.NAME = require("./domains/<x>").NAME;
 * — each function's transitive require-closure can be built from source, and
 * only the functions whose closure includes a changed file need redeploying.
 * A typical single-domain edit: 4–14 functions instead of 83.
 *
 * SAFE BY DESIGN — never silently UNDER-deploys. A targeted deploy updates only
 * the named functions; every other function keeps its last-deployed code. So the
 * closure must be complete, and the resolver falls back to a FULL deploy whenever
 * it cannot prove the minimal set is safe:
 *   - index.js / package.json / package-lock.json / .env changed      -> FULL
 *   - a changed source file no function's closure reaches             -> FULL
 *   - a shared file reaching >= `fullThresholdPct` of functions       -> FULL
 *   - index.js cannot be parsed                                       -> FULL
 * Exports defined INLINE in index.js (not a `require(...)` delegation) can't be
 * statically scoped, so they ride along on every non-empty targeted deploy and
 * are reported (move them into a module to drop them). Only files matching
 * `ignore` (tests/docs/harnesses by default) are treated as no-op.
 *
 * Pure and dependency-free.
 */
const fs = require('fs');
const path = require('path');

function isRel(s) { return s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../'); }

function resolveReq(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  const cands = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
  for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  return null;
}

function scanRequires(file) {
  let src; try { src = fs.readFileSync(file, 'utf8'); } catch (e) { return { specs: [], dynamic: false }; }
  const specs = []; let m;
  const lit = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
  while ((m = lit.exec(src))) if (isRel(m[2])) specs.push(m[2]);
  const dynamic = /require\(\s*[^'")\s]/.test(src);
  return { specs, dynamic };
}

function closureOf(entry, fnRootPrefix) {
  const seen = new Set(); const stack = [entry]; let opaque = false;
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue; seen.add(f);
    const { specs, dynamic } = scanRequires(f);
    if (dynamic) opaque = true;
    for (const s of specs) {
      const r = resolveReq(f, s);
      if (r && r.startsWith(fnRootPrefix) && !seen.has(r)) stack.push(r);
    }
  }
  return { files: seen, opaque };
}

function parseBarrel(indexFile) {
  const src = fs.readFileSync(indexFile, 'utf8');
  const all = new Set(); const barrel = {}; let m;
  const allRe = /^[ \t]*exports\.(\w+)\s*=/gm;
  while ((m = allRe.exec(src))) all.add(m[1]);
  const barRe = /^[ \t]*exports\.(\w+)\s*=\s*require\(\s*(['"])([^'"]+)\2\s*\)\s*\.\s*(\w+)\s*;?/gm;
  while ((m = barRe.exec(src))) barrel[m[1]] = resolveReq(indexFile, m[3]);
  const inline = [...all].filter((n) => !(n in barrel));
  return { barrel, inline, all: [...all] };
}

const DEFAULT_IGNORE = (rel) =>
  /(^|\/)(tests?|scripts|docs?)\//.test(rel) ||
  /-harness\//.test(rel) ||
  /\.test\.js$/.test(rel) ||
  /\.md$/i.test(rel);

const FULL_BASENAMES = new Set(['index.js', 'package.json', 'package-lock.json', '.env']);

/**
 * affectedFunctions(root, changedPaths, opts?) -> result
 *   opts.functionsDir     (default "functions")
 *   opts.fullThresholdPct (default 0.6 — shared change reaching this fraction => full)
 *   opts.ignore           (rel-path predicate for no-op files)
 *
 *   result.mode      : 'full' | 'targeted' | 'none'
 *   result.functions : string[]  (sorted, when targeted)
 *   result.inline    : string[]  (inline exports folded into every targeted set)
 *   result.reason    : string
 */
function affectedFunctions(root, changedPaths, opts) {
  opts = opts || {};
  const fnDir = path.join(root, opts.functionsDir || 'functions');
  const prefix = fnDir + path.sep;
  const indexFile = path.join(fnDir, 'index.js');
  const fullPct = typeof opts.fullThresholdPct === 'number' ? opts.fullThresholdPct : 0.6;
  const ignore = opts.ignore || DEFAULT_IGNORE;

  const changed = (changedPaths || [])
    .map((p) => (path.isAbsolute(p) ? p : path.resolve(root, p)))
    .filter((p) => p === fnDir || p.startsWith(prefix));
  if (!changed.length) return { mode: 'none', functions: [], reason: 'no functions/ files changed' };

  for (const c of changed) {
    if (FULL_BASENAMES.has(path.basename(c)) && path.dirname(c) === fnDir)
      return { mode: 'full', functions: [], reason: 'core file changed: ' + path.basename(c) };
  }

  let parsed;
  try { parsed = parseBarrel(indexFile); }
  catch (e) { return { mode: 'full', functions: [], reason: 'cannot parse index.js (' + (e && e.message) + ')' }; }
  const names = Object.keys(parsed.barrel);
  if (!names.length) return { mode: 'full', functions: [], reason: 'no barrel exports parsed' };

  const fileToNames = new Map();
  for (const n of names) {
    const entry = parsed.barrel[n];
    if (!entry) continue;
    const { files } = closureOf(entry, prefix);
    for (const f of files) {
      if (!fileToNames.has(f)) fileToNames.set(f, new Set());
      fileToNames.get(f).add(n);
    }
  }

  const hit = new Set();
  for (const c of changed) {
    const rel = path.relative(fnDir, c).replace(/\\/g, '/');
    if (fileToNames.has(c)) { for (const n of fileToNames.get(c)) hit.add(n); continue; }
    if (ignore(rel)) continue;
    return { mode: 'full', functions: [], reason: 'unmapped source changed: ' + rel };
  }

  if (!hit.size) return { mode: 'none', functions: [], inline: parsed.inline, reason: 'only ignorable files changed' };

  for (const n of parsed.inline) hit.add(n);

  const total = parsed.all.length;
  if (hit.size >= Math.ceil(total * fullPct))
    return { mode: 'full', functions: [], inline: parsed.inline, reason: 'shared change reaches ' + hit.size + '/' + total + ' functions' };

  return { mode: 'targeted', functions: [...hit].sort(), inline: parsed.inline, reason: hit.size + '/' + total + ' functions affected' };
}

module.exports = { affectedFunctions, DEFAULT_IGNORE, _parseBarrel: parseBarrel, _closureOf: closureOf, _resolveReq: resolveReq };
