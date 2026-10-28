'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const path = require('node:path');

// Resolve exactly as the installed SDK does, including nested npm overrides.
const cloudRequire = createRequire(path.join(__dirname, '../cloudfunctions/glucose/index.js'));
const sdkRequire = createRequire(cloudRequire.resolve('@cloudbase/node-sdk'));
const databaseRequire = createRequire(sdkRequire.resolve('@cloudbase/database'));
const axios = sdkRequire('axios');
const metadata = sdkRequire('./utils/metadata');
const { CloudBase } = sdkRequire('./cloudbase');
const unset = databaseRequire('lodash.unset');

// Exercise Axios's real Node HTTP adapter and response/error processing without
// making network requests or reading cloud metadata/credentials during tests.
function transportFixture({ body = 'fixture-body', status = 200, timeout = false } = {}) {
  const calls = [];
  return {
    calls,
    transport: {
      request(options, callback) {
        const call = { options, body: undefined, timeout: undefined, aborted: false };
        calls.push(call);
        const request = new EventEmitter();
        request.aborted = false;
        request.setTimeout = (milliseconds, handler) => {
          call.timeout = milliseconds;
          if (timeout) queueMicrotask(handler);
          return request;
        };
        request.abort = () => { request.aborted = true; call.aborted = true; };
        request.end = data => {
          call.body = data && data.toString();
          if (timeout) return;
          queueMicrotask(() => {
            const response = Readable.from([Buffer.from(body)]);
            response.statusCode = status;
            response.statusMessage = status === 200 ? 'OK' : 'Unavailable';
            response.headers = { 'content-type': 'text/plain' };
            response.req = request;
            callback(response);
          });
        };
        return request;
      },
    },
  };
}

async function withTransport(fixture, work) {
  const previousTransport = axios.defaults.transport;
  const previousProxy = axios.defaults.proxy;
  axios.defaults.transport = fixture.transport;
  axios.defaults.proxy = false;
  try { return await work(); }
  finally {
    if (previousTransport === undefined) delete axios.defaults.transport;
    else axios.defaults.transport = previousTransport;
    if (previousProxy === undefined) delete axios.defaults.proxy;
    else axios.defaults.proxy = previousProxy;
  }
}

test('SDK resolves the pinned same-source maintenance overrides without changing SDK/database majors', () => {
  assert.equal(cloudRequire('wx-server-sdk/package.json').version, '4.0.2');
  assert.equal(sdkRequire('./../package.json').version, '3.17.2');
  assert.equal(databaseRequire('./../../package.json').version, '1.4.3');
  assert.equal(sdkRequire('axios/package.json').version, '0.34.0');
  assert.equal(databaseRequire('lodash.unset/package.json').version, '4.18.0');
});

test('actual CloudBase metadata calls retain fixed host/path, status processing, and configured timeout', async () => {
  const fixture = transportFixture();
  await withTransport(fixture, async () => {
    assert.equal(await metadata.lookup('meta-data/app-id', { timeout: 30 }), 'fixture-body');
    assert.equal(await metadata.lookupCredentials('TEST_ONLY_ROLE'), 'fixture-body');
  });
  assert.equal(fixture.calls.length, 2);
  assert.deepEqual(fixture.calls.map(({ options, timeout }) => ({ hostname: options.hostname, path: options.path, method: options.method, timeout })), [
    { hostname: 'metadata.tencentyun.com', path: '/latest/meta-data/app-id', method: 'GET', timeout: 30 },
    { hostname: 'metadata.tencentyun.com', path: '/latest/meta-data/cam/security-credentials/TEST_ONLY_ROLE', method: 'GET', timeout: 200 },
  ]);
  const failure = transportFixture({ status: 503 });
  await withTransport(failure, () => assert.rejects(metadata.lookup('meta-data/app-id', { timeout: 30 }), error => error.response.status === 503));
  const timedOut = transportFixture({ timeout: true });
  await withTransport(timedOut, () => assert.rejects(metadata.lookup('meta-data/app-id', { timeout: 30 }), error => error.code === 'ECONNABORTED'));
  assert.equal(timedOut.calls[0].aborted, true);
});

test('actual CloudBase extension shim remains a callable Axios config API and serializes ordinary JSON', async () => {
  // Getter has no instance state; avoid constructing a real SDK client, which
  // would trigger its independent cloud-platform preflight.
  const shim = Object.getOwnPropertyDescriptor(CloudBase.prototype, 'requestClient').get.call({});
  for (const method of ['get', 'post', 'put', 'delete']) assert.equal(shim[method], axios);
  const fixture = transportFixture({ body: '{"received":true}' });
  await withTransport(fixture, async () => {
    const response = await shim.post({ url: 'https://compatibility.invalid/extension', method: 'post', data: { fixture: true }, timeout: 200 });
    assert.deepEqual(response.data, { received: true });
  });
  assert.equal(fixture.calls[0].options.method, 'POST');
  assert.equal(fixture.calls[0].options.hostname, 'compatibility.invalid');
  assert.equal(fixture.calls[0].body, '{"fixture":true}');
});

test('patched same-major lodash.unset retains ordinary paths while blocking prototype deletion paths', () => {
  const object = { profile: { note: 'fixture', keep: true }, rows: [{ value: 1 }] };
  assert.equal(unset(object, 'profile.note'), true);
  assert.equal(unset(object, ['rows', '0', 'value']), true);
  assert.deepEqual(object, { profile: { keep: true }, rows: [{}] });
  const sentinel = '__glucose_dependency_test_sentinel__';
  assert.equal(Object.hasOwn(Object.prototype, sentinel), false);
  Object.prototype[sentinel] = 'preserve';
  try {
    for (const unsafePath of [`__proto__.${sentinel}`, ['constructor', 'prototype', sentinel], [['constructor'], ['prototype'], [sentinel]]]) {
      assert.equal(unset({}, unsafePath), false);
      assert.equal(Object.prototype[sentinel], 'preserve');
    }
  } finally { delete Object.prototype[sentinel]; }
});
