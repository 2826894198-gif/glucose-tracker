'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('../miniprogram/services/client');
const { createService } = require('../cloudfunctions/glucose/service.cjs');
const domain = require('../miniprogram/utils/domain');
const copy = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const NOW = new Date('2026-10-22T10:00:00.000Z');
const APPID = 'wx0123456789abcdef';

class MemoryRepository {
  constructor() { this.accounts = new Map(); this.records = new Map(); this.operations = new Map(); this.tail = Promise.resolve(); }
  runTransaction(fn) {
    const task = this.tail.then(async () => {
      const accounts = new Map([...this.accounts].map(([k, v]) => [k, copy(v)]));
      const records = new Map([...this.records].map(([k, v]) => [k, copy(v)]));
      const operations = new Map([...this.operations].map(([k, v]) => [k, copy(v)]));
      const tx = {
        getAccount: async key => copy(accounts.get(key)), putAccount: async (key, value) => { accounts.set(key, copy(value)); },
        getRecord: async key => copy(records.get(key)), putRecord: async (key, value) => { records.set(key, copy(value)); },
        getOperation: async key => copy(operations.get(key)), putOperation: async (key, value) => { operations.set(key, copy(value)); },
      };
      const result = await fn(tx); this.accounts = accounts; this.records = records; this.operations = operations; return result;
    });
    this.tail = task.catch(() => {}); return task;
  }
  async getRecord(id) { return copy(this.records.get(id)); }
  async listRecords(owner, lower, upper, limit) {
    return [...this.records.values()].filter(r => r.ownerKey === owner && r.syncVersion > lower && r.syncVersion <= upper).sort((a, b) => a.syncVersion - b.syncVersion).slice(0, limit).map(copy);
  }
}

function createHarness() {
  const repository = new MemoryRepository();
  const handle = createService({ repository, clock: () => NOW });
  const storage = new Map();
  let id = 0;
  function phone(user = 'parent-a', customStorage = storage) {
    const controls = { user, offline: false, failWrites: false, dropAction: null, hook: null, calls: [] };
    const wxApi = {
      getStorageSync(key) { return copy(customStorage.get(key)); },
      setStorageSync(key, value) { if (controls.failWrites) throw new Error('disk full'); customStorage.set(key, copy(value)); },
      cloud: { async callFunction({ data }) {
        controls.calls.push(copy(data));
        if (controls.offline) throw new Error('offline');
        const result = await handle(data, { APPID, OPENID: controls.user });
        if (controls.hook) await controls.hook(data, result);
        if (controls.dropAction === data.action) { controls.dropAction = null; throw new Error('response lost after commit'); }
        return { result };
      } },
    };
    const client = options => createClient({ wxApi, domain, now: () => NOW, autoSync: false, idFactory: prefix => `${prefix}_${String(++id).padStart(20, '0')}`, ...options });
    return { wxApi, controls, createClient: client, client: client(), storage: customStorage };
  }
  const direct = async (user, request) => {
    const identity = { APPID, OPENID: user };
    const boot = await handle({ action: 'bootstrap' }, identity);
    return handle({ ...request, ...(request.action === 'bootstrap' ? {} : { expectedAccountId: boot.data.accountId }) }, identity);
  };
  return { phone, direct, repository, storage };
}

const reading = (value = '6.1', extra = {}) => ({ value, unit: 'mmol/L', moment: 'fasting', measuredAt: '2026-10-22T07:10:00.000Z', note: '测试，非真实测量', source: 'manual', ...extra });
const fasting = { moment: 'fasting', unit: 'mmol/L' };
const after = { moment: 'after', unit: 'mmol/L', afterMinutes: 120 };

