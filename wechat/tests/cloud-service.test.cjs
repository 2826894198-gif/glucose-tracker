'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, accountKey, documentId, COLLECTIONS } = require('../cloudfunctions/glucose/service.cjs');
const { createRepository, missingDocument } = require('../cloudfunctions/glucose/repository.cjs');
const clone = value => value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
const NOW = new Date('2026-10-22T12:00:00.000Z');
const ALICE = { APPID: 'wx1234567890abcdef', OPENID: 'openid-alice' };
const BOB = { APPID: ALICE.APPID, OPENID: 'openid-bob' };
const CHARLIE = { APPID: 'wxfedcba0987654321', OPENID: ALICE.OPENID };

class MemoryRepository {
  constructor() { this.accounts = new Map(); this.records = new Map(); this.operations = new Map(); this.tail = Promise.resolve(); this.failWrite = 0; this.listCalls = []; }
  runTransaction(callback) {
    const execute = async () => {
      const state = { accounts: new Map([...this.accounts].map(([k, v]) => [k, clone(v)])), records: new Map([...this.records].map(([k, v]) => [k, clone(v)])), operations: new Map([...this.operations].map(([k, v]) => [k, clone(v)])) };
      const tx = {};
      for (const [singular, plural] of [['Account', 'accounts'], ['Record', 'records'], ['Operation', 'operations']]) {
        tx[`get${singular}`] = async id => clone(state[plural].get(id) || null);
        tx[`put${singular}`] = async (id, value) => {
          if (this.failWrite && --this.failWrite === 0) throw new Error('SIMULATED_DATABASE_WRITE_FAILURE');
          state[plural].set(id, clone(value));
        };
      }
      const result = await callback(tx);
      this.accounts = state.accounts; this.records = state.records; this.operations = state.operations;
      return clone(result);
    };
    const result = this.tail.then(execute);
    this.tail = result.catch(() => {});
    return result;
  }
  async getRecord(id) { return clone(this.records.get(id) || null); }
  async listRecords(owner, lower, upper, limit) {
    this.listCalls.push({ owner, lower, upper, limit });
    return [...this.records.values()].filter(r => r.ownerKey === owner && r.syncVersion > lower && r.syncVersion <= upper).sort((a, b) => a.syncVersion - b.syncVersion).slice(0, limit).map(clone);
  }
}
function fixture() {
  const repository = new MemoryRepository();
  const handle = createService({ repository, clock: () => new Date(NOW), allowedAppId: '' });
  return { repository, handle, call: (event, context) => handle(event.action === 'bootstrap' ? event : { expectedAccountId: context ? accountKey(context) : undefined, ...event }, context) };
}
function reading(id = 'record_0001', patch = {}) { return { id, value: '6.1', unit: 'mmol/L', moment: 'fasting', measuredAt: '2026-10-22T07:10:00+08:00', note: '测试，非真实测量', source: 'manual', ...patch }; }
function upsert(record = reading(), opId = 'operation_0001', baseRevision = 0) { return { action: 'upsert', opId, baseRevision, record }; }
function ok(response) { assert.equal(response.ok, true, JSON.stringify(response)); return response.data; }
function error(response, code) { assert.equal(response.ok, false); assert.equal(response.error.code, code, JSON.stringify(response)); return response.error; }

test('identity comes only from trusted WX context; event identity and unknown actions cannot grant access', async () => {
  const { call } = fixture();
  error(await call({ action: 'bootstrap', userInfo: ALICE }, null), 'AUTH_REQUIRED');
  error(await call({ action: 'bootstrap' }, { OPENID: ALICE.OPENID, APPID: 'invalid' }), 'AUTH_REQUIRED');
  error(await call({ action: 'bootstrap', ownerKey: accountKey(BOB) }, ALICE), 'VALIDATION');
  error(await call({ action: 'bootstrap', openid: BOB.OPENID }, ALICE), 'VALIDATION');
  error(await call({ action: '__proto__' }, ALICE), 'VALIDATION');
  error(await call({ action: 'constructor' }, ALICE), 'VALIDATION');
  const mine = ok(await call({ action: 'bootstrap', userInfo: { openId: BOB.OPENID, appId: BOB.APPID } }, ALICE));
  assert.equal(mine.accountId, accountKey(ALICE));
  assert.notEqual(mine.accountId, ALICE.OPENID);
  assert.deepEqual(mine.targets, { ranges: {}, revision: 0 });
  assert.deepEqual(mine.preferences, { largeType: false, revision: 0 });
  const other = ok(await call({ action: 'bootstrap' }, CHARLIE));
  assert.notEqual(mine.accountId, other.accountId);
});

