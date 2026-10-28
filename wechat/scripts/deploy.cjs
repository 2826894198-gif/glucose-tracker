#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { inspectConfiguration } = require('./configuration.cjs');
const { runDeveloperTool } = require('./developer-tool.cjs');
const root = path.resolve(__dirname, '..');
const cli = '/Applications/wechatwebdevtools.app/Contents/MacOS/cli';
const argv = process.argv.slice(2);

if (argv.includes('--help')) {
  console.log('npm run deploy [-- --with-ocr]\n部署 glucose；--with-ocr 同时部署 recognize 桥接。需先完成云数据库集合、规则、索引；不登录、不购买、不创建或覆盖数据库规则。');
  process.exit(0);
}

function stop(message, code = 1) { console.error(message); process.exit(code); }
function run(command, args, cwd = root, timeout = 300000) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout, killSignal: 'SIGTERM' });
  if (result.error || result.status !== 0) stop(result.error?.message || `命令未完成（退出码 ${result.status}）；没有继续部署。`, result.status || 1);
}

// No npm installation or developer-tool request happens before this gate.
run(process.execPath, [path.join(__dirname, 'readiness.cjs')], root, 10000);
if (argv.some((arg) => arg !== '--with-ocr')) stop('只支持 --with-ocr；运行 npm run deploy -- --help 查看说明。');
try { fs.accessSync(cli, fs.constants.X_OK); } catch { stop('本机官方微信开发者工具 CLI 不存在。'); }

const { config, project, complete } = inspectConfiguration(root);
if (!complete) stop('公开配置发生变化，请重新运行 npm run ready 后再部署。');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const version = spawnSync(npm, ['--version'], { encoding: 'utf8', timeout: 10000 });
const [major, minor] = String(version.stdout || '').trim().split('.').map(Number);
if (version.status !== 0 || !(major > 8 || major === 8 && minor >= 3)) stop('需要 npm >= 8.3.0，确保限定 overrides 生效。');

function prepare(name) {
  const directory = path.join(root, 'cloudfunctions', name);
  if (!fs.existsSync(path.join(directory, 'package-lock.json'))) stop(`${name} 缺少 package-lock.json，拒绝不锁定依赖的部署。`);
  // Install locally: --remote-npm-install would omit local node_modules and
  // delegate overrides handling to an installer whose npm version we cannot attest.
  run(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], directory);
  try {
    const fromFunction = createRequire(path.join(directory, 'index.js'));
    const fromSDK = createRequire(fromFunction.resolve('@cloudbase/node-sdk'));
    const fromDatabase = createRequire(fromSDK.resolve('@cloudbase/database'));
    const versions = {
      sdk: fromFunction('wx-server-sdk/package.json').version,
      axios: fromSDK('axios/package.json').version,
      unset: fromDatabase('lodash.unset/package.json').version,
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    if (versions.sdk !== manifest.dependencies['wx-server-sdk'] ||
        versions.axios !== manifest.overrides['@cloudbase/node-sdk'].axios ||
        versions.unset !== manifest.overrides['@cloudbase/database']['lodash.unset']) {
      stop(`${name} 实际 SDK/维护依赖版本不匹配，拒绝部署。`);
    }
    console.log(`${name} 本地依赖核验：wx-server-sdk ${versions.sdk} / Axios ${versions.axios} / lodash.unset ${versions.unset}`);
  } catch (error) { stop(`${name} 依赖核验失败：${error.message}`); }
}

const functions = argv.includes('--with-ocr') ? ['glucose', 'recognize'] : ['glucose'];
for (const name of functions) prepare(name);
run(process.execPath, ['--test', path.join(root, 'tests/cloud-service.test.cjs'), path.join(root, 'tests/cloud-dependency.test.cjs')]);
if (functions.includes('recognize')) run(process.execPath, ['--test', path.join(root, 'tests/recognize.test.cjs')]);
async function deploy() {
  const stage = await require('./cloud-package.cjs').buildCloudPackages(root, functions);
  const manifest = { appId: project.appid, environmentId: config.cloudEnv,
    preparedAt: new Date().toISOString(), status: 'prepared', format: 'flat-commonjs-bundle',
    compilerVersion: require('esbuild').version, functions: stage.functions };
  const evidence = path.join(root, 'artifacts', 'cloud-deployment-manifest.json');
  fs.mkdirSync(path.dirname(evidence), { recursive: true });
  try {
    fs.writeFileSync(evidence, JSON.stringify(manifest, null, 2) + '\n');
    console.log('已将锁定依赖打包为独立 Node.js 文件；不使用云端 npm 安装。将调用已登录的开发者工具部署。');
    runDeveloperTool(cli, ['cloud', 'functions', 'deploy', '--appid', project.appid, '--env', config.cloudEnv,
      '--paths', ...stage.functions.map(item => item.path)], { cwd: root });
    manifest.status = 'cli-confirmed'; manifest.completedAt = new Date().toISOString();
    fs.writeFileSync(evidence, JSON.stringify(manifest, null, 2) + '\n');
  } finally { stage.cleanup(); }
  console.log('CLI 部署命令完成。仍需核验平台运行配置、数据库权限/索引及真实微信调用；本脚本未创建或更改数据库。');
  if (functions.includes('recognize')) console.log('recognize 仅为桥接；未配置 HTTPS 容器与服务端 token 时返回 OCR_NOT_CONFIGURED。');
}
deploy().catch(error => stop(error.message, error.exitCode || 1));
