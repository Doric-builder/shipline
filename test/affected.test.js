'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { affectedFunctions } = require('../src/affected');

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'affected-'));
  const F = (rel, body) => {
    const p = path.join(tmp, 'functions', rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };
  F('_shared/ctx.js', 'module.exports = { db: 1 };\n');
  F('domains/billing.js', 'const { db } = require("../_shared/ctx");\nexports.topup = 1; exports.refund = 2;\n');
  F('domains/recipes.js', 'const { db } = require("../_shared/ctx");\nexports.recipeList = 1;\n');
  F('turn/run.js', 'require("../_shared/ctx"); require("../domains/billing");\nexports.runAgent = 1;\n');
  F('domains/orphan.js', 'exports.dead = 1;\n');
  F('tests/x.test.js', 'require("../domains/billing");\n');
  F('NOTES.md', '# map\n');
  F('index.js',
    'exports.topup = require("./domains/billing").topup;\n' +
    'exports.refund = require("./domains/billing").refund;\n' +
    'exports.recipeList = require("./domains/recipes").recipeList;\n' +
    'exports.runAgent = require("./turn/run").runAgent;\n' +
    'exports.version = "1.0.0";\n');
  F('package.json', '{}\n');
  return tmp;
}
const R = (tmp, files, opts) => affectedFunctions(tmp, files.map((f) => path.join(tmp, 'functions', f)), opts);

test('leaf domain edit → just its functions + inline riders', () => {
  const tmp = fixture();
  const r = R(tmp, ['domains/recipes.js']);
  assert.equal(r.mode, 'targeted');
  assert.deepEqual(r.functions, ['recipeList', 'version']);
  assert.deepEqual(r.inline, ['version']);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('shared-reach and core files force FULL (never under-deploy)', () => {
  const tmp = fixture();
  assert.equal(R(tmp, ['domains/billing.js']).mode, 'full');   // reaches 4/5 ≥ 60%
  assert.equal(R(tmp, ['_shared/ctx.js']).mode, 'full');
  assert.equal(R(tmp, ['index.js']).mode, 'full');
  assert.equal(R(tmp, ['package.json']).mode, 'full');
  assert.equal(R(tmp, ['domains/orphan.js']).mode, 'full');    // unmapped → can't prove safety
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('ignorable-only changes → none; mixed → targeted with ignorables dropped', () => {
  const tmp = fixture();
  assert.equal(R(tmp, ['tests/x.test.js']).mode, 'none');
  assert.equal(R(tmp, ['NOTES.md']).mode, 'none');
  const r = R(tmp, ['domains/recipes.js', 'tests/x.test.js']);
  assert.deepEqual(r.functions, ['recipeList', 'version']);
  assert.equal(affectedFunctions(tmp, [path.join(tmp, 'index.html')]).mode, 'none');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('transitive closure: an edit reaches functions that require it indirectly', () => {
  const tmp = fixture();
  const r = R(tmp, ['turn/run.js']);
  assert.deepEqual(r.functions, ['runAgent', 'version']);
  fs.rmSync(tmp, { recursive: true, force: true });
});