test('an explicitly configured app allowlist rejects calls from another trusted app', async () => {
  const repository = new MemoryRepository();
  const call = createService({ repository, allowedAppId: ALICE.APPID });
  error(await call({ action: 'bootstrap' }, CHARLIE), 'FORBIDDEN');
  assert.equal(repository.accounts.size, 0);
});

test('WeChat transport context is tolerated but cannot select identity or bypass business-field validation', async () => {
  const { call, handle } = fixture();
  const metadata = { userInfo: BOB, tcbContext: { OPENID: BOB.OPENID, APPID: CHARLIE.APPID, ownerKey: accountKey(BOB) } };
  const mine = ok(await call({ action: 'bootstrap', ...metadata }, ALICE));
  assert.equal(mine.accountId, accountKey(ALICE));
  error(await call({ action: 'bootstrap', ...metadata }, null), 'AUTH_REQUIRED');
  error(await call({ action: 'bootstrap', ...metadata, ownerKey: accountKey(BOB) }, ALICE), 'VALIDATION');
  error(await handle({ action: 'list', ...metadata, expectedAccountId: accountKey(BOB) }, ALICE), 'ACCOUNT_CHANGED');
});

test('rejected request fields report bounded names without returning identity or measurement values', async () => {
  const { call } = fixture();
  const response = await call({ action: 'bootstrap', ownerKey: accountKey(BOB), privateValue: 'private-test-reading' }, ALICE);
  const rejected = error(response, 'VALIDATION');
  assert.deepEqual(rejected.details.fields, ['ownerKey', 'privateValue']);
  assert.equal(JSON.stringify(response).includes(accountKey(BOB)), false);
  assert.equal(JSON.stringify(response).includes('private-test-reading'), false);
});

test('all post-bootstrap calls assert the expected account and never route by the client assertion', async () => {
  const { call, handle, repository } = fixture();
  const a = ok(await call({ action: 'bootstrap' }, ALICE));
  ok(await call({ action: 'bootstrap' }, BOB));
  error(await handle(upsert(), ALICE), 'ACCOUNT_CHANGED');
  error(await handle({ ...upsert(), expectedAccountId: a.accountId }, BOB), 'ACCOUNT_CHANGED');
  ok(await call(upsert(), ALICE));
  for (const event of [{ action: 'list' }, { action: 'get', id: 'record_0001' }, { action: 'targets.get' }, { action: 'preferences.set', opId: 'preference_operation1', baseRevision: 0, preferences: { largeType: true } }]) {
    const denied = error(await handle({ ...event, expectedAccountId: a.accountId }, BOB), 'ACCOUNT_CHANGED');
    assert.equal(Object.hasOwn(denied, 'details'), false);
  }
  assert.equal(repository.records.size, 1);
  assert.equal(ok(await call({ action: 'list' }, BOB)).records.length, 0);
});