test('a WeChat runtime without cloud capability stays usable as a locked gate without loading personal caches', async () => {
  let storageReads = 0, storageWrites = 0;
  const client = createClient({ wxApi: { getStorageSync() { storageReads++; throw new Error('must not read private cache'); }, setStorageSync() { storageWrites++; } } });
  assert.equal(client.getSnapshot().status, 'logged-out');
  assert.equal((await client.login()).error.code, 'CLOUD_UNAVAILABLE');
  assert.equal(client.getSnapshot().authenticated, false);
  assert.deepEqual(client.getSnapshot().records, []);
  assert.equal(client.saveRecord(reading()).error.code, 'LOGIN_REQUIRED');
  assert.equal(storageReads, 0); assert.equal(storageWrites, 0);
});

test('cold start and failed identity check never expose a cached account; separate accounts stay isolated', async () => {
  const h = createHarness(), phone = h.phone();
  assert.equal(phone.client.getSnapshot().authenticated, false);
  assert.equal(phone.client.saveRecord(reading()).error.code, 'LOGIN_REQUIRED');
  assert.equal((await phone.client.login()).ok, true);
  phone.client.saveRecord(reading()); await phone.client.sync();
  const aKey = phone.client.getSnapshot().accountKey;
  assert.equal(phone.client.getSnapshot().activeRecords.length, 1);
  phone.client.logout(); phone.controls.user = 'parent-b'; phone.controls.offline = true;
  assert.equal((await phone.client.login()).ok, false);
  assert.deepEqual(phone.client.getSnapshot().records, []);
  phone.controls.offline = false; await phone.client.login();
  assert.notEqual(phone.client.getSnapshot().accountKey, aKey);
  assert.deepEqual(phone.client.getSnapshot().records, []);
  phone.controls.user = 'parent-a'; await phone.client.login();
  assert.equal(phone.client.getSnapshot().activeRecords.length, 1);
});

test('offline multiple edits survive process restart and upload in order without duplicates', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login(); phone.controls.offline = true;
  const first = phone.client.saveRecord(reading()); assert.equal(first.ok, true);
  const id = first.data.record.id;
  phone.client.saveRecord(reading('6.4', { id }));
  assert.equal(phone.client.getSnapshot().outboxCount, 2);
  phone.client = phone.createClient();
  assert.equal((await phone.client.login()).ok, false);
  assert.deepEqual(phone.client.getSnapshot().records, []);
  phone.controls.offline = false; await phone.client.login();
  const snapshot = phone.client.getSnapshot();
  assert.equal(snapshot.outboxCount, 0); assert.equal(snapshot.records.length, 1);
  assert.equal(snapshot.records[0].value, '6.4'); assert.equal(snapshot.records[0].revision, 2);
  assert.equal(h.repository.records.size, 1);
});

test('lost response retries the exact same operation id and payload without another cloud write', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  phone.client.saveRecord(reading()); phone.controls.dropAction = 'upsert';
  assert.equal((await phone.client.sync()).ok, false);
  assert.equal(phone.client.getSnapshot().outboxCount, 1);
  assert.equal(h.repository.records.size, 1);
  await phone.client.sync();
  const requests = phone.controls.calls.filter(call => call.action === 'upsert');
  assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  assert.equal(phone.client.getSnapshot().records[0].revision, 1);
  assert.equal(phone.client.getSnapshot().outboxCount, 0);
});

test('delete tombstones survive other-device pull and restore does not resurrect stale copies', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login(); phone.controls.offline = true;
  const { id } = phone.client.saveRecord(reading()).data.record;
  phone.client.deleteRecord(id); phone.controls.offline = false; await phone.client.sync();
  assert.equal(phone.client.getSnapshot().activeRecords.length, 0);
  assert.ok(phone.client.getSnapshot().records[0].deletedAt);
  const other = h.phone('parent-a', new Map()); await other.client.login();
  assert.equal(other.client.getSnapshot().activeRecords.length, 0);
  assert.ok(other.client.getSnapshot().records[0].deletedAt);
  other.client.restoreRecord(id); await other.client.sync(); await phone.client.sync();
  assert.equal(phone.client.getSnapshot().activeRecords.length, 1);
  assert.equal(phone.client.getSnapshot().records[0].revision, 3);
});

