'use strict';
const { spawnSync } = require('node:child_process');
const { stripVTControlCharacters } = require('node:util');

function assessCliResult(result) {
  if (result.error || result.status !== 0 || result.signal) return { ok: false, exitCode: result.status || 1 };
  // The official CLI can print a rejected API response yet exit with code 0.
  // This occurred during the real cloud-environment probe (-601059). A shell
  // success alone must never be reported as a successful deployment/upload.
  const output = stripVTControlCharacters(String(result.stdout || '') + '\n' + String(result.stderr || ''));
  const failed = /^\s*(?:\[error\](?:\s|$)|[✖×]\s|Error:|error:)/m.test(output);
  return { ok: !failed, exitCode: failed ? 1 : 0 };
}

function runDeveloperTool(cli, args, { cwd, spawn = spawnSync, stdout = process.stdout, stderr = process.stderr } = {}) {
  const result = spawn(cli, args, { cwd, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGTERM' });
  if (result.stdout) stdout.write(result.stdout);
  if (result.stderr) stderr.write(result.stderr);
  const assessment = assessCliResult(result);
  if (!assessment.ok) {
    const error = new Error('微信开发者工具未确认操作成功，请核对账号权限、目标环境及云端实际状态；已停止后续步骤。');
    error.exitCode = assessment.exitCode;
    throw error;
  }
}

module.exports = { assessCliResult, runDeveloperTool };
