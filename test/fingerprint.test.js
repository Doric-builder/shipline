'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { functionsFingerprint, isFunctionsUnchanged, recordFunctions, planTargets } = require('../src/fingerprint');

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  fs.mkdirSync(path.join(tmp, 'functions'));
  fs.writeFileSync(path.join(tmp, 'functions', 'index.js'), 'exports.a = 1;\n');
  fs.mkdirSync(path.join(tmp, 'functions', 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'functions', 'node_modules', 'x', 'big.js'), 'junk'.repeat(1000));
  return tmp;
}

test('stable fingerprint; safe-by-default when no marker', () => {
  const tmp = fixture();
  assert.equal(functionsFingerprint(tmp), functionsFingerprint(tmp));
  assert.equal(isFunctionsUnchanged(tmp, 'projX'), false);
  assert.deepEqual(planTargets(tmp, 'projX', ['hosting', 'functions']).targets, ['hosting', 'functions']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('record → skip; node_modules churn ignored; real edit counts; per-project markers', () => {
  const tmp = fixture();
  recordFunctions(tmp, 'projX');
  assert.equal(isFunctionsUnchanged(tmp, 'projX'), true);
  assert.deepEqual(planTargets(tmp, 'projX', ['hosting', 'functions', 'storage']),
    { targets: ['hosting', 'storage'], skipped: ['functions'] });
  fs.writeFileSync(path.join(tmp, 'functions', 'node_modules', 'x', 'big.js'), 'different'.repeat(2000));
  assert.equal(isFunctionsUnchanged(tmp, 'projX'), true);
  fs.writeFileSync(path.join(tmp, 'functions', 'index.js'), 'exports.a = 2;\n');
  assert.equal(isFunctionsUnchanged(tmp, 'projX'), false);
  assert.equal(isFunctionsUnchanged(tmp, 'projY'), false);
  fs.rmSync(tmp, { recursive: true, force: true });
});
