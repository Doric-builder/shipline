'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { validateConfig, assembleTargets, backoffMs, loudFailureLine } = require('../src/plan');

test('guards fail closed: missing project, prod in forbid list, path pattern, .firebaserc', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-'));
  fs.writeFileSync(path.join(tmp, '.firebaserc'), JSON.stringify({ projects: { default: 'my-staging', release: 'my-prod' } }));
  assert.equal(validateConfig(tmp, {}).ok, false);
  assert.equal(validateConfig(tmp, { project: 'my-prod', forbidProjects: ['my-prod'] }).ok, false);
  assert.equal(validateConfig(tmp, { project: 'not-in-rc' }).ok, false);
  assert.equal(validateConfig(tmp, { project: 'my-staging', forbidProjects: ['my-prod'] }).ok, true);
  const fakeOneDrive = path.join(tmp, 'OneDrive', 'repo');
  fs.mkdirSync(fakeOneDrive, { recursive: true });
  fs.writeFileSync(path.join(fakeOneDrive, '.firebaserc'), JSON.stringify({ projects: { default: 'my-staging' } }));
  assert.equal(validateConfig(fakeOneDrive, { project: 'my-staging', forbidPathPatterns: ['OneDrive'] }).ok, false);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('target assembly: pending + full/targeted functions', () => {
  assert.equal(assembleTargets({ pending: { hosting: true }, fnMode: 'none' }), 'hosting');
  assert.equal(assembleTargets({ pending: { hosting: true, 'firestore:rules': true }, fnMode: 'full' }), 'firestore:rules,hosting,functions');
  assert.equal(assembleTargets({ pending: {}, fnMode: 'targeted', fnNames: ['a', 'b'] }), 'functions:a,functions:b');
  assert.equal(assembleTargets({}), '');
});

test('failure backoff: none on success, 30s → 5min cap; loud line at 3+', () => {
  assert.equal(backoffMs(0), null);
  assert.equal(backoffMs(1), 30000);
  assert.equal(backoffMs(2), 60000);
  assert.equal(backoffMs(3), 120000);
  assert.equal(backoffMs(10), 300000);
  assert.match(loudFailureLine(3, 'hosting', 'my-staging', 1), /3 consecutive FAILED deploys[\s\S]*NOT landing/);
});