test('same client record ID is isolated by app and user for list, get, update, delete and restore', async () => {
  const { call, repository } = fixture();
  const alice = ok(await call(upsert(), ALICE));
  assert.equal(alice.record.revision, 1); assert.equal(alice.syncVersion, 1);
  assert.equal(alice.record.createdAt, NOW.toISOString());
  assert.equal(alice.record.measuredAt, '2026-10-21T23:10:00.000Z');
  assert.equal(Object.hasOwn(alice.record, 'ownerKey'), false);
  error(await call({ action: 'get', id: 'record_0001' }, BOB), 'NOT_FOUND');
  error(await call({ action: 'delete', opId: 'operation_bob1', id: 'record_0001', baseRevision: 1 }, BOB), 'NOT_FOUND');
  error(await call({ action: 'restore', opId: 'operation_bob2', id: 'record_0001', baseRevision: 1 }, BOB), 'NOT_FOUND');
  const bob = ok(await call(upsert(reading('record_0001', { value: '9.2' })), BOB));
  assert.equal(bob.record.value, '9.2');
  assert.equal(ok(await call({ action: 'get', id: 'record_0001' }, ALICE)).record.value, '6.1');
  assert.equal(ok(await call({ action: 'list' }, ALICE)).records.length, 1);
  assert.equal(ok(await call({ action: 'list' }, BOB)).records[0].value, '9.2');
  assert.equal(ok(await call({ action: 'list' }, CHARLIE)).records.length, 0);
  const aliceDocId = documentId(accountKey(ALICE), 'record', 'record_0001');
  error(await call({ action: 'get', id: aliceDocId }, BOB), 'NOT_FOUND');
  assert.equal(repository.records.size, 2);
  assert.ok(repository.listCalls.every(query => [accountKey(ALICE), accountKey(BOB), accountKey(CHARLIE)].includes(query.owner)));
});

test('server validates original reading/unit/context/date and refuses privileged or demo fields', async () => {
  const { call } = fixture();
  for (const patch of [
    { value: 6.1 }, { value: 'HI' }, { value: '0' }, { value: '6.123' }, { value: '6e1' },
    { unit: 'auto' }, { moment: '' }, { source: 'demo' }, { note: 5 }, { note: 'x'.repeat(2001) },
    { afterMinutes: 120 }, { moment: 'after', afterMinutes: 0 }, { moment: 'after', afterMinutes: 1.5 },
    { measuredAt: '2026-02-31T07:10:00+08:00' }, { measuredAt: '2026-10-22T07:10:00' }, { measuredAt: '2026-10-23T07:10:00Z' },
    { measuredAt: '2026-10-22T24:00:00Z' }, { measuredAt: '2026-10-22T07:10:00+14:30' },
    { ownerKey: accountKey(BOB) }, { createdAt: NOW.toISOString() }, { revision: 10 }, { deletedAt: NOW.toISOString() }, { id: 'demo-example' },
  ]) error(await call(upsert(reading('record_0001', patch)), ALICE), 'VALIDATION');
  const saved = ok(await call(upsert(reading('record_0001', { value: '００６，１０', moment: 'after', afterMinutes: 60, unit: 'mg/dL' })), ALICE));
  assert.equal(saved.record.value, '6.10');
  assert.equal(saved.record.unit, 'mg/dL');
  assert.equal(saved.record.afterMinutes, 60);
});

test('stable opId replays exact result without duplicate writes, even after subsequent edits', async () => {
  const { call, repository } = fixture();
  const request = upsert();
  const first = await call(request, ALICE);
  const retry = await call({ record: request.record, baseRevision: 0, opId: request.opId, action: 'upsert' }, ALICE);
  assert.deepEqual(retry, first);
  const changed = ok(await call(upsert(reading('record_0001', { value: '7.2' }), 'operation_0002', 1), ALICE));
  assert.equal(changed.record.revision, 2);
  assert.deepEqual(await call(request, ALICE), first);
  assert.equal(ok(await call({ action: 'get', id: 'record_0001' }, ALICE)).record.value, '7.2');
  error(await call(upsert(reading('record_0001', { value: '8' })), ALICE), 'OPERATION_REUSED');
  assert.equal(repository.operations.size, 2);
  assert.equal(ok(await call({ action: 'bootstrap' }, ALICE)).syncVersion, 2);
});

