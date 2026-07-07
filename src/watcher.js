'use strict';
/**
 * shipline/watcher — a fail-closed auto-deploy watcher for a STAGING project.
 *
 * Polls the repo (mtime-based — editor-agnostic, works on network drives),
 * debounces save bursts, resolves the minimal functions set via affected.js,
 * skips unchanged functions via fingerprint.js, runs your preDeploy hooks, and
 * ships with `firebase deploy --only <targets> --project <staging>`.
 *
 * HARD-WON RULES BAKED IN:
 *  - Guards fail closed (see plan.validateConfig). Production is never a target.
 *  - A preDeploy hook FAILURE never lets its target ship: a build hook that
 *    fails must not let a hosting deploy carry the stale artifact under a green
 *    log. The hook's declared outputs get their mtimes adopted on success so
 *    the watcher's own writes don't re-trigger it forever.
 *  - Failure retries back off (30s → 5min cap) and 3+ consecutive failures
 *    write a LOUD line to .deploy-state/deploy-log.txt.
 *  - GOOGLE_CLOUD_QUOTA_PROJECT is set to your project: firebase-tools bills
 *    its cloudbilling pre-check to a shared internal project whose quota is
 *    globally saturated (issue #9895) — the reason functions deploys 429 while
 *    hosting is fine. Enable the Cloud Billing API on your project once.
 *  - The fingerprint marker is recorded only after a successful FULL functions
 *    deploy (a targeted deploy leaves other functions on older code).
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { affectedFunctions } = require('./affected');
const { isFunctionsUnchanged, recordFunctions } = require('./fingerprint');
const { validateConfig, assembleTargets, backoffMs, loudFailureLine } = require('./plan');

function listFilesRec(absDir) {
  let out = [];
  let entries;
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const p = path.join(absDir, ent.name);
    if (ent.isDirectory()) out = out.concat(listFilesRec(p));
    else out.push(p);
  }
  return out;
}

function startWatcher(root, cfg, deps = {}) {
  const log = deps.log || ((m) => console.log('[' + new Date().toLocaleTimeString() + '] ' + m));
  const spawnFn = deps.spawn || spawn;
  const v = validateConfig(root, cfg);
  if (!v.ok) { v.errors.forEach((e) => console.error('ABORT: ' + e)); process.exit(1); }

  const functionsDir = cfg.functionsDir || 'functions';
  const debounce = cfg.debounceMs || 700;
  const watch = cfg.watch || [];
  const hooks = (cfg.hooks && cfg.hooks.preDeploy) || [];

  const mtimes = {};
  const pending = {};                    // non-functions targets: { hosting: true, "firestore:rules": true }
  const pendingHooks = new Set();        // hook indexes queued by a watched change
  let pendingFunctionsFull = false;
  const changedFnFiles = new Set();
  let deployTimer = null, deploying = false, consecutiveFails = 0;

  function watchSet() {
    const out = [];
    for (const w of watch) {
      const abs = path.join(root, w.path);
      let isDir = false;
      try { isDir = fs.statSync(abs).isDirectory(); } catch (e) {}
      if (isDir) listFilesRec(abs).forEach((fp) => out.push({ file: path.relative(root, fp), target: w.target, hook: w.hook }));
      else out.push({ file: w.path, target: w.target, hook: w.hook });
    }
    listFilesRec(path.join(root, functionsDir)).forEach((fp) => out.push({ file: path.relative(root, fp), target: 'functions' }));
    return out;
  }

  function runHooks() {
    for (const idx of [...pendingHooks]) {
      const h = hooks[idx];
      if (!h || !h.run) { pendingHooks.delete(idx); continue; }
      log('  hook: ' + h.run);
      const r = spawnSync(h.run, { cwd: root, stdio: 'inherit', shell: true });
      if (r.status === 0) {
        pendingHooks.delete(idx);
        if (h.target) pending[h.target] = true;      // a SUCCESSFUL hook earns its target the deploy
        (h.adoptOutputs || []).forEach((f) => {
          const fp = path.join(root, f);
          try { mtimes[fp] = fs.statSync(fp).mtimeMs; } catch (e) {}
        });
      } else {
        log('  hook FAILED (exit ' + r.status + '): ' + h.run + ' — its target will NOT ship this run; fix and save again');
        // stays in pendingHooks; its target is NOT marked pending (stale-artifact guard)
      }
    }
  }

  function deploy() {
    if (deploying) return;
    deploying = true;
    runHooks();

    let fn = { mode: 'none', functions: [] };
    if (pendingFunctionsFull) fn = { mode: 'full', functions: [], reason: 'startup / forced — diff unknown' };
    else if (changedFnFiles.size) {
      try { fn = affectedFunctions(root, [...changedFnFiles], { functionsDir, fullThresholdPct: cfg.fullThresholdPct, ignore: cfg.ignore }); }
      catch (e) { fn = { mode: 'full', functions: [], reason: 'resolver error: ' + (e && e.message) }; }
      if (fn.inline && fn.inline.length) log('  note: inline export(s) redeploy every time: ' + fn.inline.join(', '));
      log('  functions: ' + fn.mode + (fn.reason ? ' (' + fn.reason + ')' : '') + (fn.mode === 'targeted' ? ' -> ' + fn.functions.join(', ') : ''));
    }

    const target = assembleTargets({ pending, fnMode: fn.mode, fnNames: fn.functions });
    const hadPending = { ...pending };
    const filesThisRun = [...changedFnFiles];
    const wasFull = fn.mode === 'full';
    Object.keys(pending).forEach((k) => delete pending[k]);
    pendingFunctionsFull = false;
    changedFnFiles.clear();

    if (!target) { deploying = false; return; }
    log('Deploying --only ' + target + ' -> ' + cfg.project + ' ...');
    const proc = spawnFn('firebase',
      ['deploy', '--project', cfg.project, '--only', target, '--force'],
      { cwd: root, stdio: 'inherit', shell: true,
        env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: '60', GOOGLE_CLOUD_QUOTA_PROJECT: cfg.project } });
    proc.on('close', (code) => {
      deploying = false;
      if (code === 0) {
        consecutiveFails = 0;
        if (wasFull) recordFunctions(root, cfg.project, functionsDir);
      } else {
        Object.keys(hadPending).forEach((k) => { if (hadPending[k]) pending[k] = true; });
        if (wasFull) pendingFunctionsFull = true;
        else filesThisRun.forEach((f) => changedFnFiles.add(f));
        consecutiveFails++;
        if (consecutiveFails >= 3) {
          const line = loudFailureLine(consecutiveFails, target, cfg.project, code);
          log('!!! ' + line);
          try { fs.mkdirSync(path.join(root, '.deploy-state'), { recursive: true }); fs.appendFileSync(path.join(root, '.deploy-state', 'deploy-log.txt'), line + '\n'); } catch (e) {}
        }
      }
      log(code === 0 ? 'Done (' + target + ')' : 'Failed (exit ' + code + ')' + (consecutiveFails > 1 ? ' — ' + consecutiveFails + ' in a row' : ''));
      if (Object.keys(pending).some((k) => pending[k]) || pendingFunctionsFull || changedFnFiles.size || pendingHooks.size) {
        schedule(backoffMs(consecutiveFails) || undefined);
      }
    });
  }

  function schedule(delayMs) {
    if (deployTimer) clearTimeout(deployTimer);
    deployTimer = setTimeout(() => { deployTimer = null; deploy(); }, typeof delayMs === 'number' ? delayMs : debounce);
  }

  watchSet().forEach((w) => {
    const fp = path.join(root, w.file);
    try { mtimes[fp] = fs.statSync(fp).mtimeMs; } catch (e) { mtimes[fp] = 0; }
  });

  setInterval(() => {
    watchSet().forEach((w) => {
      const fp = path.join(root, w.file);
      try {
        const mtime = fs.statSync(fp).mtimeMs;
        if (mtime !== mtimes[fp]) {
          mtimes[fp] = mtime;
          log('Changed: ' + w.file);
          if (w.target === 'functions') changedFnFiles.add(w.file);
          else if (typeof w.hook === 'number') pendingHooks.add(w.hook);   // rebuild first; target ships only on hook success
          else pending[w.target] = true;
          schedule();
        }
      } catch (e) {}
    });
  }, cfg.pollMs || 1000);

  log('Watching ' + watchSet().length + ' files -> ' + cfg.project + '. Auto-deploys on change. Ctrl+C to stop.');
  if (cfg.deployOnStart !== false) {
    watch.forEach((w) => { if (typeof w.hook !== 'number') pending[w.target] = true; });
    if (!isFunctionsUnchanged(root, cfg.project, functionsDir)) { pendingFunctionsFull = true; log('  functions changed since last recorded deploy — full functions deploy on startup'); }
    else log('  functions unchanged — startup deploys the rest only');
    schedule();
  }
}

module.exports = { startWatcher, _listFilesRec: listFilesRec };
