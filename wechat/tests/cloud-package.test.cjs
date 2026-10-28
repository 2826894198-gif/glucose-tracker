'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { buildCloudPackages } = require('../scripts/cloud-package.cjs');
const root = path.resolve(__dirname, '..');

test('flat deployment packages load both real entries, reject unauthenticated calls, and preserve pinned source provenance', async () => {
  const packaged = await buildCloudPackages(root, ['glucose', 'recognize']);
  try {
    assert.equal(packaged.functions.length, 2);
    for (const item of packaged.functions) {
      assert.deepEqual(fs.readdirSync(item.path).sort(), ['config.json', 'index.js', 'package.json']);
      const metadata = JSON.parse(fs.readFileSync(path.join(item.path, 'package.json'), 'utf8'));
      assert.equal(metadata.dependencies, undefined);
      assert.equal(metadata.engines.node, '>=16.13');
      const source = path.join(root, 'cloudfunctions', item.name);
      assert.deepEqual(fs.readFileSync(path.join(item.path, 'config.json')), fs.readFileSync(path.join(source, 'config.json')));
      for (const file of ['index.js', 'node_modules/wx-server-sdk/package.json',
        'node_modules/bignumber.js/bignumber.js']) {
        assert.equal(item.sourceInputs[file], crypto.createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex'));
      }
      const result = await require(path.join(item.path, 'index.js')).main({ action: 'bootstrap' });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, item.name === 'glucose' ? 'AUTH_REQUIRED' : 'UNAUTHENTICATED');
    }
  } finally { packaged.cleanup(); }
  assert.equal(fs.existsSync(packaged.directory), false);
});

test('deployment packaging rejects unrelated or duplicate functions before writing a stage', async () => {
  for (const names of [[], ['../other-project'], ['glucose', 'glucose'], ['third-party']]) {
    await assert.rejects(buildCloudPackages(root, names), /只允许/);
  }
});
