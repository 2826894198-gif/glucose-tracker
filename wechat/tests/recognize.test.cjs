'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const provenance = require('../shared/provenance.json');
const { createRecognizer, validateImage, endpointFromEnvironment, MAX_BASE64_LENGTH } = require('../cloudfunctions/recognize/service');
const { accountKey } = require('../cloudfunctions/glucose/service.cjs');

const validContext = { OPENID: 'server-issued-person-a', APPID: 'wx0123456789abcdef' };
const env = { OCR_URL: 'https://ocr.example.com/api/ocr', OCR_TOKEN: 'test-only-token-with-at-least-32-characters' };
const image = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, '../miniprogram/assets/demo-meter.png')).toString('base64')}`;
const observation = (text, box = { x: .2, y: .4, width: .3, height: .2 }) => ({ text, confidence: .99, box });
const responseFor = value => ({ observations: [observation(value), observation('mmol/L', { x: .25, y: .32, width: .25, height: .04 })] });

// Exercise the actual deployed entry with injected cloud context and transport;
// this never creates a cloud client or makes a network request.
function entryFixture({ getContext = () => validContext, request = async () => responseFor('7.8'), onRecognize = () => {} } = {}) {
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports,
    require(name) {
      if (name === 'wx-server-sdk') return { init() {}, DYNAMIC_CURRENT_ENV: 'fixture-env', getWXContext: getContext };
      if (name === './service') return { createRecognizer: () => {
        const recognize = createRecognizer({ env, request });
        return (...args) => { onRecognize(); return recognize(...args); };
      } };
      if (name === 'node:crypto') return require(name);
      throw new Error('Unexpected entry dependency');
    },
  };
  new vm.Script(fs.readFileSync(path.join(__dirname, '../cloudfunctions/recognize/index.js'), 'utf8')).runInNewContext(sandbox);
  return module.exports.main;
}

test('deployed entry rejects missing/forged scope and account changes before reading photos or invoking OCR', async () => {
  let current = validContext;
  let serviceCalls = 0, imageReads = 0, externalCalls = 0, contextReads = 0;
  const main = entryFixture({
    getContext: () => { contextReads += 1; return current; },
    onRecognize: () => { serviceCalls += 1; },
    request: async () => { externalCalls += 1; return responseFor('7.8'); },
  });
  const expectedAccountId = accountKey(validContext);
  const attempts = [
    { context: validContext },
    { context: validContext, expectedAccountId: 'forged-account' },
    { context: validContext, expectedAccountId: null },
    { context: { ...validContext, OPENID: 'server-issued-person-b' }, expectedAccountId },
    { context: { ...validContext, APPID: 'wxabcdef0123456789' }, expectedAccountId },
  ];
  for (const attempt of attempts) {
    current = attempt.context;
    const event = { expectedAccountId: attempt.expectedAccountId, owner: expectedAccountId, userInfo: validContext };
    Object.defineProperty(event, 'image', { enumerable: true, get() { imageReads += 1; throw new Error('Must not read photo before scope validation'); } });
    const result = await main(event);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'ACCOUNT_CHANGED');
    assert.equal(JSON.stringify(result).includes(expectedAccountId), false);
  }
  assert.equal(contextReads, attempts.length);
  assert.equal(serviceCalls, 0);
  assert.equal(imageReads, 0);
  assert.equal(externalCalls, 0);
});

test('deployed entry matches the glucose bootstrap account namespace and sends only image to OCR', async () => {
  let sent;
  const main = entryFixture({ request: async (_url, _token, body) => { sent = body; return responseFor('9.4'); } });
  const result = await main({ expectedAccountId: accountKey(validContext), image, userInfo: { OPENID: 'forged-user', APPID: 'forged-app' }, tcbContext: { OPENID: 'forged-other-user', APPID: 'forged-other-app' } });
  assert.equal(result.ok, true);
  assert.equal(result.data.value, '9.4');
  assert.deepEqual(Object.keys(sent), ['image']);
  assert.equal(sent.image, image);
  assert.equal((await main({ expectedAccountId: accountKey(validContext), image, owner: accountKey(validContext) })).error.code, 'INVALID_INPUT');
});

test('deployed entry never accepts client identity instead of a trusted context', async () => {
  for (const context of [undefined, {}, { OPENID: validContext.OPENID }, { ...validContext, APPID: 'invalid-app-id' }]) {
    const main = entryFixture({ getContext: () => context, onRecognize() { throw new Error('Must not invoke OCR without context'); } });
    assert.equal((await main({ image, expectedAccountId: accountKey(validContext), userInfo: validContext })).error.code, 'UNAUTHENTICATED');
  }
});

test('rejects absent trusted identity before calling an OCR service', async () => {
  let called = false;
  const recognize = createRecognizer({ env, request: async () => { called = true; return responseFor('6.1'); } });
  for (const context of [undefined, {}, { OPENID: 'a' }, { APPID: 'a' }]) assert.equal((await recognize({ image }, context)).error.code, 'UNAUTHENTICATED');
  assert.equal(called, false);
});

test('rejects client supplied owner and endpoint rather than using them', async () => {
  let called = false;
  const recognize = createRecognizer({ env, request: async () => { called = true; return responseFor('6.1'); } });
  for (const extra of [{ OPENID: 'victim' }, { owner: 'victim' }, { url: 'https://untrusted.invalid' }, { headers: { Authorization: 'forged' } }]) assert.equal((await recognize({ image, ...extra }, validContext)).error.code, 'INVALID_INPUT');
  assert.equal(called, false);
});

test('unconfigured service fails honestly, and configured app restriction is enforced', async () => {
  const recognize = createRecognizer({ env: {} });
  assert.equal((await recognize({ image }, validContext)).error.code, 'OCR_NOT_CONFIGURED');
  const restricted = createRecognizer({ env: { ...env, EXPECTED_APPID: 'wx-another-app' } });
  assert.equal((await restricted({ image }, validContext)).error.code, 'FORBIDDEN');
});

test('only environment HTTPS endpoint and strong token are accepted', () => {
  assert.equal(endpointFromEnvironment(env).hostname, 'ocr.example.com');
  for (const url of ['http://ocr.example.com', 'https://user:password@ocr.example.com', 'https://localhost/api/ocr', 'https://127.0.0.1/api/ocr', 'https://ocr.example.com:8080/api/ocr', 'https://ocr.example.com/api/ocr#token']) assert.equal(endpointFromEnvironment({ ...env, OCR_URL: url }), null);
  assert.equal(endpointFromEnvironment({ ...env, OCR_TOKEN: 'short' }), null);
});

test('rejects oversized, malformed and MIME-spoofed image payloads', async () => {
  assert.equal(validateImage(image), image);
  for (const invalid of ['not-image', 'data:image/png;base64,?', 'data:image/svg+xml;base64,PHN2Zz4=', 'data:image/jpeg;base64,' + Buffer.from('plain text, not a jpeg').toString('base64'), 'data:image/png;base64,' + 'A'.repeat(MAX_BASE64_LENGTH + 4)]) assert.equal(validateImage(invalid), null);
  const recognize = createRecognizer({ env, request: async () => { throw new Error('must not be called'); } });
  assert.equal((await recognize({ image: 'bad' }, validContext)).error.code, 'INVALID_IMAGE');
});

test('reads actual response tokens and preserves unit without fixed demo filling', async () => {
  let sent;
  const recognize = createRecognizer({ env, request: async (url, token, body) => { sent = { url, token, body }; return responseFor('7.8'); } });
  const result = await recognize({ image }, validContext);
  assert.equal(result.ok, true);
  assert.equal(result.data.value, '7.8');
  assert.equal(result.data.unit, 'mmol/L');
  assert.equal(result.data.processedLocally, false);
  assert.equal(sent.url.href, env.OCR_URL);
  assert.equal(sent.token, env.OCR_TOKEN);
  assert.deepEqual(Object.keys(sent.body), ['image']);
  assert.equal(sent.body.image, image);
});

test('ambiguous, low confidence, and special readouts require human review', async () => {
  const special = createRecognizer({ env, request: async () => ({ observations: [observation('HI')] }) });
  const result = await special({ image }, validContext);
  assert.equal(result.data.value, null);
  assert.equal(result.data.special, 'HI');
  const unclear = createRecognizer({ env, request: async () => ({ observations: [{ ...observation('8.2'), confidence: .1 }] }) });
  assert.equal((await unclear({ image }, validContext)).data.value, null);
});

test('upstream failures and timeout never leak details or invent results', async () => {
  const failed = createRecognizer({ env, request: async () => { throw new Error('secret upstream request body'); } });
  const failure = await failed({ image }, validContext);
  assert.equal(failure.error.code, 'OCR_UNAVAILABLE');
  assert.equal(JSON.stringify(failure).includes('secret'), false);
  const timeout = createRecognizer({ env, request: async () => { throw Object.assign(new Error('timed out'), { code: 'OCR_TIMEOUT' }); } });
  assert.equal((await timeout({ image }, validContext)).error.code, 'OCR_TIMEOUT');
  const malformed = createRecognizer({ env, request: async () => ({ observations: [{ text: '6.1' }] }) });
  assert.equal((await malformed({ image }, validContext)).error.code, 'OCR_UNAVAILABLE');
});

test('cloud parser matches the approved source fingerprint in a standalone project', () => {
  const deployed = fs.readFileSync(path.join(__dirname, '../cloudfunctions/recognize/parse-reading.mjs'));
  assert.equal(createHash('sha256').update(deployed).digest('hex'), provenance.sources.parseReading.sha256);
});
