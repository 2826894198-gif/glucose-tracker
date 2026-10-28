#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runDeveloperTool } = require('./developer-tool.cjs');
const root = path.resolve(__dirname, '..');
const cli = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  console.log('npm run upload -- --version 0.1.0 [--desc "家人血糖本体验版"]\n仅此命令会上传代码；不会自动部署云函数、登录、购买、设为体验版或添加体验成员。请先完成真机云端验收。');
  process.exit(0);
}

function stop(message, code = 1) { console.error(message); process.exit(code); }
function run(command, args, timeout = 300000) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', timeout, killSignal: 'SIGTERM' });
  if (result.error || result.status !== 0) stop(result.error?.message || `命令未完成（退出码 ${result.status}）；没有继续上传。`, result.status || 1);
}

// Absent public IDs must stop before build, tests, or a developer-tool request.
run(process.execPath, [path.join(__dirname, 'readiness.cjs')], 10000);
const options = {};
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index], value = argv[index + 1];
  if (!['--version', '--desc'].includes(key) || !value || value.startsWith('--') || options[key]) stop('参数无效。运行 npm run upload -- --help 查看说明。');
  options[key] = value;
}
if (!options['--version'] || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-.][A-Za-z0-9.-]+)?$/.test(options['--version'])) stop('必须提供明确版本号，例如 --version 0.1.0。');
const description = options['--desc'] || '家人血糖本：本人登录、个人云保存与离线待同步';
if (description.length > 200) stop('上传说明请限制在 200 字内。');
try { fs.accessSync(cli, fs.constants.X_OK); } catch { stop('本机官方微信开发者工具 CLI 不存在。'); }
run(process.execPath, [path.join(__dirname, 'build.cjs')]);
run(process.execPath, [path.join(__dirname, 'check.cjs')]);
const tests = fs.readdirSync(path.join(root, 'tests')).filter((name) => name.endsWith('.test.cjs')).sort().map((name) => path.join(root, 'tests', name));
run(process.execPath, ['--test', ...tests]);
console.log('本地检查通过；将通过当前已登录开发者工具上传开发版本。真实云端验收仍需按注册接入指南确认。');
try { runDeveloperTool(cli, ['upload', '--project', root, '--version', options['--version'], '--desc', description], { cwd: root }); }
catch (error) { stop(error.message, error.exitCode || 1); }
console.log('CLI 上传命令完成。请在微信公众平台核对版本，将其设为体验版并添加父母为体验成员；这一步未由本脚本自动执行。');
