'use strict';

const { createHash } = require('node:crypto');
const COLLECTIONS = Object.freeze({ accounts: 'glucose_accounts', records: 'glucose_records', operations: 'glucose_operations' });
const UNITS = ['mmol/L', 'mg/dL'];
const MOMENTS = ['fasting', 'before', 'after', 'bedtime', 'other'];
const clone = value => JSON.parse(JSON.stringify(value));
const hash = text => createHash('sha256').update(text).digest('hex');
const accountKey = context => hash(`glucose-account-v1\0${context.APPID}\0${context.OPENID}`);
const documentId = (owner, type, id) => hash(`glucose-v1\0${owner}\0${type}\0${id}`);

class ServiceError extends Error {
  constructor(code, message, details) { super(message); this.code = code; this.details = details; }
}
const fail = (code, message, details) => { throw new ServiceError(code, message, details); };
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('VALIDATION', `${label}格式无效。`);
  return value;
}
function fields(value, allowed, label) {
  object(value, label);
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) fail('VALIDATION', `${label}包含不允许的字段，请更新小程序后重试。`, {
    fields: unexpected.slice(0, 10).map(key => key.slice(0, 64)),
  });
}
function identifier(value, label, max = 80) {
  if (typeof value !== 'string' || value.length < 8 || value.length > max || !/^[A-Za-z0-9_-]+$/.test(value)) fail('VALIDATION', `${label}无效。`);
  return value;
}
function revision(value, label = '记录版本') {
  if (!Number.isSafeInteger(value) || value < 0) fail('VALIDATION', `${label}无效，请刷新后重试。`);
  return value;
}
function numeric(value, label) {
  if (!['string', 'number'].includes(typeof value)) fail('VALIDATION', `${label}应为大于0的数值。`);
  const text = String(value).trim().replace(/[０-９]/g, c => String(c.charCodeAt(0) - 0xff10)).replace(/[．，,]/g, '.');
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(text) || Number(text) <= 0) fail('VALIDATION', `${label}应大于0，最多保留两位小数。`);
  return text.replace(/^0+(?=\d)/, '');
}
function instant(value, now) {
  if (typeof value !== 'string') fail('VALIDATION', '请填写有效的测量时间。');
  // Require an explicit offset: never interpret a phone-local input in the cloud's timezone.
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) fail('VALIDATION', '测量时间需要包含时区，请重新选择时间。');
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  const calendar = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || calendar.getUTCFullYear() !== y || calendar.getUTCMonth() !== m - 1 || calendar.getUTCDate() !== d || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) fail('VALIDATION', '测量日期或时间无效。');
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 || (Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0))) fail('VALIDATION', '测量时间的时区无效。');
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.getTime() > now.getTime() + 5 * 60_000) fail('VALIDATION', '测量时间晚于现在或格式无效，请核对。');
  return parsed.toISOString();
}
function contextKey(input) {
  fields(input, ['moment', 'unit', 'afterMinutes'], '测量时机');
  if (!MOMENTS.includes(input.moment) || !UNITS.includes(input.unit)) fail('VALIDATION', '测量时机或血糖单位无效。');
  if (input.moment !== 'after') {
    if (input.afterMinutes !== undefined) fail('VALIDATION', '只有餐后记录可以填写餐后间隔。');
    return `${input.moment}:${input.unit}`;
  }
  const minutes = input.afterMinutes === undefined ? 120 : input.afterMinutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) fail('VALIDATION', '餐后间隔应为1至1440分钟。');
  return `after:${minutes}:${input.unit}`;
}
function recordInput(input, now) {
  fields(input, ['id', 'value', 'unit', 'moment', 'afterMinutes', 'measuredAt', 'note', 'source'], '血糖记录');
  const id = identifier(input.id, '记录编号');
  if (/^demo[-_]/i.test(id)) fail('VALIDATION', '示例记录不能上传为个人测量。');
  if (typeof input.value !== 'string') fail('VALIDATION', '血糖数值必须保留为原始数字文本。');
  const value = numeric(input.value, '血糖数值');
  if (!UNITS.includes(input.unit) || !MOMENTS.includes(input.moment)) fail('VALIDATION', '请核对血糖单位和测量时机。');
  if (input.afterMinutes !== undefined && (input.moment !== 'after' || !Number.isInteger(input.afterMinutes) || input.afterMinutes < 1 || input.afterMinutes > 1440)) fail('VALIDATION', '餐后间隔无效。');
  if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2000)) fail('VALIDATION', '备注应为2000字以内的文字。');
  if (input.source !== undefined && !['manual', 'photo'].includes(input.source)) fail('VALIDATION', '记录来源无效。');
  return { id, value, unit: input.unit, moment: input.moment, ...(input.afterMinutes === undefined ? {} : { afterMinutes: input.afterMinutes }), measuredAt: instant(input.measuredAt, now), note: (input.note || '').trim(), source: input.source || 'manual' };
}
function targetInput(input, context, now) {
  fields(input, ['low', 'high', 'unit'], '个人范围');
  const low = Number(numeric(input.low, '下限')), high = Number(numeric(input.high, '上限'));
  if (low >= high) fail('VALIDATION', '个人范围下限需要小于上限。');
  if (!UNITS.includes(input.unit) || input.unit !== context.unit) fail('VALIDATION', '个人范围单位与当前测量时机不一致。');
  return { low, high, unit: input.unit, updatedAt: now.toISOString() };
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function verifyOwner(document, owner) {
  if (document && document.ownerKey !== owner) fail('INTERNAL', '数据归属校验未通过，请稍后重试。');
  return document;
}
function publicRecord(document) {
  const { ownerKey: _owner, _id: _id, ...record } = document;
  return clone(record);
}
const targetView = account => ({ ranges: clone(account.targets.ranges), revision: account.targets.revision });
const preferenceView = account => ({ largeType: account.preferences.largeType, revision: account.preferences.revision });

function createService({ repository, clock = () => new Date(), allowedAppId = '' }) {
  if (!repository || typeof repository.runTransaction !== 'function') throw new TypeError('A transactional repository is required');
  async function ensureAccount(tx, owner, now) {
    const current = verifyOwner(await tx.getAccount(owner), owner);
    if (current) return current;
    const account = { ownerKey: owner, syncVersion: 0, targets: { ranges: {}, revision: 0 }, preferences: { largeType: false, revision: 0 }, createdAt: now.toISOString(), updatedAt: now.toISOString() };
    await tx.putAccount(owner, account);
    return account;
  }
  async function readAccount(owner, now) { return repository.runTransaction(tx => ensureAccount(tx, owner, now)); }
  async function mutate(owner, request, now, apply) {
    const opId = identifier(request.opId, '操作编号', 100), fingerprint = hash(canonical(request));
    const opDocId = documentId(owner, 'operation', opId);
    return repository.runTransaction(async tx => {
      const operation = verifyOwner(await tx.getOperation(opDocId), owner);
      if (operation) {
        if (operation.fingerprint !== fingerprint) fail('OPERATION_REUSED', '这个操作编号已用于其他内容，请保留草稿并重试。');
        return clone(operation.response);
      }
      const account = verifyOwner(await tx.getAccount(owner), owner) || { ownerKey: owner, syncVersion: 0, targets: { ranges: {}, revision: 0 }, preferences: { largeType: false, revision: 0 }, createdAt: now.toISOString(), updatedAt: now.toISOString() };
      if (account.syncVersion >= Number.MAX_SAFE_INTEGER - 1) fail('LIMIT', '同步版本超出可用范围，请联系维护者。');
      const seq = account.syncVersion + 1;
      // apply performs all reads before its first write. No clock/client value is an auth input.
      const response = await apply(tx, account, seq);
      account.syncVersion = seq;
      account.updatedAt = now.toISOString();
      await tx.putAccount(owner, account);
      await tx.putOperation(opDocId, { ownerKey: owner, fingerprint, response, createdAt: now.toISOString() });
      return response;
    });
  }
  return async function handle(rawEvent, trustedContext) {
    try {
      const now = clock();
      if (!(now instanceof Date) || !Number.isFinite(now.getTime())) fail('INTERNAL', '服务器时间暂不可用。');
      // Context must be obtained by the entry point from cloud.getWXContext(), never event.userInfo.
      if (!trustedContext || typeof trustedContext.OPENID !== 'string' || !trustedContext.OPENID || trustedContext.OPENID.length > 128 || typeof trustedContext.APPID !== 'string' || !/^wx[a-zA-Z0-9]{16}$/.test(trustedContext.APPID)) fail('AUTH_REQUIRED', '请在微信中登录后重试。');
      if (allowedAppId && trustedContext.APPID !== allowedAppId) fail('FORBIDDEN', '当前小程序没有访问此服务的权限。');
      const owner = accountKey(trustedContext);
      object(rawEvent, '请求');
      // WeChat attaches transport metadata. Discard it even if forged; only
      // getWXContext() supplies identity, and business fields stay allowlisted.
      const { userInfo: _untrustedUserInfo, tcbContext: _untrustedCloudContext, ...request } = rawEvent;
      const action = request.action;
      const allowed = {
        bootstrap: ['action'], list: ['action', 'afterVersion', 'uptoVersion', 'cursor', 'limit'], get: ['action', 'id'],
        upsert: ['action', 'opId', 'baseRevision', 'record'], delete: ['action', 'opId', 'baseRevision', 'id'], restore: ['action', 'opId', 'baseRevision', 'id'],
        'targets.get': ['action'], 'targets.set': ['action', 'opId', 'baseRevision', 'context', 'range'], 'targets.remove': ['action', 'opId', 'baseRevision', 'context'],
        'preferences.set': ['action', 'opId', 'baseRevision', 'preferences'],
      };
      if (typeof action !== 'string' || !Object.hasOwn(allowed, action)) fail('VALIDATION', '请求操作无效，请更新小程序后重试。');
      fields(request, action === 'bootstrap' ? allowed[action] : [...allowed[action], 'expectedAccountId'], '请求');
      // This is a scope assertion, never an identity selector. A WeChat account
      // switch between bootstrap and a later call must not mix queues or caches.
      if (action !== 'bootstrap' && request.expectedAccountId !== owner) fail('ACCOUNT_CHANGED', '微信账号身份已变化，原账号的待同步内容已保留，请重新确认登录。');
      let data;
      if (action === 'bootstrap' || action === 'targets.get') {
        const account = await readAccount(owner, now);
        data = action === 'targets.get' ? targetView(account) : { accountId: owner, serverTime: now.toISOString(), syncVersion: account.syncVersion, preferences: preferenceView(account), targets: targetView(account) };
      } else if (action === 'list') {
        const account = await readAccount(owner, now);
        const afterVersion = revision(request.afterVersion === undefined ? 0 : request.afterVersion, '同步起点');
        const watermark = request.uptoVersion === undefined ? account.syncVersion : revision(request.uptoVersion, '同步终点');
        const limit = request.limit === undefined ? 100 : request.limit;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || watermark > account.syncVersion || afterVersion > watermark) fail('VALIDATION', '同步分页范围无效，请重新刷新。');
        if (request.cursor !== undefined && request.cursor !== null && (typeof request.cursor !== 'string' || !/^\d{1,16}$/.test(request.cursor))) fail('VALIDATION', '同步游标无效。');
        const lower = request.cursor === undefined || request.cursor === null ? afterVersion : revision(Number(request.cursor), '同步游标');
        if (lower < afterVersion || lower > watermark) fail('VALIDATION', '同步游标超出范围，请重新刷新。');
        const result = await repository.listRecords(owner, lower, watermark, limit + 1);
        for (const entry of result) verifyOwner(entry, owner);
        const records = result.slice(0, limit).map(publicRecord), hasMore = result.length > limit;
        // A record can be updated beyond a frozen page watermark between requests.
        // Expose the newest version after querying so clients can immediately catch up.
        const latest = await readAccount(owner, now);
        data = { records, watermark, latestVersion: latest.syncVersion, hasMore, nextCursor: hasMore ? String(records[records.length - 1].syncVersion) : null };
      } else if (action === 'get') {
        const id = identifier(request.id, '记录编号');
        const record = verifyOwner(await repository.getRecord(documentId(owner, 'record', id)), owner);
        if (!record || record.id !== id) fail('NOT_FOUND', '没有找到这条记录，请刷新后重试。');
        data = { record: publicRecord(record) };
      } else if (['upsert', 'delete', 'restore'].includes(action)) {
        const baseRevision = revision(request.baseRevision);
        const input = action === 'upsert' ? recordInput(request.record, now) : null;
        const id = input ? input.id : identifier(request.id, '记录编号'), docId = documentId(owner, 'record', id);
        data = await mutate(owner, request, now, async (tx, _account, seq) => {
          const current = verifyOwner(await tx.getRecord(docId), owner);
          if (current && current.id !== id) fail('INTERNAL', '记录编号校验未通过。');
          if (!current && action !== 'upsert') fail('NOT_FOUND', '没有找到这条记录，请刷新后重试。');
          if (baseRevision !== (current ? current.revision : 0)) fail('CONFLICT', '这条记录已在另一设备修改。你的输入已保留，请先核对两个版本。', { current: current ? publicRecord(current) : null });
          if (action === 'upsert' && current && current.deletedAt) fail('DELETED', '这条记录已删除，请先恢复后再修改。', { current: publicRecord(current) });
          if (action === 'restore' && !current.deletedAt) fail('NOT_DELETED', '这条记录未处于删除状态，请刷新。');
          const stamp = now.toISOString();
          let next;
          if (action === 'upsert') next = { ...input, createdAt: current ? current.createdAt : stamp, updatedAt: stamp, revision: baseRevision + 1, syncVersion: seq, ownerKey: owner };
          else {
            next = { ...current, updatedAt: stamp, revision: baseRevision + 1, syncVersion: seq };
            if (action === 'delete') next.deletedAt = stamp;
            else delete next.deletedAt;
          }
          await tx.putRecord(docId, next);
          return { record: publicRecord(next), syncVersion: seq };
        });
      } else if (action === 'targets.set' || action === 'targets.remove') {
        const baseRevision = revision(request.baseRevision, '个人范围版本');
        const key = contextKey(request.context);
        const range = action === 'targets.set' ? targetInput(request.range, request.context, now) : null;
        data = await mutate(owner, request, now, async (_tx, account, seq) => {
          if (baseRevision !== account.targets.revision) fail('CONFLICT', '个人范围已在另一设备修改，请先核对。', { current: targetView(account) });
          const ranges = { ...account.targets.ranges };
          if (range) ranges[key] = range; else delete ranges[key];
          if (Object.keys(ranges).length > 64) fail('LIMIT', '个人范围设置较多，请先取消不再使用的设置。');
          account.targets = { ranges, revision: baseRevision + 1 };
          return { ...targetView(account), syncVersion: seq };
        });
      } else if (action === 'preferences.set') {
        const baseRevision = revision(request.baseRevision, '显示设置版本');
        fields(request.preferences, ['largeType'], '显示设置');
        if (typeof request.preferences.largeType !== 'boolean') fail('VALIDATION', '大字号设置无效。');
        data = await mutate(owner, request, now, async (_tx, account, seq) => {
          if (baseRevision !== account.preferences.revision) fail('CONFLICT', '显示设置已在另一设备修改，请刷新后重试。', { current: preferenceView(account) });
          account.preferences = { largeType: request.preferences.largeType, revision: baseRevision + 1 };
          return { preferences: preferenceView(account), syncVersion: seq };
        });
      }
      return { ok: true, data };
    } catch (error) {
      if (error instanceof ServiceError) return { ok: false, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: clone(error.details) }) } };
      // Do not return SDK errors or log request/context/record data.
      return { ok: false, error: { code: 'INTERNAL', message: '云端暂时无法完成操作，输入已保留，请稍后重试。' } };
    }
  };
}

module.exports = { createService, ServiceError, COLLECTIONS, accountKey, documentId, contextKey, recordInput, targetInput };