test('two-device record conflicts preserve local and cloud versions until an explicit choice', async () => {
  const h = createHarness(), a = h.phone(); await a.client.login();
  const { id } = a.client.saveRecord(reading()).data.record; await a.client.sync();
  const b = h.phone('parent-a', new Map()); await b.client.login();
  a.client.saveRecord(reading('6.3', { id })); await a.client.sync();
  b.client.saveRecord(reading('7.2', { id })); await b.client.sync();
  let snapshot = b.client.getSnapshot();
  assert.equal(snapshot.status, 'conflict'); assert.equal(snapshot.records[0].value, '7.2');
  assert.equal(snapshot.conflicts[0].cloud.value, '6.3');
  assert.equal(snapshot.records[0].syncStatus, 'conflict');
  b.client.resolveConflict(snapshot.conflicts[0].id, 'cloud'); await b.client.sync();
  assert.equal(b.client.getSnapshot().records[0].value, '6.3');
  a.client.saveRecord(reading('6.5', { id })); await a.client.sync();
  b.client.saveRecord(reading('7.4', { id })); await b.client.sync();
  snapshot = b.client.getSnapshot(); b.client.resolveConflict(snapshot.conflicts[0].id, 'local'); await b.client.sync();
  assert.equal(b.client.getSnapshot().records[0].value, '7.4');
  assert.equal(b.client.getSnapshot().outboxCount, 0);
  await a.client.sync(); assert.equal(a.client.getSnapshot().records[0].value, '7.4');
});

test('targets and preferences queue offline, sync by revision, and are visible on another device', async () => {
  const h = createHarness(), a = h.phone(); await a.client.login(); a.controls.offline = true;
  a.client.setTarget(fasting, { low: '4.4', high: '7', unit: 'mmol/L' });
  a.client.setTarget(after, { low: '4.4', high: '9', unit: 'mmol/L' });
  a.client.setLargeType(true); a.controls.offline = false; await a.client.sync();
  assert.equal(a.client.getSnapshot().outboxCount, 0);
  const b = h.phone('parent-a', new Map()); await b.client.login();
  assert.equal(b.client.getSnapshot().targets['fasting:mmol/L'].high, 7);
  assert.equal(b.client.getSnapshot().targets['after:120:mmol/L'].high, 9);
  assert.equal(b.client.getSnapshot().largeType, true);
  a.client.removeTarget(fasting); a.client.setLargeType(false); await a.client.sync(); await b.client.sync();
  assert.equal(b.client.getSnapshot().targets['fasting:mmol/L'], undefined);
  assert.equal(b.client.getSnapshot().largeType, false);
});

test('target conflict resolution preserves cloud contexts untouched by this device', async () => {
  const h = createHarness(), a = h.phone(); await a.client.login();
  a.client.setTarget(fasting, { low: 4, high: 7, unit: 'mmol/L' }); await a.client.sync();
  const b = h.phone('parent-a', new Map()); await b.client.login();
  a.client.setTarget(after, { low: 4, high: 9, unit: 'mmol/L' }); await a.client.sync();
  b.client.setTarget(fasting, { low: 5, high: 7, unit: 'mmol/L' }); await b.client.sync();
  const conflict = b.client.getSnapshot().conflicts[0]; assert.equal(conflict.entity, 'targets');
  b.client.resolveConflict(conflict.id, 'local'); await b.client.sync();
  const targets = b.client.getSnapshot().targets;
  assert.equal(targets['fasting:mmol/L'].low, 5); assert.equal(targets['after:120:mmol/L'].high, 9);
});