test('stale and concurrent edits conflict with the current own record and do not overwrite it', async () => {
  const { call } = fixture();
  ok(await call(upsert(), ALICE));
  const results = await Promise.all([
    call(upsert(reading('record_0001', { value: '7' }), 'operation_0002', 1), ALICE),
    call(upsert(reading('record_0001', { value: '8' }), 'operation_0003', 1), ALICE),
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  const conflict = error(results.find(r => !r.ok), 'CONFLICT');
  assert.equal(conflict.details.current.value, '7');
  assert.equal(Object.hasOwn(conflict.details.current, 'ownerKey'), false);
  assert.equal(ok(await call({ action: 'bootstrap' }, ALICE)).syncVersion, 2);
});

test('transaction failure rolls back record, account version and operation journal together', async () => {
  const { call, repository } = fixture();
  ok(await call({ action: 'bootstrap' }, ALICE));
  repository.failWrite = 2;
  const failed = error(await call(upsert(), ALICE), 'INTERNAL');
  assert.equal(JSON.stringify(failed).includes('SIMULATED_DATABASE'), false);
  assert.equal(repository.records.size, 0); assert.equal(repository.operations.size, 0);
  assert.equal(ok(await call({ action: 'bootstrap' }, ALICE)).syncVersion, 0);
  assert.equal(ok(await call(upsert(), ALICE)).record.revision, 1);
});

test('soft delete and restore send tombstones in incremental synchronization without implicit resurrection', async () => {
  const { call } = fixture();
  ok(await call(upsert(), ALICE));
  const deleted = ok(await call({ action: 'delete', id: 'record_0001', opId: 'operation_delete', baseRevision: 1 }, ALICE));
  assert.equal(deleted.record.deletedAt, NOW.toISOString());
  const incremental = ok(await call({ action: 'list', afterVersion: 1 }, ALICE));
  assert.equal(incremental.records.length, 1);
  assert.equal(incremental.records[0].revision, 2);
  assert.equal(incremental.records[0].deletedAt, NOW.toISOString());
  error(await call(upsert(reading(), 'operation_edit_deleted', 2), ALICE), 'DELETED');
  error(await call({ action: 'restore', id: 'record_0001', opId: 'operation_restore_bad', baseRevision: 1 }, ALICE), 'CONFLICT');
  const restored = ok(await call({ action: 'restore', id: 'record_0001', opId: 'operation_restore', baseRevision: 2 }, ALICE));
  assert.equal(restored.record.revision, 3); assert.equal(restored.syncVersion, 3);
  assert.equal(Object.hasOwn(restored.record, 'deletedAt'), false);
  assert.equal(restored.record.createdAt, NOW.toISOString());
});

test('version pagination is owner-scoped, bounded and exposes newer mutations for a catch-up pass', async () => {
  const { call } = fixture();
  for (let n = 1; n <= 5; n++) ok(await call(upsert(reading(`record_000${n}`), `operation_000${n}`), ALICE));
  ok(await call(upsert(reading('record_bob1'), 'operation_bob1'), BOB));
  const first = ok(await call({ action: 'list', limit: 2 }, ALICE));
  assert.equal(first.watermark, 5); assert.equal(first.nextCursor, '2'); assert.equal(first.hasMore, true);
  ok(await call(upsert(reading('record_0003', { value: '8.1' }), 'operation_edit3', 1), ALICE));
  const second = ok(await call({ action: 'list', afterVersion: 0, uptoVersion: first.watermark, cursor: first.nextCursor, limit: 2 }, ALICE));
  assert.deepEqual(second.records.map(r => r.id), ['record_0004', 'record_0005']);
  assert.equal(second.hasMore, false); assert.equal(second.latestVersion, 6);
  const catchUp = ok(await call({ action: 'list', afterVersion: first.watermark }, ALICE));
  assert.deepEqual(catchUp.records.map(r => [r.id, r.value]), [['record_0003', '8.1']]);
  for (const patch of [{ limit: 0 }, { limit: 101 }, { afterVersion: -1 }, { uptoVersion: 999 }, { cursor: '1 OR ownerKey' }, { cursor: '0', afterVersion: 1 }]) error(await call({ action: 'list', ...patch }, ALICE), 'VALIDATION');
});

test('personal targets remain per account/unit/interval with revision checking, independent of clinical defaults', async () => {
  const { call } = fixture();
  const request = { action: 'targets.set', opId: 'target_operation1', baseRevision: 0, context: { moment: 'after', unit: 'mmol/L', afterMinutes: 120 }, range: { low: '3.5', high: '9.5', unit: 'mmol/L' } };
  const saved = ok(await call(request, ALICE));
  assert.deepEqual(Object.keys(saved.ranges), ['after:120:mmol/L']);
  assert.equal(saved.ranges['after:120:mmol/L'].low, 3.5);
  assert.deepEqual(await call(request, ALICE), { ok: true, data: saved });
  assert.deepEqual(ok(await call({ action: 'targets.get' }, BOB)), { ranges: {}, revision: 0 });
  const conflict = error(await call({ ...request, opId: 'target_operation2', range: { low: 4, high: 8, unit: 'mmol/L' } }, ALICE), 'CONFLICT');
  assert.equal(conflict.details.current.revision, 1);
  error(await call({ ...request, opId: 'target_operation2', baseRevision: 1, range: { low: 5, high: 4, unit: 'mmol/L' } }, ALICE), 'VALIDATION');
  error(await call({ ...request, opId: 'target_operation2', baseRevision: 1, range: { low: 4, high: 8, unit: 'mg/dL' } }, ALICE), 'VALIDATION');
  const another = ok(await call({ ...request, opId: 'target_operation2', baseRevision: 1, context: { moment: 'after', unit: 'mg/dL', afterMinutes: 60 }, range: { low: 80, high: 180, unit: 'mg/dL' } }, ALICE));
  assert.equal(Object.keys(another.ranges).length, 2);
  const removed = ok(await call({ action: 'targets.remove', opId: 'target_operation3', baseRevision: 2, context: request.context }, ALICE));
  assert.deepEqual(Object.keys(removed.ranges), ['after:60:mg/dL']);
});

test('display preferences use trusted account scope and detect concurrent changes', async () => {
  const { call } = fixture();
  const request = { action: 'preferences.set', opId: 'preference_operation1', baseRevision: 0, preferences: { largeType: true } };
  const saved = ok(await call(request, ALICE));
  assert.deepEqual(saved.preferences, { largeType: true, revision: 1 });
  assert.equal(ok(await call({ action: 'bootstrap' }, BOB)).preferences.largeType, false);
  error(await call({ ...request, opId: 'preference_operation2' }, ALICE), 'CONFLICT');
  error(await call({ ...request, baseRevision: 1, opId: 'preference_operation2', preferences: { largeType: 'true' } }, ALICE), 'VALIDATION');
});

test('repository adapter emits owner-scoped range query and does not disguise infrastructure failures as empty data', async () => {
  const calls = [];
  const scope = { collection(name) { calls.push(['collection', name]); return { doc(id) { return { async get() { if (id === 'missing') throw { errMsg: 'document.get:fail document not exists' }; if (id === 'failure') throw { errMsg: 'connection timeout' }; return { data: { _id: id, ownerKey: 'owner', id: 'record_0001' } }; }, async set(value) { calls.push(['set', value]); } }; }, where(value) { calls.push(['where', value]); return this; }, orderBy(...args) { calls.push(['orderBy', ...args]); return this; }, limit(value) { calls.push(['limit', value]); return this; }, async get() { return { data: [{ _id: 'internal', ownerKey: 'owner', syncVersion: 2 }] }; } }; } };
  const db = { ...scope, command: { gt(value) { return { gt: value, and(other) { return { gt: value, lte: other.lte }; } }; }, lte(value) { return { lte: value }; } }, async runTransaction(callback) { return { result: await callback(scope), errMsg: 'runTransaction:ok' }; } };
  const repository = createRepository(db);
  assert.deepEqual(await repository.runTransaction(tx => tx.getRecord('exists')), { ownerKey: 'owner', id: 'record_0001' });
  assert.equal(await repository.getRecord('missing'), null);
  await assert.rejects(repository.getRecord('failure'), error => error.errMsg === 'connection timeout');
  await repository.listRecords('owner', 1, 8, 3);
  assert.ok(calls.some(call => call[0] === 'collection' && call[1] === COLLECTIONS.records));
  assert.deepEqual(calls.find(call => call[0] === 'where')[1], { ownerKey: 'owner', syncVersion: { gt: 1, lte: 8 } });
  assert.equal(missingDocument({ errMsg: 'collection not exists' }), false);
  assert.equal(missingDocument({ errMsg: 'document.get:fail -502005 collection not exists' }), false);
  assert.equal(missingDocument('document.get:fail document with _id 0123456789 does not exist'), true);
});
