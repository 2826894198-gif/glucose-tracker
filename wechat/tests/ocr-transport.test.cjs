'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const { postOcr } = require('../cloudfunctions/recognize/service.js');

function transport(t) {
  const request = new EventEmitter();
  request.destroyed = false;
  request.destroy = error => { request.destroyed = true; if (error) request.emit('error', error); };
  request.end = body => { request.body = body; };
  let callback;
  t.mock.method(https, 'request', (url, options, cb) => { request.url = url; request.options = options; callback = cb; return request; });
  return {
    request,
    response(status = 200) {
      const response = new EventEmitter();
      response.statusCode = status; response.destroyed = false;
      response.resume = () => { response.resumed = true; };
      response.destroy = () => { response.destroyed = true; response.emit('aborted'); };
      callback(response); return response;
    },
  };
}
const endpoint = new URL('https://ocr.invalid/api/ocr'); // No real network in these transport tests.

test('an OCR upstream trickling response bytes still has a 15-second whole-request deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = transport(t);
  const pending = assert.rejects(postOcr(endpoint, 'test-only-token', { image: 'fixture' }), { code: 'OCR_TIMEOUT' });
  const response = h.response();
  response.emit('data', Buffer.from('{"observations":'));
  t.mock.timers.tick(10000); response.emit('data', Buffer.from('['));
  t.mock.timers.tick(5000);
  await pending;
  assert.equal(h.request.destroyed, true);
});

test('DNS or TLS stalls expire even when no response or socket timeout event arrives', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = transport(t);
  const pending = assert.rejects(postOcr(endpoint, 'test-only-token', {}), { code: 'OCR_TIMEOUT' });
  t.mock.timers.tick(15000); await pending;
  assert.equal(h.request.destroyed, true);
});

test('a successful JSON response clears the deadline and sends only the configured body and bearer', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = transport(t), result = postOcr(endpoint, 'test-only-token', { image: 'fixture' });
  const response = h.response(); response.emit('data', Buffer.from('{"observations":[]}')); response.emit('end');
  assert.deepEqual(await result, { observations: [] });
  t.mock.timers.tick(20000);
  assert.equal(h.request.destroyed, false);
  assert.equal(h.request.options.headers.Authorization, 'Bearer test-only-token');
  assert.deepEqual(JSON.parse(h.request.body), { image: 'fixture' });
});

test('redirects fail at the configured endpoint without forwarding a bearer to another URL', async t => {
  const h = transport(t), pending = assert.rejects(postOcr(endpoint, 'test-only-token', {}), { code: 'OCR_UPSTREAM' });
  const response = h.response(302); await pending;
  assert.equal(response.destroyed, true); assert.equal(h.request.url, endpoint);
  assert.equal(https.request.mock.calls.length, 1);
});

test('oversized or aborted responses fail without accepting partial OCR output', async t => {
  const h = transport(t);
  let pending = assert.rejects(postOcr(endpoint, 'test-only-token', {}), { code: 'OCR_UPSTREAM' });
  let response = h.response(); response.emit('data', Buffer.alloc(1024 * 1024 + 1));
  await pending; assert.equal(response.destroyed, true);
  pending = assert.rejects(postOcr(endpoint, 'test-only-token', {}), { code: 'OCR_UPSTREAM' });
  response = h.response(); response.emit('data', Buffer.from('{')); response.emit('aborted'); await pending;
});

test('synchronous transport errors clear the timer and never leave an unfinished request', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(https, 'request', () => { throw Object.assign(new Error('network failure'), { code: 'TEST_NETWORK_FAILURE' }); });
  await assert.rejects(postOcr(endpoint, 'test-only-token', {}), { code: 'TEST_NETWORK_FAILURE' });
  t.mock.timers.tick(20000);
});
