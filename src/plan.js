'use strict';
/**
 * shipline/plan — the pure decision pieces of the watcher, extracted so they
 * are unit-testable: config guards (fail closed), deploy-target assembly, and
 * the failure backoff curve.
 */
const fs = require('fs');
const path = require('path');

/**
 * validateConfig(root, cfg) → { ok, errors } — FAIL CLOSED. The watcher's job
 * is to deploy continuously and automatically; the guards exist so it can never
 * do that to the wrong place:
 *  - `project` is EXPLICIT (never an alias that could be remapped later)
 *  - it must exist in .firebaserc (typo guard)
 *  - it must not equal any `forbidProjects` entry (production stays promote-only)
 *  - the repo path must not match `forbidPathPatterns` (e.g. an accidental
 *    OneDrive/Dropbox copy of the repo — syncing + deploying is a corruption vector)
 */
function validateConfig(root, cfg) {
  const errors = [];
  const c = cfg || {};
  if (!c.project || typeof c.project !== 'string') errors.push('config.project is required (an explicit project id, not an alias)');
  (c.forbidProjects || []).forEach((p) => { if (p && p === c.project) errors.push('project "' + c.project + '" is in forbidProjects — refusing (production is promote-only)'); });
  (c.forbidPathPatterns || []).forEach((pat) => {
    try { if (new RegExp(pat, 'i').test(root)) errors.push('repo path matches forbidden pattern "' + pat + '" (' + root + ')'); } catch (e) {}
  });
  if (c.requireInFirebaserc !== false) {
    try {
      const rc = JSON.parse(fs.readFileSync(path.join(root, '.firebaserc'), 'utf8'));
      const known = (rc && rc.projects) ? Object.values(rc.projects) : [];
      if (known.indexOf(c.project) === -1) errors.push('"' + c.project + '" is not in .firebaserc projects (' + known.join(', ') + ')');
    } catch (e) { errors.push('cannot read .firebaserc (' + (e && e.message) + ')'); }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * assembleTargets({ pending, fnMode, fnNames }) → "hosting,functions:a,..." | ""
 * pending: { [target]: true } for non-functions targets (hosting, firestore:rules…)
 */
function assembleTargets({ pending = {}, fnMode = 'none', fnNames = [] } = {}) {
  const targets = Object.keys(pending).filter((t) => pending[t]).sort();
  if (fnMode === 'full') targets.push('functions');
  else if (fnMode === 'targeted') fnNames.forEach((n) => targets.push('functions:' + n));
  return targets.join(',');
}

/**
 * backoffMs(consecutiveFails, { baseMs, capMs }?) — 0 fails → null (use the
 * normal debounce). Then 30s, 60s, 120s… capped at 5min. A hard-down deploy
 * must not hammer the API on a sub-second debounce: we once had a failure path
 * that retried on the 700ms debounce FOREVER, one terse log line per cycle —
 * an hour of deploys silently not landing.
 */
function backoffMs(consecutiveFails, { baseMs = 30000, capMs = 300000 } = {}) {
  if (!consecutiveFails || consecutiveFails < 1) return null;
  return Math.min(capMs, baseMs * Math.pow(2, consecutiveFails - 1));
}

/** loudFailureLine(n, target, project, code) — the on-the-record line appended
 * to .deploy-state/deploy-log.txt at 3+ consecutive failures. Scrollback is
 * not a record. */
function loudFailureLine(n, target, project, code) {
  return new Date().toISOString() + '  SHIPLINE: ' + n + ' consecutive FAILED deploys of --only ' + target +
    ' -> ' + project + ' (last exit ' + code + ') — changes are NOT landing; read the firebase output above';
}

module.exports = { validateConfig, assembleTargets, backoffMs, loudFailureLine };
