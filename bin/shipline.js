#!/usr/bin/env node
'use strict';
/* shipline CLI
 *   shipline affected --files a.js b.js     what would deploy, given these changes
 *   shipline affected --since HEAD~1        …given git diff (also: --staged)
 *   shipline deploy   [--files|--since|--staged|--full] --project <id>
 *   shipline watch    [--config shipline.config.json]
 */
const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { affectedFunctions } = require('../src/affected');
const { planTargets, recordFunctions } = require('../src/fingerprint');
const { validateConfig } = require('../src/plan');
const { startWatcher } = require('../src/watcher');

const args = process.argv.slice(2);
const cmd = args[0];
const opt = (name) => { const i = args.indexOf('--' + name); return i === -1 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const root = path.resolve(opt('root') || '.');

function changedFiles() {
  const files = [];
  const fi = args.indexOf('--files');
  if (fi !== -1) { for (let i = fi + 1; i < args.length && !args[i].startsWith('--'); i++) files.push(args[i]); return files; }
  const since = opt('since');
  const staged = args.includes('--staged');
  if (since || staged) {
    const gitCmd = staged ? 'git diff --name-only --cached' : 'git diff --name-only ' + since;
    try { return execSync(gitCmd, { cwd: root, encoding: 'utf8' }).split('\n').map((s) => s.trim()).filter(Boolean); }
    catch (e) { console.error('git diff failed: ' + e.message); process.exit(1); }
  }
  return null;
}

function loadConfig() {
  const p = path.join(root, opt('config') || 'shipline.config.json');
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { console.error('cannot read ' + p + ' (' + e.message + ') — see example/shipline.config.json'); process.exit(1); }
}

if (cmd === 'affected') {
  const files = changedFiles();
  if (!files) { console.error('give --files <paths…>, --since <git-ref>, or --staged'); process.exit(1); }
  const res = affectedFunctions(root, files, { functionsDir: opt('functions-dir') || 'functions' });
  console.log(JSON.stringify(res, null, 2));
  if (res.mode === 'targeted') console.log('\nfirebase deploy --only ' + res.functions.map((n) => 'functions:' + n).join(','));
  else if (res.mode === 'full') console.log('\nfirebase deploy --only functions');
  else console.log('\nnothing to deploy');
} else if (cmd === 'deploy') {
  const project = opt('project');
  if (!project || project === true) { console.error('--project <id> is required'); process.exit(1); }
  const guard = validateConfig(root, { project, forbidProjects: (opt('forbid') || '').split(',').filter(Boolean) });
  if (!guard.ok) { guard.errors.forEach((e) => console.error('ABORT: ' + e)); process.exit(1); }
  let only;
  let wasFull = false;
  if (args.includes('--full')) { only = planTargets(root, project, ['functions']).targets.join(','); wasFull = only.includes('functions'); if (!only) { console.log('functions unchanged — nothing to deploy'); process.exit(0); } }
  else {
    const files = changedFiles();
    if (!files) { console.error('give --files, --since, --staged, or --full'); process.exit(1); }
    const res = affectedFunctions(root, files, { functionsDir: opt('functions-dir') || 'functions' });
    if (res.mode === 'none') { console.log('nothing to deploy (' + res.reason + ')'); process.exit(0); }
    wasFull = res.mode === 'full';
    only = wasFull ? 'functions' : res.functions.map((n) => 'functions:' + n).join(',');
    console.log(res.reason);
  }
  console.log('firebase deploy --project ' + project + ' --only ' + only);
  const r = spawnSync('firebase', ['deploy', '--project', project, '--only', only, '--force'],
    { cwd: root, stdio: 'inherit', shell: true, env: { ...process.env, FUNCTIONS_DISCOVERY_TIMEOUT: '60', GOOGLE_CLOUD_QUOTA_PROJECT: project } });
  if (r.status === 0 && wasFull) recordFunctions(root, project);
  process.exit(r.status || 0);
} else if (cmd === 'watch') {
  startWatcher(root, loadConfig());
} else {
  console.log('shipline — deploy only the Firebase functions your change actually affects\n');
  console.log('  shipline affected --files <paths…> | --since <ref> | --staged');
  console.log('  shipline deploy   --project <id> [--files|--since|--staged|--full]');
  console.log('  shipline watch    [--config shipline.config.json]');
  process.exit(cmd ? 1 : 0);
}
