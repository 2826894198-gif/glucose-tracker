#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomBytes } = require('node:crypto');
const assert = require('node:assert/strict');
const { createRecognizer } = require('../cloudfunctions/recognize/service.js');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length) {
  console.error('运行 npm run test:ocr；需先构建 family-glucose-ocr:0.1.0 的 Linux amd64 镜像。');
  process.exit(1);
}
const fixture = process.env.OCR_SYNTHETIC_FIXTURE ? path.resolve(process.env.OCR_SYNTHETIC_FIXTURE) : null;
const script = path.join(root, 'tests/ocr-runtime.test.py');
if (!fixture || !fs.existsSync(fixture)) { console.error('请用 OCR_SYNTHETIC_FIXTURE 指定自己制作的合成仪表测试图；仓库不含健康照片。'); process.exit(2); }
// No network, host ports, real credentials, user records, or writable host mount.
const result = spawnSync('docker', ['run', '--rm', '--init', '--pull', 'never', '--platform', 'linux/amd64',
  '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m',
  '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '2',
  '--mount', `type=bind,source=${fixture},target=/fixtures/demo-meter.png,readonly`,
  '--mount', `type=bind,source=${script},target=/tests/ocr-runtime.test.py,readonly`,
  'family-glucose-ocr:0.1.0', 'python', '/tests/ocr-runtime.test.py'], {
  cwd: root, encoding: 'utf8', timeout: 120000, killSignal: 'SIGTERM',
});
process.stdout.write(String(result.stdout || '').replace(/^OCR_RUNTIME_RESULT=.*(?:\n|$)/m, ''));
process.stderr.write(String(result.stderr || ''));
if (result.error) console.error('本地容器验证未完成，请检查 Docker 与本地镜像；未执行云部署。');
if (result.status !== 0 || result.error) process.exitCode = 1;
else (async () => {
  try {
    const match = /^OCR_RUNTIME_RESULT=(.+)$/m.exec(result.stdout);
    assert.ok(match, 'The actual worker must provide its sample inference response');
    const inference = JSON.parse(match[1]);
    const bytes = fs.readFileSync(fixture);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png' : 'image/jpeg';
    const image = 'data:' + mime + ';base64,' + bytes.toString('base64');
    // Link the real container's HTTP response to the production parser/bridge.
    // Identity and HTTPS transport are explicit fixtures; no real WeChat call.
    const recognize = createRecognizer({ env: {
      OCR_URL: 'https://ocr-fixture.invalid/api/ocr', OCR_TOKEN: randomBytes(32).toString('hex'),
    }, request: async (_url, _token, payload) => {
      assert.deepEqual(payload, { image });
      return inference.payload;
    } });
    const parsed = await recognize({ image }, { APPID: 'wx0123456789abcdef', OPENID: 'synthetic-runtime-fixture' });
    assert.equal(parsed.ok, true); assert.equal(parsed.data.value, '6.1'); assert.equal(parsed.data.unit, 'mmol/L');
    const hash = file => createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
    const report = {
      verifiedAt: new Date().toISOString(), platform: 'linux/amd64 / CPython 3.11',
      containerTestsPassed: 9, fixture: inference.fixture, fixtureSha256: createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
      modelStartupSeconds: inference.startupSeconds, sampleHttpInferenceSeconds: inference.inferenceSeconds,
      productionParserResult: { value: parsed.data.value, unit: parsed.data.unit },
      trustedIdentityAndHttpsTransport: 'fixtures; no live WeChat/cloud connection',
      sourceHashes: Object.fromEntries(['cloudfunctions/recognize/runtime/app.py', 'cloudfunctions/recognize/runtime/Dockerfile', 'cloudfunctions/recognize/runtime/requirements.lock.txt', 'cloudfunctions/recognize/service.js', 'cloudfunctions/recognize/parse-reading.mjs', 'tests/ocr-runtime.test.py', 'scripts/test-ocr.cjs'].map(file => [file, hash(file)])),
    };
    fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
    fs.writeFileSync(path.join(root, 'artifacts/ocr-runtime-verification.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ actualWorkerAndProductionParser: 'passed', value: parsed.data.value, unit: parsed.data.unit, report: 'artifacts/ocr-runtime-verification.json' }));
  } catch (_) {
    console.error('容器结果与生产识别解析的联测未通过；未连接微信云端。');
    process.exitCode = 1;
  }
})();
