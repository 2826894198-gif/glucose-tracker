#!/usr/bin/env node
'use strict';

// Read-only source checks and native WXML/WXSS compilation; never logs in or uploads.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const errors = [];
const notes = [];
const rel = (name) => path.relative(root, name).split(path.sep).join('/');
const fail = (message) => errors.push(message);
const within = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const exists = (name) => fs.existsSync(name) && fs.statSync(name).isFile();

function json(name) {
  try { return JSON.parse(fs.readFileSync(name, 'utf8')); }
  catch (error) { fail(`${rel(name)}: ${error.message}`); return {}; }
}

function directorySetting(project, name) {
  const value = project[name];
  if (typeof value !== 'string' || !value.trim()) {
    fail(`project.config.json 缺少 ${name}`);
    return null;
  }
  const directory = path.resolve(root, value);
  if (!within(root, directory) || directory === root) {
    fail(`${name} 必须是工程内独立目录`);
    return null;
  }
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
    fail(`${name} 目录不存在`);
    return null;
  }
  return directory;
}

function walk(directory, skip = () => false) {
  const result = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, item.name);
    if (skip(full, item)) continue;
    // A symlink can escape the package root or hide a dependency/private file.
    if (item.isSymbolicLink()) { fail(`${rel(full)}: 不允许打包符号链接`); continue; }
    if (item.isDirectory()) result.push(...walk(full, skip));
    else if (item.isFile()) result.push(full);
  }
  return result;
}

function globPattern(value) {
  let pattern = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '*' && value[index + 1] === '*') {
      index += 1;
      if (value[index + 1] === '/') { index += 1; pattern += '(?:.*/)?'; }
      else pattern += '.*';
    } else if (char === '*') pattern += '[^/]*';
    else if (char === '?') pattern += '[^/]';
    else pattern += char.replace(/[\\^$+?.()|{}\[\]]/g, '\\$&');
  }
  return new RegExp(`^${pattern}$`);
}

function packIgnores(project) {
  const entries = project.packOptions?.ignore ?? [];
  if (!Array.isArray(entries)) { fail('packOptions.ignore 必须是数组'); return () => false; }
  const tests = entries.map((entry) => {
    if (!entry || typeof entry.value !== 'string') {
      fail('packOptions.ignore 存在无效规则'); return () => false;
    }
    const value = entry.value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '');
    if (entry.type === 'file') return (name) => name === value;
    if (entry.type === 'folder') return (name) => name === value || name.startsWith(value + '/');
    if (entry.type === 'suffix') return (name) => name.endsWith(value);
    if (entry.type === 'prefix') return (name) => name.startsWith(value);
    if (entry.type === 'glob') { const pattern = globPattern(value); return (name) => pattern.test(name); }
    fail(`packOptions.ignore 不支持的规则类型: ${String(entry.type)}`);
    return () => false;
  });
  return (name) => tests.some((test) => test(name));
}

function pageFiles(miniRoot, app) {
  const pages = [];
  if (!Array.isArray(app.pages) || !app.pages.length) fail('app.json pages 必须包含至少一个页面');
  else pages.push(...app.pages);
  const packages = app.subPackages ?? app.subpackages ?? [];
  if (!Array.isArray(packages)) fail('app.json subPackages 必须是数组');
  const subRoots = [];
  for (const pack of Array.isArray(packages) ? packages : []) {
    if (!pack || typeof pack.root !== 'string' || !Array.isArray(pack.pages)) {
      fail('app.json 存在无效分包声明'); continue;
    }
    const subRoot = path.resolve(miniRoot, pack.root);
    if (!within(miniRoot, subRoot) || subRoot === miniRoot) { fail('分包 root 必须位于小程序目录内'); continue; }
    subRoots.push(subRoot);
    for (const page of pack.pages) pages.push(`${pack.root}/${page}`);
  }
  const seen = new Set();
  for (const page of pages) {
    if (typeof page !== 'string' || !page || page.startsWith('/') || /\.(js|json|wxml|wxss)$/.test(page)) {
      fail('app.json 存在无效页面路径'); continue;
    }
    const base = path.resolve(miniRoot, page);
    if (!within(miniRoot, base)) { fail(`页面路径越界: ${page}`); continue; }
    if (seen.has(base)) fail(`页面重复声明: ${page}`);
    seen.add(base);
    for (const extension of ['.js', '.json', '.wxml', '.wxss']) {
      if (!exists(base + extension)) fail(`缺少页面文件: ${rel(base + extension)}`);
    }
    if (exists(base + '.json')) json(base + '.json');
  }
  return { pages: seen.size, subRoots };
}

