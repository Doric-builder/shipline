'use strict';
/**
 * shipline/fingerprint — skip the slow `functions` deploy when nothing in
 * functions/ actually changed.
 *
 * A functions deploy is a multi-minute Cloud Run build; hosting/rules deploys
 * are seconds. Most cycles touch only client code. We hash the deployable
 * functions SOURCE (functions/** minus node_modules/.git; the lockfile IS
 * included so a dependency bump counts) and store the last-deployed hash per
 * project under .deploy-state/.
 *
 * SAFE BY DEFAULT: a missing/unreadable marker, or ANY byte change, counts as
 * CHANGED — it can never silently skip a real functions change. The marker is
 * written ONLY after a successful deploy (and only after a FULL functions
 * deploy — a targeted deploy leaves un-named functions on older code, so the
 * all-source hash would falsely read "everything deployed").
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function collect(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const e of ents) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else out.push(p);
  }
}

function functionsFingerprint(root, functionsDir) {
  const dir = path.join(root, functionsDir || 'functions');
  const files = [];
  collect(dir, files);
  files.sort();
  const h = crypto.createHash('sha256');
  if (files.length === 0) return 'EMPTY';
  for (const f of files) {
    h.update(path.relative(root, f).replace(/\\/g, '/'));
    h.update('\0');
    try { h.update(fs.readFileSync(f)); } catch (e) { h.update('<unreadable>'); }
    h.update('\0');
  }
  return h.digest('hex');
}

function stateDir(root) { return path.join(root, '.deploy-state'); }
function markerPath(root, project) { return path.join(stateDir(root), project + '.functions.hash'); }

function isFunctionsUnchanged(root, project, functionsDir) {
  try {
    const cur = functionsFingerprint(root, functionsDir);
    if (cur === 'EMPTY') return false;
    const prev = fs.readFileSync(markerPath(root, project), 'utf8').trim();
    return !!prev && prev === cur;
  } catch (e) { return false; }
}

function recordFunctions(root, project, functionsDir) {
  try {
    fs.mkdirSync(stateDir(root), { recursive: true });
    fs.writeFileSync(markerPath(root, project), functionsFingerprint(root, functionsDir));
    return true;
  } catch (e) { return false; }
}

/* planTargets(root, project, requested, functionsDir?) — drops 'functions' from
   `requested` when unchanged; keeps everything else. */
function planTargets(root, project, requested, functionsDir) {
  const kept = [], skipped = [];
  (requested || []).forEach(function (t) {
    if (t === 'functions' && isFunctionsUnchanged(root, project, functionsDir)) skipped.push(t);
    else kept.push(t);
  });
  return { targets: kept, skipped };
}

module.exports = { functionsFingerprint, isFunctionsUnchanged, recordFunctions, planTargets, _stateDir: stateDir };