test('changed WeChat identity is checked before sending the old account pending health data', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  const key = phone.client.getSnapshot().accountKey;
  phone.client.saveRecord(reading()); phone.controls.user = 'parent-b';
  const result = await phone.client.sync();
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(phone.client.getSnapshot().authenticated, false);
  assert.deepEqual(phone.client.getSnapshot().records, []);
  assert.equal(h.repository.records.size, 0);
  const cache = h.storage.get(`family-glucose:wechat:v1:${key}`); assert.equal(cache.outbox.length, 1);
  await phone.client.login(); assert.equal(phone.client.getSnapshot().records.length, 0);
  phone.controls.user = 'parent-a'; await phone.client.login();
  assert.equal(phone.client.getSnapshot().activeRecords.length, 1);
});

test('failed local persistence does not claim success or discard queued data after a cloud acknowledgement', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  phone.controls.failWrites = true;
  assert.equal(phone.client.saveRecord(reading()).error.code, 'LOCAL_SAVE_FAILED');
  assert.equal(phone.client.getSnapshot().records.length, 0);
  phone.controls.failWrites = false; phone.client.saveRecord(reading());
  phone.controls.hook = async data => { if (data.action === 'upsert') phone.controls.failWrites = true; };
  assert.equal((await phone.client.sync()).error.code, 'LOCAL_SAVE_FAILED');
  assert.equal(phone.client.getSnapshot().outboxCount, 1);
  phone.controls.failWrites = false; phone.controls.hook = null; await phone.client.sync();
  assert.equal(phone.client.getSnapshot().outboxCount, 0); assert.equal(phone.client.getSnapshot().records[0].revision, 1);
});

test('corrupted own-account cache is retained rather than silently overwritten', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  const key = `family-glucose:wechat:v1:${phone.client.getSnapshot().accountKey}`;
  const invalid = { version: 1, records: 'corrupt' }; h.storage.set(key, invalid);
  phone.client = phone.createClient();
  assert.equal((await phone.client.login()).error.code, 'LOCAL_STORAGE_CORRUPT');
  assert.equal(phone.client.saveRecord(reading()).error.code, 'LOCAL_STORAGE_CORRUPT');
  assert.deepEqual(h.storage.get(key), invalid);
});

test('stable paginated pull catches a record updated beyond the watermark between pages', async () => {
  const h = createHarness();
  for (let i = 1; i <= 101; i++) {
    const response = await h.direct('parent-a', { action: 'upsert', opId: `seed_op_${String(i).padStart(8, '0')}`, baseRevision: 0, record: { ...reading(), id: `record_${String(i).padStart(8, '0')}` } });
    assert.equal(response.ok, true);
  }
  const phone = h.phone(); let updated = false;
  phone.controls.hook = async (request, result) => {
    if (!updated && request.action === 'list' && result.ok && result.data.hasMore) {
      updated = true;
      await h.direct('parent-a', { action: 'upsert', opId: 'move_record_000001', baseRevision: 1, record: { ...reading('7.3'), id: 'record_00000101' } });
    }
  };
  await phone.client.login();
  const snapshot = phone.client.getSnapshot();
  assert.equal(snapshot.records.length, 101);
  assert.equal(snapshot.records.find(record => record.id === 'record_00000101').value, '7.3');
});

test('a local edit queued while pull awaits the network survives the completed merge', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  let release, observed;
  const seen = new Promise(resolve => { observed = resolve; });
  phone.controls.hook = async request => {
    if (request.action === 'list' && !release) { await new Promise(resolve => { release = resolve; observed(); }); }
  };
  const syncing = phone.client.sync(); await seen;
  phone.client.saveRecord(reading('6.8'));
  phone.controls.hook = null; release(); await syncing;
  assert.equal(phone.client.getSnapshot().activeRecords[0].value, '6.8');
  assert.equal(phone.client.getSnapshot().outboxCount, 0);
});

test('invalid and demo records are not queued as personal measurements', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  assert.equal(phone.client.saveRecord(null).ok, false);
  assert.equal(phone.client.saveRecord(reading('0')).ok, false);
  assert.equal(phone.client.saveRecord(reading('6.1', { id: 'demo-00001' })).ok, false);
  assert.equal(phone.client.getSnapshot().outboxCount, 0);
});

