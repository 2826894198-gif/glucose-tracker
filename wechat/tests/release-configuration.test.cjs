'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { inspectConfiguration, parseConfigureArgs, configure } = require('../scripts/configuration.cjs');

const APPID = 'wx0123456789abcdef'; // Format fixture only; never submitted to WeChat.
const ENV = 'glucose-fixture-123';
function fixture(t, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'glucose-release-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'miniprogram'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ appid: 'touristappid', setting: { urlCheck: true } }));
  fs.writeFileSync(path.join(root, 'miniprogram/config.js'), 'module.exports = ' + JSON.stringify({ cloudEnv: '', functionName: 'glucose', ocrFunctionName: 'recognize', version: '0.1.0', ...extra }));
  for (const name of ['configuration.cjs', 'configure.cjs', 'readiness.cjs', 'deploy.cjs', 'upload.cjs', 'developer-tool.cjs']) fs.copyFileSync(path.join(__dirname, '../scripts', name), path.join(root, 'scripts', name));
  return root;
}
function local(root, source) { fs.writeFileSync(path.join(root, 'miniprogram/config.local.js'), source); }
function run(root, script, args = []) { return spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8', timeout: 5000 }); }

test('unconfigured release checks do not invent public IDs or modify project files', t => {
  const root = fixture(t), file = path.join(root, 'project.config.json'), before = fs.readFileSync(file);
  const result = run(root, 'readiness.cjs');
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configurationComplete, false); assert.equal(report.missing.length, 2);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.equal(fs.existsSync(path.join(root, 'miniprogram/config.local.js')), false);
});

test('nonempty but malformed and placeholder cloud environments never pass readiness', t => {
  const root = fixture(t);
  for (const cloudEnv of [' ', '../another-env', 'https://example.test', {}, 123, 'YOUR-CLOUD-ENV', 'example-env']) {
    local(root, 'module.exports = ' + JSON.stringify({ cloudEnv }));
    const result = inspectConfiguration(root);
    assert.equal(result.complete, false);
    assert.ok(result.missing.includes('Associated active WeChat cloud environment ID'));
  }
});

test('a broken local file blocks a valid base environment instead of silently falling back', t => {
  const root = fixture(t, { cloudEnv: ENV });
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ appid: APPID }));
  local(root, 'module.exports = { cloudEnv: ');
  const result = run(root, 'readiness.cjs');
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.configurationComplete, false); assert.equal(report.configurationErrors.length, 1);
  assert.match(report.configurationErrors[0], /config.local.js/);
});

test('release checks treat configuration as public data and never echo secrets or run require', t => {
  const root = fixture(t);
  const secret = 'fixture-secret-not-an-actual-credential';
  local(root, `module.exports = ${JSON.stringify({ cloudEnv: ENV, OCR_TOKEN: secret })}`);
  let result = run(root, 'readiness.cjs');
  assert.equal(result.status, 2); assert.equal((result.stdout + result.stderr).includes(secret), false);
  local(root, "module.exports = require('node:fs').readFileSync('unrelated-file')");
  result = run(root, 'readiness.cjs');
  assert.equal(result.status, 2); assert.equal(result.stderr, '');
});

test('configure rejects duplicate, unknown, missing and placeholder arguments before writing', t => {
  const root = fixture(t), original = fs.readFileSync(path.join(root, 'project.config.json'));
  const valid = ['--appid', APPID, '--env', ENV];
  for (const args of [[], ['--appid'], ['--appid', APPID, '--env'], [...valid, '--env', 'different-env'], [...valid, '--token', 'never-a-real-secret'], ['--appid', 'wx-not-real', '--env', ENV], ['--appid', APPID, '--env', 'REPLACE-ENV']]) {
    assert.throws(() => parseConfigureArgs(args));
    assert.equal(run(root, 'configure.cjs', args).status, 1);
    assert.deepEqual(fs.readFileSync(path.join(root, 'project.config.json')), original);
  }
  assert.deepEqual(parseConfigureArgs(valid), { appid: APPID, cloudEnv: ENV });
});

test('configuring public IDs preserves project settings and existing public overrides', t => {
  const root = fixture(t);
  local(root, "// Retained display version\nmodule.exports = { version: '0.2.0', cloudEnv: 'previous-fixture-env' };\n");
  configure(root, { appid: APPID, cloudEnv: ENV });
  const result = inspectConfiguration(root);
  assert.equal(result.complete, true); assert.equal(result.project.setting.urlCheck, true);
  assert.equal(result.config.version, '0.2.0'); assert.equal(result.config.cloudEnv, ENV);
  const report = JSON.parse(run(root, 'readiness.cjs').stdout);
  assert.equal(report.configurationComplete, true);
  assert.equal(report.externalUnverified.length, 3); // Public IDs are not cloud acceptance.
});

test('failed second configuration replacement restores previous project and local bytes', t => {
  const root = fixture(t), projectFile = path.join(root, 'project.config.json'), localFile = path.join(root, 'miniprogram/config.local.js');
  local(root, '// original bytes\nmodule.exports = {};\n');
  const beforeProject = fs.readFileSync(projectFile), beforeLocal = fs.readFileSync(localFile);
  const rename = fs.renameSync;
  const mock = t.mock.method(fs, 'renameSync', (source, destination) => {
    if (destination === localFile) throw new Error('simulated second replacement failure');
    return rename(source, destination);
  });
  assert.throws(() => configure(root, { appid: APPID, cloudEnv: ENV }), /写入未完成/);
  mock.mock.restore();
  assert.deepEqual(fs.readFileSync(projectFile), beforeProject); assert.deepEqual(fs.readFileSync(localFile), beforeLocal);
  assert.equal(fs.readdirSync(root).some(name => name.endsWith('.tmp')), false);
  assert.equal(fs.readdirSync(path.dirname(localFile)).some(name => name.endsWith('.tmp')), false);
});

test('invalid local files are preserved and never overwritten by configure', t => {
  const root = fixture(t);
  local(root, 'module.exports = { broken');
  const file = path.join(root, 'miniprogram/config.local.js'), before = fs.readFileSync(file);
  assert.throws(() => configure(root, { appid: APPID, cloudEnv: ENV }), /config.local.js/);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('deploy and upload stop before dependency installation or developer-tool calls when configuration is invalid', t => {
  const root = fixture(t, { cloudEnv: ENV });
  fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ appid: APPID }));
  local(root, 'module.exports = { invalid');
  for (const [script, args] of [['deploy.cjs', ['--with-ocr']], ['upload.cjs', ['--version', '0.1.0']]]) {
    const result = run(root, script, args);
    assert.equal(result.status, 2); assert.match(result.stdout, /"configurationComplete": false/);
    assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
    assert.doesNotMatch(result.stdout, /CLI.*完成|本地依赖核验/);
  }
});
