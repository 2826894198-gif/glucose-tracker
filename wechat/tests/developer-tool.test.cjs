'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { assessCliResult, runDeveloperTool } = require('../scripts/developer-tool.cjs');

test('a real-shaped WeChat API rejection fails even when the tool exits with status zero', () => {
  assert.deepEqual(assessCliResult({ status: 0, stdout: '✔ IDE server has started\n', stderr: '✖ fetching cloud env list\n[error] { code: 10, message: "测试号不能使用云服务" }' }), { ok: false, exitCode: 1 });
});

test('ANSI-colored errors and failed progress lines cannot be hidden by earlier success output', () => {
  for (const output of ['\u001b[31m[error]\u001b[0m failure\n', '✔ initialize\n✖ uploading\n', 'Error: rejected']) {
    assert.equal(assessCliResult({ status: 0, stdout: output, stderr: '' }).ok, false);
  }
});

test('nonzero status, process timeout and signal termination are failures', () => {
  assert.deepEqual(assessCliResult({ status: 2 }), { ok: false, exitCode: 2 });
  assert.equal(assessCliResult({ status: null, signal: 'SIGTERM' }).ok, false);
  assert.equal(assessCliResult({ status: 0, error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) }).ok, false);
});

test('ordinary successful command output and warnings are not misclassified as rejected operations', () => {
  assert.deepEqual(assessCliResult({ status: 0, stdout: '- preparing\n✔ upload\n', stderr: 'Warning: check cloud settings\n' }), { ok: true, exitCode: 0 });
});

test('the deployment wrapper forwards diagnostics then stops instead of continuing after a zero-status error', () => {
  let calls = 0, output = '';
  const write = { write: value => { output += value; } };
  assert.throws(() => runDeveloperTool('unused-fixture-cli', ['upload'], {
    cwd: '/unused', stdout: write, stderr: write,
    spawn: (cli, args, options) => {
      calls++; assert.equal(cli, 'unused-fixture-cli'); assert.deepEqual(args, ['upload']); assert.equal(options.encoding, 'utf8');
      return { status: 0, stdout: '✔ initialize\n', stderr: '[error] denied\n' };
    },
  }), { exitCode: 1 });
  assert.equal(calls, 1); assert.match(output, /\[error\] denied/);
});
