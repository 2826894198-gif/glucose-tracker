'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

const controllerPath = path.resolve(__dirname, '../miniprogram/pages/home/index.js');
const clone = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const flush = () => new Promise(resolve => setImmediate(resolve));
const reading = (extra = {}) => ({ id: 'record-parent-a-0001', value: '6.1', unit: 'mmol/L', moment: 'fasting', measuredAt: new Date().toISOString(), note: '已保存内容', source: 'manual', revision: 1, syncVersion: 1, syncStatus: 'synced', ...extra });
const snapshot = (accountKey = 'opaque-parent-a', records = []) => ({ accountKey, authenticated: !!accountKey, records: clone(records), activeRecords: clone(records.filter(r => !r.deletedAt)), targets: {}, largeType: false, outboxCount: 0, conflicts: [], status: accountKey ? 'synced' : 'logged-out', lastSyncedAt: null, error: null });

function harness({ records = [] } = {}) {
  const storage = new Map(), calls = [], listeners = new Set();
  const control = { failWrites: false, compress: null, chooseMedia: null, takePhoto: null, readFile: null, writeFile: null, saveCalls: [], deleteCalls: [], modal: null, modalConfirm: true };
  let current = snapshot('opaque-parent-a', records), definition;
  const client = {
    getSnapshot: () => clone(current),
    subscribe(fn) { listeners.add(fn); fn(clone(current)); return () => listeners.delete(fn); },
    emit(next) { current = clone(next); for (const fn of listeners) fn(clone(current)); },
    async login() { return { ok: true }; }, async sync() { return { ok: true }; },
    logout() { this.emit(snapshot(null)); },
    saveRecord(input) { control.saveCalls.push(clone(input)); return { ok: true, data: { record: clone(input), queued: true } }; },
    deleteRecord(id) { control.deleteCalls.push(id); return { ok: true, data: {} }; },
  };
  const app = { config: { cloudEnv: 'test-env-a', version: 'test', ocrFunctionName: 'ocr' }, globalData: { client, configured: false } };
  const wxApi = {
    getWindowInfo: () => ({ statusBarHeight: 20, screenHeight: 812, windowWidth: 375, safeArea: { bottom: 788 } }),
    onKeyboardHeightChange() {}, offKeyboardHeightChange() {}, hideKeyboard() {}, nextTick() {},
    showToast(options) { calls.push({ kind: 'toast', ...options }); },
    showModal(options) { if (control.modal) return control.modal(options); const result = { confirm: control.modalConfirm, cancel: !control.modalConfirm }; if (options.success) options.success(result); return Promise.resolve(result); },
    getStorageSync: key => clone(storage.get(key)),
    setStorageSync(key, value) { if (control.failWrites) throw new Error('disk full'); storage.set(key, clone(value)); },
    removeStorageSync(key) { storage.delete(key); },
    compressImage(options) { calls.push({ kind: 'compress', ...options }); return control.compress ? control.compress(options) : Promise.resolve({ tempFilePath: '/compressed.jpg' }); },
    chooseMedia(options) { return control.chooseMedia ? control.chooseMedia(options) : Promise.resolve({ tempFiles: [{ tempFilePath: '/selected.jpg' }] }); },
    createCameraContext() { return { takePhoto(options) { if (control.takePhoto) control.takePhoto(options); else options.success({ tempImagePath: '/camera.jpg' }); } }; },
    env: { USER_DATA_PATH: '/user-files' },
    getFileSystemManager() { return {
      readFile(options) { calls.push({ kind: 'read', filePath: options.filePath }); if (control.readFile) control.readFile(options); else options.success({ data: 'dGVzdA==' }); },
      writeFile(options) { calls.push({ kind: 'write', filePath: options.filePath, data: options.data }); if (control.writeFile) control.writeFile(options); else options.success(); },
    }; },
    async shareFileMessage(options) { calls.push({ kind: 'share', ...clone(options) }); },
    cloud: { async callFunction(options) { calls.push({ kind: 'cloud', ...clone(options) }); return { result: { ok: true, data: { value: '6.7', unit: 'mmol/L', rawText: '6.7 mmol/L' } } }; } },
  };
  vm.runInNewContext(fs.readFileSync(controllerPath, 'utf8'), { require: createRequire(controllerPath), Page: page => { definition = page; }, wx: wxApi, getApp: () => app, console }, { filename: controllerPath });
  const page = { ...definition, data: clone(definition.data), setData(values, callback) {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.'); let object = this.data;
      for (let i = 0; i < parts.length - 1; i++) { if (!object[parts[i]]) object[parts[i]] = {}; object = object[parts[i]]; }
      object[parts[parts.length - 1]] = value;
    }
    if (callback) callback();
  } };
  page.onLoad(); app.globalData.configured = true;
  return { page, client, app, wxApi, control, storage, calls, ocrCalls: () => calls.filter(c => c.kind === 'cloud') };
}