test('switching the configured cloud environment does not upload another environment outbox', async () => {
  const h = createHarness(), phone = h.phone();
  const a = phone.createClient({ environmentId: 'development-env' });
  await a.login(); a.saveRecord(reading());
  const b = phone.createClient({ environmentId: 'production-env' });
  await b.login();
  assert.equal(b.getSnapshot().outboxCount, 0);
  assert.equal(b.getSnapshot().records.length, 0);
  assert.equal(h.repository.records.size, 0);
  const restored = phone.createClient({ environmentId: 'development-env' }); await restored.login();
  assert.equal(restored.getSnapshot().activeRecords.length, 1);
});

test('stale requests from an earlier login cannot overwrite the new account snapshot', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  phone.client.saveRecord(reading()); await phone.client.sync();
  let release, observed, held = false;
  const seen = new Promise(resolve => { observed = resolve; });
  phone.controls.hook = async request => {
    if (!held && request.action === 'list') { held = true; await new Promise(resolve => { release = resolve; observed(); }); }
  };
  const oldSync = phone.client.sync(); await seen;
  phone.controls.user = 'parent-b';
  const login = await phone.client.login(); assert.equal(login.ok, true);
  release(); await oldSync;
  assert.equal(phone.client.getSnapshot().authenticated, true);
  assert.equal(phone.client.getSnapshot().records.length, 0);
  assert.equal(phone.client.getSnapshot().status, 'synced');
});

test('identity change after bootstrap cannot write old-account pending data into the new account', async () => {
  const h = createHarness(), phone = h.phone(); await phone.client.login();
  phone.client.saveRecord(reading());
  let switched = false;
  phone.controls.hook = async request => {
    if (!switched && request.action === 'bootstrap') { switched = true; phone.controls.user = 'parent-b'; }
  };
  const result = await phone.client.sync();
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(h.repository.records.size, 0);
  assert.equal(phone.client.getSnapshot().authenticated, false);
  phone.controls.hook = null; phone.controls.user = 'parent-a'; await phone.client.login();
  assert.equal(phone.client.getSnapshot().activeRecords.length, 1);
});

test('identity change after bootstrap cannot pull new-account records into an old-account cache', async () => {
  const h = createHarness(), phone = h.phone();
  await h.direct('parent-b', { action: 'upsert', opId: 'parent_b_seed_op', baseRevision: 0, record: { ...reading('8.2'), id: 'parent_b_record' } });
  await phone.client.login();
  const key = phone.client.getSnapshot().accountKey;
  let switched = false;
  phone.controls.hook = async request => {
    if (!switched && request.action === 'bootstrap') { switched = true; phone.controls.user = 'parent-b'; }
  };
  const result = await phone.client.sync();
  assert.equal(result.error.code, 'ACCOUNT_CHANGED');
  assert.equal(phone.client.getSnapshot().authenticated, false);
  assert.deepEqual(phone.client.getSnapshot().records, []);
  assert.equal(h.storage.get(`family-glucose:wechat:v1:${key}`).records.length, 0);
});

test('editing a cloud-deleted record requires an explicit restore choice and preserves the local edit', async () => {
  const h = createHarness(), a = h.phone(); await a.client.login();
  const { id } = a.client.saveRecord(reading()).data.record; await a.client.sync();
  const b = h.phone('parent-a', new Map()); await b.client.login();
  a.client.deleteRecord(id); await a.client.sync();
  b.client.saveRecord(reading('7.2', { id })); await b.client.sync();
  const conflict = b.client.getSnapshot().conflicts[0]; assert.ok(conflict.cloud.deletedAt);
  assert.equal(b.client.getSnapshot().records[0].value, '7.2');
  b.client.resolveConflict(conflict.id, 'local'); await b.client.sync();
  const final = b.client.getSnapshot();
  assert.equal(final.activeRecords[0].value, '7.2'); assert.equal(final.records[0].revision, 4);
  assert.equal(final.outboxCount, 0);
});
