'use strict';

const CACHE_VERSION = 1;
const ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CONTEXTS = ['fasting', 'before', 'after', 'bedtime', 'other'];
const UNITS = ['mmol/L', 'mg/dL'];
const clone = value => JSON.parse(JSON.stringify(value));
const failure = (code, message) => ({ ok: false, error: { code, message } });
const validRevision = value => Number.isInteger(value) && value >= 0;

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 13)}_${Math.random().toString(36).slice(2, 8)}`;
}

function contextKey(context) {
  if (!context || !CONTEXTS.includes(context.moment) || !UNITS.includes(context.unit)) throw new Error('请选择有效的测量时机和单位。');
  if (context.moment !== 'after') return `${context.moment}:${context.unit}`;
  const minutes = context.afterMinutes === undefined ? 120 : context.afterMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new Error('餐后间隔无效。');
  return `after:${minutes}:${context.unit}`;
}

function keyContext(key) {
  const parts = key.split(':');
  return parts[0] === 'after' ? { moment: 'after', afterMinutes: Number(parts[1]), unit: parts[2] } : { moment: parts[0], unit: parts[1] };
}

function freshState(accountKey) {
  return { version: CACHE_VERSION, accountKey, records: [], targets: {}, targetsRevision: 0, preferences: { largeType: false, revision: 0 }, outbox: [], conflicts: [], afterVersion: 0, lastSyncedAt: null };
}

function safeRecord(record) {
  return !!record && typeof record === 'object' && ID_PATTERN.test(record.id || '') &&
    typeof record.value === 'string' && /^\d{1,4}(?:\.\d{1,2})?$/.test(record.value) && Number(record.value) > 0 &&
    UNITS.includes(record.unit) && CONTEXTS.includes(record.moment) && typeof record.note === 'string' &&
    Number.isFinite(Date.parse(record.measuredAt)) && Number.isFinite(Date.parse(record.createdAt)) && Number.isFinite(Date.parse(record.updatedAt)) &&
    (record.source === 'manual' || record.source === 'photo') && validRevision(record.revision || 0) &&
    (!record.deletedAt || Number.isFinite(Date.parse(record.deletedAt)));
}

function validState(value, accountKey) {
  return !!value && value.version === CACHE_VERSION && value.accountKey === accountKey &&
    Array.isArray(value.records) && value.records.every(safeRecord) && Array.isArray(value.outbox) &&
    value.outbox.every(op => op && ID_PATTERN.test(op.opId || '') && typeof op.entity === 'string' && typeof op.kind === 'string' && validRevision(op.baseRevision)) &&
    Array.isArray(value.conflicts) && value.targets && typeof value.targets === 'object' && !Array.isArray(value.targets) &&
    validRevision(value.targetsRevision) && value.preferences && typeof value.preferences.largeType === 'boolean' && validRevision(value.preferences.revision) &&
    validRevision(value.afterVersion);
}

function defaultDomain() {
  // Generated from the already validated preview data/analysis modules by the
  // project build. No separate, less strict fallback accepts unknown input.
  return require('../utils/domain');
}

/**
 * All identity comes from glucose.bootstrap. Local state is locked on every
 * cold start until a successful server identity check. We never guess an
 * account from a cached OpenID or expose another account after login failure.
 */
function createClient(options) {
  const opts = options || {};
  const wxApi = opts.wxApi || (typeof wx !== 'undefined' ? wx : null);
  if (!wxApi) throw new Error('微信运行环境不可用。');
  const functionName = opts.functionName || 'glucose';
  const basePrefix = opts.storagePrefix || 'family-glucose:wechat:v1';
  const prefix = opts.environmentId ? `${basePrefix}:${encodeURIComponent(String(opts.environmentId))}` : basePrefix;
  const clock = opts.now || (() => new Date());
  const idFactory = opts.idFactory || makeId;
  const autoSync = opts.autoSync !== false;
  const subscribers = new Set();
  let state = null;
  let authenticated = false;
  let accountKey = null;
  let status = 'logged-out';
  let error = null;
  let epoch = 0;
  let syncPromise = null;
  let syncEpoch = -1;
  let storageLocked = false;

  const stamp = () => clock().toISOString();
  const cacheKey = key => `${prefix}:${key}`;
  const recordEntity = id => `record:${id}`;
  const pendingFor = entity => state ? state.outbox.filter(op => op.entity === entity) : [];

  function getSnapshot() {
    const records = authenticated && state ? state.records.map(record => ({ ...record,
      syncStatus: state.conflicts.some(conflict => conflict.entity === recordEntity(record.id)) ? 'conflict' : pendingFor(recordEntity(record.id)).length ? 'pending' : 'synced',
    })).sort((a, b) => Date.parse(b.measuredAt) - Date.parse(a.measuredAt)) : [];
    return clone({ accountKey: authenticated ? accountKey : null, authenticated, records,
      activeRecords: records.filter(record => !record.deletedAt), targets: authenticated && state ? state.targets : {},
      largeType: !!(authenticated && state && state.preferences.largeType),
      outboxCount: authenticated && state ? state.outbox.length : 0,
      conflicts: authenticated && state ? state.conflicts : [], status, lastSyncedAt: state && authenticated ? state.lastSyncedAt : null, error,
    });
  }

  function emit() {
    const snapshot = getSnapshot();
    subscribers.forEach(listener => { try { listener(snapshot); } catch (_) { /* A view cannot break persistence. */ } });
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('订阅者必须是函数。');
    subscribers.add(listener); listener(getSnapshot());
    return () => subscribers.delete(listener);
  }

  function idleStatus() {
    if (!authenticated) return 'logged-out';
    if (storageLocked) return 'error';
    if (state.conflicts.length) return 'conflict';
    return state.outbox.length ? 'pending' : 'synced';
  }

  function persist(next) {
    if (storageLocked) return failure('LOCAL_STORAGE_CORRUPT', '本机缓存无法读取，原数据已保留；请勿清空应用数据。');
    try {
      wxApi.setStorageSync(cacheKey(accountKey), clone(next));
      state = next;
      return { ok: true, data: null };
    } catch (_) {
      return failure('LOCAL_SAVE_FAILED', '本机保存失败，请检查手机存储空间后重试。输入内容尚未写入。');
    }
  }

  function guard() {
    if (!authenticated || !state) return failure('LOGIN_REQUIRED', '请先联网确认当前微信身份，再使用自己的记录。');
    if (storageLocked) return failure('LOCAL_STORAGE_CORRUPT', '本机缓存格式异常，原数据已保留，暂不能覆盖。');
    return null;
  }

  function operation(next, entity, kind, payload, baseRevision) {
    const previous = next.outbox.filter(op => op.entity === entity).slice(-1)[0];
    const op = { opId: idFactory('op'), entity, kind, payload: clone(payload), baseRevision,
      dependsOn: previous ? previous.opId : null, createdAt: stamp() };
    next.outbox.push(op);
    return op;
  }

  function changed(next, data) {
    next.conflicts.forEach(conflict => {
      const value = conflict.entity === 'targets' ? next.targets : conflict.entity === 'preferences' ? next.preferences : next.records.find(record => record.id === conflict.recordId);
      conflict.local = clone(value || null);
    });
    const saved = persist(next);
    if (!saved.ok) { error = saved.error; status = 'error'; emit(); return saved; }
    error = null; status = idleStatus(); emit();
    if (autoSync) Promise.resolve().then(() => sync()).catch(() => {});
    return { ok: true, data: { ...data, queued: true } };
  }

  async function call(action, payload) {
    if (!wxApi.cloud || typeof wxApi.cloud.callFunction !== 'function') return failure('CLOUD_UNAVAILABLE', '当前微信暂不支持云端连接，请更新微信后重试。未载入任何个人记录。');
    try {
      const response = await wxApi.cloud.callFunction({ name: functionName, data: { action, ...payload, ...(action === 'bootstrap' ? {} : { expectedAccountId: accountKey }) } });
      const result = response && response.result;
      if (!result || typeof result.ok !== 'boolean') return failure('INVALID_CLOUD_RESPONSE', '云端返回异常，请稍后重试。');
      return result;
    } catch (_) { return failure('NETWORK_UNAVAILABLE', '暂时无法连接云端。本机已保存的内容会在恢复网络后继续同步。'); }
  }

  async function login() {
    const token = ++epoch;
    authenticated = false; accountKey = null; state = null; storageLocked = false; status = 'connecting'; error = null; emit();
    const result = await call('bootstrap', {});
    if (token !== epoch) return failure('SESSION_CHANGED', '微信身份已切换，请重试。');
    if (!result.ok) { error = result.error; status = 'error'; emit(); return result; }
    const bootstrap = result.data || {};
    const key = bootstrap.accountId;
    if (typeof key !== 'string' || !ID_PATTERN.test(key) || !bootstrap.preferences || !bootstrap.targets) {
      error = { code: 'INVALID_CLOUD_RESPONSE', message: '无法确认云端身份，未载入任何本机记录。' }; status = 'error'; emit(); return { ok: false, error };
    }
    accountKey = key;
    try {
      const saved = wxApi.getStorageSync(cacheKey(key));
      if (saved !== undefined && saved !== null && saved !== '') {
        if (!validState(saved, key)) throw new Error('invalid cache');
        state = clone(saved);
      } else state = freshState(key);
    } catch (_) {
      authenticated = true; storageLocked = true; state = freshState(key); status = 'error';
      error = { code: 'LOCAL_STORAGE_CORRUPT', message: '本机缓存无法读取，原数据已保留。请勿清空应用数据，联系家人协助检查。' }; emit(); return { ok: false, error };
    }
    authenticated = true;
    const next = clone(state);
    if (!next.outbox.some(op => op.entity === 'targets')) next.targets = clone(bootstrap.targets.ranges || {});
    next.targetsRevision = bootstrap.targets.revision || 0;
    if (!next.outbox.some(op => op.entity === 'preferences')) next.preferences = clone(bootstrap.preferences);
    const saved = persist(next);
    if (!saved.ok) { status = 'error'; error = saved.error; emit(); return saved; }
    status = idleStatus(); emit();
    await sync();
    if (token !== epoch) return failure('SESSION_CHANGED', '微信身份已切换，请重试。');
    if (!authenticated) return { ok: false, error: error || { code: 'LOGIN_REQUIRED', message: '微信身份需要重新确认。' } };
    return { ok: true, data: getSnapshot() };
  }

  function saveRecord(input) {
    const unavailable = guard(); if (unavailable) return unavailable;
    let domain;
    try { domain = opts.domain || defaultDomain(); } catch (_) { return failure('BUILD_REQUIRED', '记录模块尚未构建，请更新小程序后重试。'); }
    if (!input || typeof input !== 'object') return failure('VALIDATION', '记录内容无效。');
    let result; try { result = domain.validateRecordInput(input, clock()); } catch (_) { return failure('VALIDATION', '请核对记录内容后重试。'); }
    if (!result.ok) return failure('VALIDATION', result.error);
    const id = input.id || idFactory('r');
    if (!ID_PATTERN.test(id) || id.length < 8 || id.length > 80 || /^demo[-_]/i.test(id)) return failure('VALIDATION', '记录标识无效，示例不能上传为个人测量。');
    const previous = state.records.find(record => record.id === id);
    if (previous && previous.deletedAt) return failure('DELETED_RECORD', '请先从最近删除恢复这条记录，再修改。');
    const timestamp = stamp();
    const record = { ...result.data, id, createdAt: previous ? previous.createdAt : timestamp,
      updatedAt: timestamp, revision: previous ? previous.revision || 0 : 0,
      syncVersion: previous ? previous.syncVersion || 0 : 0 };
    const next = clone(state);
    next.records = [...next.records.filter(value => value.id !== id), record];
    operation(next, recordEntity(id), 'upsert', { record: { id, ...result.data } }, record.revision);
    return changed(next, { record: { ...record, syncStatus: 'pending' } });
  }

  function setDeleted(id, deleted) {
    const unavailable = guard(); if (unavailable) return unavailable;
    const previous = state.records.find(record => record.id === id);
    if (!previous) return failure('NOT_FOUND', '这条记录不存在，请刷新后重试。');
    if (!deleted && !previous.deletedAt) return failure('NOT_DELETED', '这条记录没有被删除。');
    const next = clone(state), timestamp = stamp();
    const record = { ...previous, updatedAt: timestamp };
    if (deleted) record.deletedAt = timestamp; else delete record.deletedAt;
    next.records = next.records.map(value => value.id === id ? record : value);
    operation(next, recordEntity(id), deleted ? 'delete' : 'restore', { id }, previous.revision || 0);
    return changed(next, { record: { ...record, syncStatus: 'pending' } });
  }

  function setTarget(context, range) {
    const unavailable = guard(); if (unavailable) return unavailable;
    let key, domain;
    try { key = contextKey(context); domain = opts.domain || defaultDomain(); } catch (_) { return failure('VALIDATION', '范围的测量时机、间隔或单位无效。'); }
    let result; try { result = domain.validateTargetRange(range, clock()); } catch (_) { return failure('VALIDATION', '请核对个人范围后重试。'); }
    if (!result.ok) return failure('VALIDATION', result.error);
    if (result.data.unit !== context.unit) return failure('VALIDATION', '范围单位与当前选择不一致。');
    const next = clone(state);
    next.targets[key] = result.data;
    operation(next, 'targets', 'targets.set', { context, range: { low: result.data.low, high: result.data.high, unit: result.data.unit } }, next.targetsRevision);
    return changed(next, { targets: next.targets });
  }

  function removeTarget(context) {
    const unavailable = guard(); if (unavailable) return unavailable;
    let key; try { key = contextKey(context); } catch (e) { return failure('VALIDATION', e.message); }
    const next = clone(state); delete next.targets[key];
    operation(next, 'targets', 'targets.remove', { context }, next.targetsRevision);
    return changed(next, { targets: next.targets });
  }

  function setLargeType(largeType) {
    const unavailable = guard(); if (unavailable) return unavailable;
    if (typeof largeType !== 'boolean') return failure('VALIDATION', '字号设置无效。');
    const next = clone(state); next.preferences.largeType = largeType;
    operation(next, 'preferences', 'preferences.set', { preferences: { largeType } }, next.preferences.revision);
    return changed(next, { largeType });
  }

  function recordConflict(op, remote, message) {
    const next = clone(state);
    const local = op.entity === 'targets' ? next.targets : op.entity === 'preferences' ? next.preferences : next.records.find(record => record.id === op.payload.id || op.payload.record && record.id === op.payload.record.id);
    next.conflicts = [...next.conflicts.filter(conflict => conflict.entity !== op.entity), {
      id: op.opId, entity: op.entity, kind: op.kind, recordId: op.payload.id || op.payload.record && op.payload.record.id,
      context: op.payload.context, local: clone(local || null), cloud: clone(remote || null), message,
      createdAt: stamp(),
    }];
    return persist(next);
  }

  function acknowledge(op, data) {
    const next = clone(state);
    next.outbox = next.outbox.filter(value => value.opId !== op.opId);
    let revision;
    if (op.entity === 'targets') {
      revision = data.revision;
      next.targetsRevision = revision;
      if (!next.outbox.some(value => value.entity === 'targets')) next.targets = clone(data.ranges);
    } else if (op.entity === 'preferences') {
      const preferences = data.preferences;
      revision = preferences.revision;
      next.preferences.revision = revision;
      if (!next.outbox.some(value => value.entity === 'preferences')) next.preferences = clone(preferences);
    } else {
      const remote = data.record;
      if (!safeRecord(remote) || !validRevision(remote.revision)) return failure('INVALID_CLOUD_RESPONSE', '云端记录格式异常，保留本机内容等待重试。');
      revision = remote.revision;
      const remains = next.outbox.some(value => value.entity === op.entity);
      const optimistic = next.records.find(record => record.id === remote.id);
      const value = remains && optimistic ? { ...optimistic, revision, syncVersion: remote.syncVersion } : remote;
      next.records = [...next.records.filter(record => record.id !== remote.id), value];
    }
    if (!validRevision(revision)) return failure('INVALID_CLOUD_RESPONSE', '云端版本信息无效，保留本机内容等待重试。');
    next.outbox.forEach(value => { if (value.dependsOn === op.opId) { value.dependsOn = null; value.baseRevision = revision; } });
    return persist(next);
  }

  async function performSync(token, rounds) {
    status = 'syncing'; error = null; emit();
    // Reconfirm identity before sending any queued health data. A changed
    // WeChat account must never receive the previous account's pending writes.
    const identity = await call('bootstrap', {});
    if (token !== epoch || !authenticated) return failure('SESSION_CHANGED', '微信身份已切换。');
    if (!identity.ok) {
      error = identity.error;
      if (['AUTH_REQUIRED', 'UNAUTHENTICATED', 'LOGIN_REQUIRED', 'UNAUTHORIZED', 'ACCOUNT_CHANGED'].includes(error.code)) { authenticated = false; status = 'logged-out'; }
      else status = error.code === 'NETWORK_UNAVAILABLE' ? 'offline' : 'error';
      emit(); return identity;
    }
    if (!identity.data || identity.data.accountId !== accountKey) {
      epoch += 1; authenticated = false; accountKey = null; state = null; status = 'logged-out';
      error = { code: 'ACCOUNT_CHANGED', message: '当前微信身份已改变。原账号的待同步记录已留在本机，请重新登录。' }; emit(); return { ok: false, error };
    }
    const configuration = clone(state);
    if (!configuration.outbox.some(op => op.entity === 'targets')) { configuration.targets = clone(identity.data.targets.ranges); configuration.targetsRevision = identity.data.targets.revision; }
    if (!configuration.outbox.some(op => op.entity === 'preferences')) configuration.preferences = clone(identity.data.preferences);
    const configSaved = persist(configuration);
    if (!configSaved.ok) { error = configSaved.error; status = 'error'; emit(); return configSaved; }
    while (token === epoch) {
      const blocked = new Set(state.conflicts.map(conflict => conflict.entity));
      const op = state.outbox.find(value => !blocked.has(value.entity) && !value.dependsOn);
      if (!op) break;
      const result = await call(op.kind, { opId: op.opId, baseRevision: op.baseRevision, ...op.payload });
      if (token !== epoch || !authenticated) return failure('SESSION_CHANGED', '微信身份已切换。');
      if (!result.ok) {
        if (['CONFLICT', 'DELETED'].includes(result.error.code)) {
          const recorded = recordConflict(op, result.error.details && result.error.details.current, result.error.message);
          if (!recorded.ok) { error = recorded.error; status = 'error'; emit(); return recorded; }
          emit(); continue;
        }
        error = result.error;
        if (['AUTH_REQUIRED', 'UNAUTHENTICATED', 'LOGIN_REQUIRED', 'UNAUTHORIZED', 'ACCOUNT_CHANGED'].includes(result.error.code)) {
          authenticated = false; status = 'logged-out';
        } else status = result.error.code === 'NETWORK_UNAVAILABLE' ? 'offline' : 'error';
        emit(); return result;
      }
      const saved = acknowledge(op, result.data);
      if (!saved.ok) { error = saved.error; status = 'error'; emit(); return saved; }
      emit();
    }
    let cursor = null, watermark = undefined, latestVersion = 0;
    const pulled = new Map();
    do {
      const result = await call('list', { afterVersion: state.afterVersion, ...(watermark === undefined ? {} : { uptoVersion: watermark }), ...(cursor === null ? {} : { cursor }), limit: 100 });
      if (token !== epoch || !authenticated) return failure('SESSION_CHANGED', '微信身份已切换。');
      if (!result.ok) { error = result.error; if (['AUTH_REQUIRED', 'UNAUTHENTICATED', 'LOGIN_REQUIRED', 'UNAUTHORIZED', 'ACCOUNT_CHANGED'].includes(error.code)) { authenticated = false; status = 'logged-out'; } else status = result.error.code === 'NETWORK_UNAVAILABLE' ? 'offline' : 'error'; emit(); return result; }
      const page = result.data;
      if (!page || !Array.isArray(page.records) || !page.records.every(safeRecord) || !validRevision(page.watermark) || (watermark !== undefined && page.watermark !== watermark) || (page.hasMore && (typeof page.nextCursor !== 'string' || page.nextCursor === cursor))) {
        error = { code: 'INVALID_CLOUD_RESPONSE', message: '云端分页数据异常，本机内容已保留。' }; status = 'error'; emit(); return { ok: false, error };
      }
      if (watermark === undefined) watermark = page.watermark;
      latestVersion = Math.max(latestVersion, validRevision(page.latestVersion) ? page.latestVersion : page.watermark);
      page.records.forEach(remote => pulled.set(remote.id, remote));
      cursor = page.hasMore ? page.nextCursor : null;
    } while (cursor !== null);
    // A full stable snapshot is committed at once. Build from the latest state
    // so concurrent edits or explicit conflict choices cannot be rolled back.
    const next = clone(state);
    pulled.forEach(remote => {
      if (!next.outbox.some(op => op.entity === recordEntity(remote.id))) {
        const previous = next.records.find(record => record.id === remote.id);
        if (!previous || (remote.revision || 0) >= (previous.revision || 0)) next.records = [...next.records.filter(record => record.id !== remote.id), remote];
      }
    });
    next.afterVersion = watermark || 0; next.lastSyncedAt = stamp();
    const saved = persist(next);
    if (!saved.ok) { error = saved.error; status = 'error'; emit(); return saved; }
    status = idleStatus(); error = null; emit();
    // A local mutation can be added while a pull awaits the network.
    if (state.outbox.some(op => !state.conflicts.some(conflict => conflict.entity === op.entity) && !op.dependsOn) || latestVersion > watermark) {
      if ((rounds || 0) >= 9) { error = { code: 'SYNC_BUSY', message: '云端仍在更新，已保留当前进度，请稍后再同步。' }; status = 'pending'; emit(); return { ok: false, error }; }
      return performSync(token, (rounds || 0) + 1);
    }
    return { ok: true, data: getSnapshot() };
  }

  function sync() {
    const unavailable = guard(); if (unavailable) return Promise.resolve(unavailable);
    if (syncPromise && syncEpoch === epoch) return syncPromise;
    const token = epoch;
    syncEpoch = token;
    const request = performSync(token).catch(() => {
      if (token !== epoch) return failure('SESSION_CHANGED', '微信身份已切换。');
      error = { code: 'SYNC_FAILED', message: '同步暂未完成，本机内容已保留，请稍后重试。' }; status = 'error'; emit(); return { ok: false, error };
    }).finally(() => { if (syncPromise === request) syncPromise = null; });
    syncPromise = request;
    return request;
  }

  function resolveConflict(conflictId, choice) {
    const unavailable = guard(); if (unavailable) return unavailable;
    if (choice !== 'local' && choice !== 'cloud') return failure('VALIDATION', '请选择保留本机或云端版本。');
    const conflict = state.conflicts.find(value => value.id === conflictId);
    if (!conflict) return failure('NOT_FOUND', '这项冲突已不存在。');
    const next = clone(state), operations = next.outbox.filter(op => op.entity === conflict.entity);
    next.outbox = next.outbox.filter(op => op.entity !== conflict.entity);
    next.conflicts = next.conflicts.filter(value => value.entity !== conflict.entity);
    const remote = conflict.cloud;
    if (conflict.entity === 'targets') {
      const desired = clone(next.targets), ranges = clone(remote && remote.ranges || {}), revision = remote && remote.revision || 0;
      next.targetsRevision = revision;
      if (choice === 'cloud') next.targets = ranges;
      else {
        const contexts = new Map(); operations.forEach(op => contexts.set(contextKey(op.payload.context), op.payload.context));
        contexts.forEach((context, key) => {
          if (desired[key]) {
            ranges[key] = desired[key];
            operation(next, 'targets', 'targets.set', { context, range: { low: desired[key].low, high: desired[key].high, unit: desired[key].unit } }, revision);
          } else { delete ranges[key]; operation(next, 'targets', 'targets.remove', { context }, revision); }
        });
        next.targets = ranges;
      }
    } else if (conflict.entity === 'preferences') {
      const remotePreferences = remote && remote.preferences || remote || { largeType: false, revision: 0 };
      if (choice === 'cloud') next.preferences = clone(remotePreferences);
      else { next.preferences.revision = remotePreferences.revision || 0; operation(next, 'preferences', 'preferences.set', { preferences: { largeType: next.preferences.largeType } }, next.preferences.revision); }
    } else {
      const id = conflict.recordId, local = next.records.find(record => record.id === id);
      if (choice === 'cloud') next.records = [...next.records.filter(record => record.id !== id), ...(remote ? [clone(remote)] : [])];
      else if (local) {
        const revision = remote && remote.revision || 0;
        const input = { id: local.id, value: local.value, unit: local.unit, moment: local.moment, ...(local.afterMinutes === undefined ? {} : { afterMinutes: local.afterMinutes }), measuredAt: local.measuredAt, note: local.note, source: local.source };
        local.revision = revision;
        if (local.deletedAt) { if (remote) operation(next, conflict.entity, 'delete', { id }, revision); }
        else {
          if (remote && remote.deletedAt) operation(next, conflict.entity, 'restore', { id }, revision);
          operation(next, conflict.entity, 'upsert', { record: input }, revision);
        }
      }
    }
    return changed(next, { resolved: true });
  }

  function logout() {
    epoch += 1; authenticated = false; accountKey = null; state = null; status = 'logged-out'; error = null; storageLocked = false; emit();
    return { ok: true, data: null };
  }

  return { login, sync, getSnapshot, subscribe, saveRecord, deleteRecord: id => setDeleted(id, true), restoreRecord: id => setDeleted(id, false), setTarget, removeTarget, setLargeType, resolveConflict, logout };
}

module.exports = { createClient, contextKey, CACHE_VERSION };
