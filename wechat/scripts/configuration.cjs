'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const APP_ID = /^wx[a-f0-9]{16}$/;
const ENV_ID = /^[A-Za-z0-9][A-Za-z0-9-]{2,127}$/;
const PUBLIC_FIELDS = ['cloudEnv', 'functionName', 'ocrFunctionName', 'version'];
const isObject = value => value && typeof value === 'object' && !Array.isArray(value);

function readPublicModule(file, optional = false) {
  if (optional && !fs.existsSync(file)) return {};
  // Configuration is data. Do not execute require/process/network calls while
  // checking a broken local file, and never fall back to a different environment.
  const source = fs.readFileSync(file, 'utf8');
  const serialized = vm.runInNewContext(source + '\n; JSON.stringify(module.exports)', {
    module: { exports: {} },
  }, { timeout: 1000, filename: path.basename(file) });
  const value = JSON.parse(serialized);
  if (!isObject(value) || Object.keys(value).some(key => !PUBLIC_FIELDS.includes(key))) {
    throw new Error('Only public mini-program configuration fields are allowed');
  }
  return value;
}

function inspectConfiguration(root) {
  const errors = [], missing = [];
  let project = {}, base = {}, local = {};
  try {
    project = JSON.parse(fs.readFileSync(path.join(root, 'project.config.json'), 'utf8'));
    if (!isObject(project)) throw new Error('Invalid project');
  } catch (_) { errors.push('project.config.json 无法读取或格式无效。'); }
  try { base = readPublicModule(path.join(root, 'miniprogram/config.js')); }
  catch (_) { errors.push('miniprogram/config.js 无法读取或包含无效配置。'); }
  try { local = readPublicModule(path.join(root, 'miniprogram/config.local.js'), true); }
  catch (_) { errors.push('miniprogram/config.local.js 无法读取或包含非公开配置；已停止，不会忽略该文件或切换环境。'); }
  const config = { ...base, ...local };
  if (typeof project.appid !== 'string' || !APP_ID.test(project.appid)) missing.push('Dedicated real mini-program AppID');
  if (typeof config.cloudEnv !== 'string' || !ENV_ID.test(config.cloudEnv) || /^(?:YOUR|REPLACE|example)/i.test(config.cloudEnv)) missing.push('Associated active WeChat cloud environment ID');
  if (config.functionName !== 'glucose' || config.ocrFunctionName !== 'recognize') errors.push('云函数名称与本工程不一致，应为 glucose 和 recognize。');
  if (typeof config.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-.][A-Za-z0-9.-]+)?$/.test(config.version)) errors.push('小程序版本号无效。');
  return { project, base, local, config, missing, errors, complete: !missing.length && !errors.length };
}

function parseConfigureArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!['--appid', '--env'].includes(key) || typeof value !== 'string' || !value || value.startsWith('--') || result[key]) throw new Error('参数无效：只接受一次 --appid 与一次 --env。');
    result[key] = value;
  }
  if (!APP_ID.test(result['--appid'] || '') || !ENV_ID.test(result['--env'] || '') || /^(?:YOUR|REPLACE|example)/i.test(result['--env'])) {
    throw new Error('请提供真实格式的专用 AppID 与云环境 ID，不需要密钥。');
  }
  return { appid: result['--appid'], cloudEnv: result['--env'] };
}

function configure(root, values) {
  // Revalidate the public entry point as well as the command-line parser.
  parseConfigureArgs(['--appid', values.appid, '--env', values.cloudEnv]);
  const current = inspectConfiguration(root);
  if (current.errors.length) throw new Error(current.errors.join('\n'));
  const projectFile = path.join(root, 'project.config.json');
  const localFile = path.join(root, 'miniprogram/config.local.js');
  const oldProject = fs.readFileSync(projectFile);
  const oldLocal = fs.existsSync(localFile) ? fs.readFileSync(localFile) : null;
  const nextProject = JSON.stringify({ ...current.project, appid: values.appid }, null, 2) + '\n';
  const nextLocal = `module.exports = ${JSON.stringify({ ...current.local, cloudEnv: values.cloudEnv }, null, 2)};\n`;
  // Stage both files before replacing either one. On an ordinary I/O failure,
  // restore the exact previous bytes instead of leaving mixed public IDs.
  const suffix = `.configure-${process.pid}-${Date.now()}.tmp`;
  const projectTemp = projectFile + suffix, localTemp = localFile + suffix;
  let projectChanged = false;
  try {
    fs.writeFileSync(projectTemp, nextProject, { flag: 'wx' });
    fs.writeFileSync(localTemp, nextLocal, { flag: 'wx' });
    fs.renameSync(projectTemp, projectFile); projectChanged = true;
    fs.renameSync(localTemp, localFile);
  } catch (error) {
    if (projectChanged) fs.writeFileSync(projectFile, oldProject);
    if (oldLocal !== null && !fs.existsSync(localFile)) fs.writeFileSync(localFile, oldLocal);
    throw new Error('公开配置写入未完成，已保留原配置；请检查文件权限和磁盘空间。');
  } finally {
    for (const file of [projectTemp, localTemp]) if (fs.existsSync(file)) fs.unlinkSync(file);
  }
}

module.exports = { inspectConfiguration, parseConfigureArgs, configure };