test('completing or clearing a demo draft never removes the authenticated personal draft', async () => {
  const h = harness(), { page } = h;
  const key = page.draftKey(), personal = reading({ value: '7.3', note: '个人未保存草稿' });
  h.storage.set(key, personal);
  page.showDemo(); page.applyDraft(reading({ id: 'demo-entry-0001', value: '5.4' }));
  await page.saveRecord();
  assert.deepEqual(h.storage.get(key), personal);
  assert.equal(h.control.saveCalls.length, 0);
  assert.equal(page.data.view, 'home');
});

test('editing a record resumes its same-id unsaved draft instead of replacing it with the cloud value', () => {
  const original = reading(), h = harness({ records: [original] }), { page } = h;
  const draft = reading({ value: '7.3', note: '尚未保存的修正' });
  h.storage.set(page.draftKey(), draft);
  page.openRecord({ currentTarget: { dataset: { id: original.id } } });
  page.editRecord();
  assert.equal(page.data.view, 'review'); assert.equal(page.data.draft.value, '7.3');
  assert.equal(page.data.draft.note, '尚未保存的修正');
});

test('identity change clears sensitive page state and rejects a late save of the previous account draft', async () => {
  const record = reading(), h = harness({ records: [record] }), { page } = h;
  page.applyDraft(reading({ value: '8.2', note: 'A账号草稿' }), '/private-a.jpg');
  page.setData({ detailId: record.id, detail: record, ocrRaw: 'A私密识别原文' });
  h.client.emit(snapshot('opaque-parent-b'));
  assert.equal(page.data.view, 'home'); assert.equal(page.data.photoPath, '');
  assert.equal(page.data.ocrRaw, ''); assert.equal(page.data.detail, null);
  assert.notEqual(page.data.draft.value, '8.2');
  // A delayed event may still carry the prior form's values; ownership must be checked again at save.
  page.setData({ draft: record }); await page.saveRecord();
  assert.equal(h.control.saveCalls.length, 0);
  assert.match(page.data.formError, /身份|重新填写/);
});

test('losing authentication hides draft and photo even before another account is verified', () => {
  const h = harness(); h.page.applyDraft(reading({ note: '本地草稿' }), '/private-a.jpg');
  h.client.emit(snapshot(null));
  assert.equal(h.page.data.ready, false); assert.equal(h.page.data.view, 'home');
  assert.equal(h.page.data.photoPath, ''); assert.notEqual(h.page.data.draft.note, '本地草稿');
});

test('a delete confirmation started by A never deletes a different detail opened by B', async () => {
  const a = reading(), b = reading({ id: 'record-parent-b-0001', value: '7.5' });
  const h = harness({ records: [a] }), hold = deferred(); h.control.modal = () => hold.promise;
  h.page.openRecord({ currentTarget: { dataset: { id: a.id } } });
  const deleting = h.page.removeRecord();
  h.client.emit(snapshot('opaque-parent-b', [b])); h.page.openRecord({ currentTarget: { dataset: { id: b.id } } });
  hold.resolve({ confirm: true }); await deleting;
  assert.deepEqual(h.control.deleteCalls, []);
  assert.equal(h.page.data.detailId, b.id);
});

test('an old discard confirmation cannot clear the new account draft', async () => {
  const h = harness(), hold = deferred(); h.control.modal = () => hold.promise;
  h.page.applyDraft(reading({ note: 'A草稿' })); const discarding = h.page.discardDraft();
  h.client.emit(snapshot('opaque-parent-b'));
  h.page.applyDraft(reading({ id: 'record-parent-b-0001', value: '7.5', note: 'B新草稿' })); h.page.keepDraft();
  const key = h.page.draftKey(); hold.resolve({ confirm: true }); await discarding;
  assert.equal(h.page.data.view, 'review'); assert.equal(h.page.data.draft.note, 'B新草稿');
  assert.equal(h.storage.get(key).note, 'B新草稿');
});