function nativeCompile(miniRoot, files) {
  const compilerRoot = '/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec';
  const outputRoot = path.join(root, 'artifacts', 'compile');
  fs.mkdirSync(outputRoot, { recursive: true });
  // Both compilers were verified locally with two independent input files.
  const jobs = [
    { binary: 'wcc', extension: '.wxml', output: 'wxml.js', flags: [] },
    { binary: 'wcsc', extension: '.wxss', output: 'wxss.js', flags: ['-lc', '-js'] },
  ];
  let passed = 0;
  for (const job of jobs) {
    const binary = path.join(compilerRoot, job.binary);
    try { fs.accessSync(binary, fs.constants.X_OK); }
    catch { fail(`${job.binary} 未安装；原生 ${job.extension} 编译未验证`); continue; }
    const inputs = files.filter((name) => name.endsWith(job.extension)).map((name) => path.relative(miniRoot, name));
    if (!inputs.length) { fail(`没有可编译的 ${job.extension} 文件`); continue; }
    const output = path.join(outputRoot, job.output);
    if (fs.existsSync(output)) fs.unlinkSync(output);
    const result = spawnSync(binary, [...job.flags, '-o', output, ...inputs], {
      cwd: miniRoot, encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024,
    });
    if (result.error || result.status !== 0 || !exists(output)) {
      const detail = result.error?.code === 'ETIMEDOUT' ? '超过 30 秒已终止' :
        (result.error?.message || result.stderr || result.stdout || `退出码 ${result.status}`).trim().slice(0, 600);
      fail(`${job.binary} 编译失败: ${detail}`);
    } else { notes.push(`${job.binary} 编译通过（${inputs.length} 个 ${job.extension}）`); passed += 1; }
  }
  return passed === jobs.length;
}

const project = json(path.join(root, 'project.config.json'));
if (project.compileType !== 'miniprogram') fail('compileType 必须是 miniprogram');
const miniRoot = directorySetting(project, 'miniprogramRoot');
const cloudRoot = directorySetting(project, 'cloudfunctionRoot');
if (miniRoot && cloudRoot && (within(miniRoot, cloudRoot) || within(cloudRoot, miniRoot))) {
  fail('小程序主包和云函数目录必须相互独立');
}

if (miniRoot) {
  const app = json(path.join(miniRoot, 'app.json'));
  const { pages, subRoots } = pageFiles(miniRoot, app);
  const ignored = packIgnores(project);
  const allFiles = walk(miniRoot);
  const files = allFiles.filter((name) => !ignored(path.relative(miniRoot, name).split(path.sep).join('/')));
  const mainFiles = files.filter((name) => !subRoots.some((subRoot) => within(subRoot, name)));
  let packageBytes = 0;
  for (const name of mainFiles) packageBytes += fs.statSync(name).size;
  notes.push(`${pages} 个页面；主包源文件 ${(packageBytes / 1024).toFixed(1)} KiB / 2048 KiB（上传压缩包由微信再核验）`);
  if (packageBytes > 2 * 1024 * 1024) fail('主包源文件超过保守 2 MiB 上限，请压缩资源或分包');
  for (const extension of ['.js', '.wxss', '.json']) {
    if (!exists(path.join(miniRoot, 'app' + extension))) fail(`缺少 app${extension}`);
  }
  if (app.sitemapLocation && !exists(path.resolve(miniRoot, app.sitemapLocation))) fail('sitemapLocation 文件不存在');
  for (const name of files) {
    const relative = path.relative(miniRoot, name).split(path.sep).join('/');
    if (relative.split('/').includes('node_modules')) fail(`${relative}: 主包不可包含 node_modules`);
    if (/(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx|pkcs12)$/i.test(relative)) fail(`${relative}: 敏感配置/密钥文件未排除`);
    if (/\.(?:js|cjs|json|txt|md)$/i.test(name)) {
      const source = fs.readFileSync(name, 'utf8');
      if (/-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(source)) fail(`${relative}: 含私钥内容`);
      if (/(?:require\s*\(\s*['"]|from\s*['"])(?:wx-server-sdk|@cloudbase\/node-sdk)(?:['"/])/.test(source)) {
        fail(`${relative}: 服务端 SDK 不可放入小程序包`);
      }
    }
  }
  // Avoid claiming successful compilation if a required page is still absent.
  if (!errors.some((message) => message.startsWith('缺少页面文件'))) nativeCompile(miniRoot, files);
}

const jsFiles = walk(root, (name, item) => item.isDirectory() &&
  ['node_modules', 'artifacts', '.git', '.venv', '__pycache__', 'runtime'].includes(item.name))
  .filter((name) => /\.(?:js|cjs)$/.test(name) && rel(name) !== 'scripts/domain-entry.js');
let jsPassed = 0;
for (const name of jsFiles) {
  try { new vm.Script(fs.readFileSync(name, 'utf8'), { filename: rel(name) }); jsPassed += 1; }
  catch (error) { fail(`${rel(name)} JS 语法: ${error.message}`); }
}
notes.push(`${jsPassed}/${jsFiles.length} 个 JavaScript 文件语法通过（ESM 构建入口由 build 检查）`);
for (const note of notes) console.log(`✓ ${note}`);
for (const error of errors) console.error(`✗ ${error}`);
if (errors.length) { console.error(`检查未通过：${errors.length} 项`); process.exitCode = 1; }
else console.log('静态与原生模板检查通过；未执行登录、上传或部署。');