test('an old logout confirmation cannot log out a newly verified account', async () => {
  const h = harness(), hold = deferred(); h.control.modal = () => hold.promise;
  const loggingOut = h.page.logout(); h.client.emit(snapshot('opaque-parent-b')); h.page.go('mine');
  hold.resolve({ confirm: true }); await loggingOut;
  assert.equal(h.client.getSnapshot().accountKey, 'opaque-parent-b'); assert.equal(h.page.data.view, 'mine');
});

test('old back and edit confirmation callbacks cannot replace the current account form', () => {
  for (const operation of ['back', 'editRecord']) {
    const a = reading(), h = harness({ records: [a] }); let answer;
    h.control.modal = options => { answer = options.success; return Promise.resolve({ confirm: false }); };
    if (operation === 'back') h.page.applyDraft(a);
    else { h.storage.set(h.page.draftKey(), reading({ id: 'different-draft-0001' })); h.page.openRecord({ currentTarget: { dataset: { id: a.id } } }); }
    h.page[operation](); assert.equal(typeof answer, 'function');
    h.client.emit(snapshot('opaque-parent-b')); h.page.applyDraft(reading({ id: 'record-parent-b-0001', note: 'B当前表单' }));
    answer({ confirm: operation === 'back' });
    assert.equal(h.page.data.view, 'review'); assert.equal(h.page.data.draft.note, 'B当前表单');
  }
});

test('an old version-choice confirmation cannot resolve a conflict in another account', async () => {
  const h = harness(), hold = deferred(); let resolves = 0;
  h.control.modal = () => hold.promise; h.client.resolveConflict = () => { resolves++; return { ok: true }; };
  const choosing = h.page.resolveVersion({ currentTarget: { dataset: { id: 'op-a-0001', choice: 'local' } } });
  h.client.emit(snapshot('opaque-parent-b')); hold.resolve({ confirm: true }); await choosing;
  assert.equal(resolves, 0);
});

test('a delayed save result cannot clear or navigate away from the new account draft', async () => {
  const h = harness(), hold = deferred(); h.client.saveRecord = () => hold.promise;
  h.page.applyDraft(reading()); const saving = h.page.saveRecord();
  h.client.emit(snapshot('opaque-parent-b')); h.page.applyDraft(reading({ id: 'record-parent-b-0001', note: 'B继续填写' })); h.page.keepDraft();
  const key = h.page.draftKey(); hold.resolve({ ok: true, data: {} }); await saving;
  assert.equal(h.page.data.view, 'review'); assert.equal(h.page.data.draft.note, 'B继续填写');
  assert.equal(h.storage.get(key).note, 'B继续填写');
});

for (const [handler, service] of [['saveTarget', 'setTarget'], ['clearTarget', 'removeTarget'], ['toggleLarge', 'setLargeType'], ['restoreRecord', 'restoreRecord']]) {
  test(`a delayed ${handler} result cannot update the next account page`, async () => {
    const h = harness(), hold = deferred(); h.client[service] = () => hold.promise;
    h.page.openTarget(); h.page.setData({ targetLow: '4.4', targetHigh: '7', targetChanged: true });
    const pending = h.page[handler]({ currentTarget: { dataset: { id: 'record-a-0001' } } });
    h.client.emit(snapshot('opaque-parent-b')); h.page.go('mine');
    hold.resolve({ ok: false, error: { message: 'A账号旧错误' } }); await pending;
    assert.equal(h.page.data.view, 'mine'); assert.notEqual(h.page.data.targetError, 'A账号旧错误');
    assert.equal(h.calls.filter(c => c.kind === 'toast' && c.title === 'A账号旧错误').length, 0);
  });
}

test('a delayed export does not share a previous account CSV, and concurrent exports use distinct paths', async () => {
  const h = harness({ records: [reading()] }), writes = [];
  h.control.writeFile = options => writes.push(options);
  const first = h.page.exportRecords(); assert.equal(writes.length, 1);
  h.client.emit(snapshot('opaque-parent-b', [reading({ id: 'record-parent-b-0001', note: 'B记录' })]));
  const second = h.page.exportRecords(); assert.equal(writes.length, 2);
  assert.notEqual(writes[0].filePath, writes[1].filePath);
  writes[1].success(); await second;
  writes[0].success(); await first;
  const shared = h.calls.filter(c => c.kind === 'share');
  assert.equal(shared.length, 1); assert.equal(shared[0].filePath, writes[1].filePath);
});

test('failed durable draft write prevents explicit navigation and preserves the entered value', () => {
  const h = harness(), { page } = h;
  page.applyDraft(reading({ value: '7.8', note: '请保留输入' }));
  h.control.failWrites = true; page.toHome();
  assert.equal(page.data.view, 'review'); assert.equal(page.data.draft.value, '7.8');
  assert.match(page.data.formError, /未能保存|保留当前/);
  h.control.failWrites = false; page.toHome();
  assert.equal(page.data.view, 'home'); page.startRecord();
  assert.equal(page.data.draft.value, '7.8'); assert.equal(page.data.draft.note, '请保留输入');
});

test('draft retained in memory after a background storage failure can be resumed on the same account', () => {
  const h = harness(), { page } = h;
  page.applyDraft(reading({ value: '7.9', note: '后台未写入磁盘' }));
  h.control.failWrites = true; page.onHide();
  h.control.failWrites = false; page.go('home'); page.startRecord();
  assert.equal(page.data.view, 'review'); assert.equal(page.data.draft.value, '7.9');
  assert.equal(page.data.draft.note, '后台未写入磁盘');
});

for (const change of ['navigate', 'background', 'account']) {
  test(`delayed image compression does not upload an old photo after ${change}`, async () => {
    const h = harness(), hold = deferred(); h.control.compress = () => hold.promise;
    h.page.startRecord(); const recognition = h.page.recognizePhoto('/private-a.jpg');
    if (change === 'navigate') h.page.toHome();
    else if (change === 'background') h.page.onHide();
    else h.client.emit(snapshot('opaque-parent-b'));
    hold.resolve({ tempFilePath: '/compressed-a.jpg' }); await recognition;
    assert.equal(h.ocrCalls().length, 0);
    assert.notEqual(h.page.data.draft.value, '6.7');
  });
}

test('a delayed file read checks the account again before uploading image bytes', { timeout: 1000 }, async () => {
  const h = harness(), enteredRead = deferred(); let finishRead;
  h.control.readFile = options => { finishRead = () => options.success({ data: 'cHJpdmF0ZS1h' }); enteredRead.resolve(); };
  h.page.startRecord(); const recognition = h.page.recognizePhoto('/private-a.jpg');
  await enteredRead.promise;
  assert.equal(typeof finishRead, 'function');
  h.client.emit(snapshot('opaque-parent-b')); finishRead(); await recognition;
  assert.equal(h.ocrCalls().length, 0);
});

test('an album picker opened by one account cannot begin recognition after switching to another account', async () => {
  const h = harness(), hold = deferred(); h.control.chooseMedia = () => hold.promise;
  h.page.startRecord(); const choosing = h.page.chooseAlbum();
  await flush(); h.client.emit(snapshot('opaque-parent-b'));
  hold.resolve({ tempFiles: [{ tempFilePath: '/private-a.jpg' }] }); await choosing;
  await flush();
  assert.equal(h.ocrCalls().length, 0); assert.equal(h.page.data.photoPath, '');
});

test('a late camera callback cannot upload a photo after navigation or an account switch', async () => {
  const h = harness(); let completePhoto;
  h.control.takePhoto = options => { completePhoto = () => options.success({ tempImagePath: '/private-a.jpg' }); };
  h.page.startRecord(); h.page.setData({ cameraOn: true }); await h.page.shutter();
  h.client.emit(snapshot('opaque-parent-b')); completePhoto();
  await flush();
  assert.equal(h.ocrCalls().length, 0); assert.equal(h.page.data.photoPath, '');
});

test('unauthenticated and demo photo flows do not transmit image bytes to OCR', async () => {
  const h = harness(); h.client.emit(snapshot(null));
  await h.page.recognizePhoto('/locked.jpg'); assert.equal(h.ocrCalls().length, 0);
  h.page.showDemo(); h.page.startRecord(); await h.page.recognizePhoto('/demo.jpg');
  assert.equal(h.ocrCalls().length, 0);
});

test('target conflict descriptions expose the actual contexts, units and numerical ranges for a choice', () => {
  const h = harness();
  const local = h.page.conflictDescription({ 'fasting:mmol/L': { low: 4.4, high: 7, unit: 'mmol/L' } });
  const remote = h.page.conflictDescription({ ranges: { 'fasting:mmol/L': { low: 4.8, high: 7.2, unit: 'mmol/L' }, 'after:120:mmol/L': { low: 4.4, high: 9, unit: 'mmol/L' } }, revision: 3 });
  assert.match(local, /4\.4/); assert.match(local, /7/); assert.match(local, /mmol\/L/); assert.match(local, /空腹/);
  assert.match(remote, /4\.8/); assert.match(remote, /7\.2/); assert.match(remote, /餐后/);
  assert.notEqual(local, remote);
});
