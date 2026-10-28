const D = require('../../utils/domain');
const contexts = ['fasting', 'before', 'after', 'bedtime', 'other'];
const contextLabels = ['空腹', '餐前', '餐后2小时', '睡前', '其他 / 不确定'];
const units = ['mmol/L', 'mg/dL'];
const intervals = ['不确定', '1小时', '2小时', '3小时'];
const intervalValues = [null, 60, 120, 180];
const pad = value => String(value).padStart(2, '0');
const uid = () => `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
const n = value => value === null || value === undefined ? '暂无' : String(Math.round(Number(value) * 100) / 100);
const clock = value => { const d = new Date(value); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const dayText = value => { const d = new Date(value); return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`; };
const shortDay = value => { const d = new Date(value); return `${d.getMonth() + 1}/${d.getDate()}`; };
const message = error => typeof error === 'string' ? error : error && error.message || '暂时未能完成，请重试。';
const fresh = source => ({ id: uid(), value: '', unit: source === 'manual' ? 'mmol/L' : '', moment: '', measuredAt: D.toLocalDateTimeInput(), note: '', source: source || 'manual' });
const dateToday = () => D.localDateKey();

Page({
  data: {
    view: 'home', title: '家人血糖本', demo: false, ready: false, authenticated: false,
    largeType: false, configured: false, top: 20, headerHeight: 64, rightSpace: 100, safeBottom: 24,
    keyboardHeight: 0, formFooter: false, showNav: true, connecting: false,
    syncText: '尚未连接', syncTone: '', syncError: '', outboxCount: 0, conflicts: [],
    contextLabels, units, intervals, moments: contexts.map((key, i) => ({ key, label: D.MOMENT_LABELS[key] })),
    days: 7, momentIndex: 0, unitIndex: 0, historyIndex: 0, historyLimit: 50, historyOptions: ['全部时机', ...Object.values(D.MOMENT_LABELS)], historyDate: '',
    latest: null, todayRecords: [], historyRecords: [], trashRecords: [], analysisRecords: [], lowRecords: [],
    hasDraft: false, draft: fresh('manual'), draftDate: dateToday(), draftTime: clock(new Date()), draftUnitIndex: 0, afterIndex: 0,
    selectedMoment: '', formError: '', valueFocus: false, noteOpen: false, photoPath: '', ocrMessage: '', ocrRaw: '', cameraOn: false, recognizing: false,
    analysis: { count: 0, daysRecorded: 0, average: null, previousCount: 0, previousDaysRecorded: 0, delta: null },
    analysisTitle: '', currentMean: '暂无', previousMean: '暂无', minimum: '暂无', maximum: '暂无', periodText: '', previousPeriod: '',
    target: null, targetLow: '', targetHigh: '', targetError: '', targetContext: '', targetChanged: false,
    outsideOnly: true, showAllRecords: false, previousOpen: false, previousRecords: [],
    detail: null, detailId: '', detailOrigin: 'records', chartCaption: '', privacyOpen: false, version: '',
  },

  onLoad() {
    const app = getApp(); this._client = app.globalData.client; this._snapshot = this._client.getSnapshot();
    this._demoTargets = {}; this._demoLarge = false; this._demoRecords = this.makeDemo(); this._saveLock = false; this._imageGeneration = 0;
    this.setData({ configured: !!app.globalData.configured, version: app.config.version }); this.updateWindowMetrics();
    this._unsubscribe = this._client.subscribe(snapshot => this.refresh(snapshot));
    this._keyboardHandler = event => this.setData({ keyboardHeight: event.height || 0 });
    wx.onKeyboardHeightChange(this._keyboardHandler);
    this.refresh();
    if (app.globalData.configured) this.connect();
  },
  onReady() { this.drawChart(); },
  onResize() { this.updateWindowMetrics(); this.drawChart(); },
  updateWindowMetrics() {
    const info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const menu = wx.getMenuButtonBoundingClientRect ? wx.getMenuButtonBoundingClientRect() : null;
    this.setData({ top: info.statusBarHeight || 20, headerHeight: (info.statusBarHeight || 20) + 48,
      rightSpace: menu ? Math.max(90, info.windowWidth - menu.left + 10) : 100,
      safeBottom: info.safeArea ? Math.max(12, info.screenHeight - info.safeArea.bottom) : 24 });
  },
  onShow() { if (this._client && this._client.getSnapshot().authenticated) this._client.sync(); },
  onHide() { this.keepDraft(); this._imageGeneration++; this.setData({ cameraOn: false, recognizing: false }); },
  onUnload() { if (this._unsubscribe) this._unsubscribe(); if (this._keyboardHandler && wx.offKeyboardHeightChange) wx.offKeyboardHeightChange(this._keyboardHandler); },

  makeDemo() {
    const now = new Date(), prior = new Date(now); prior.setDate(prior.getDate() - 7);
    return D.activeRecords([...D.buildSeedRecords(now), ...D.buildSeedRecords(prior).map(r => Object.assign({}, r, { value: String(Math.round((Number(r.value) - .3) * 10) / 10) }))]);
  },
  source() { return this.data.demo ? this._demoRecords : (this._snapshot.activeRecords || []); },
  rangeContext() { return { moment: contexts[this.data.momentIndex], unit: units[this.data.unitIndex], ...(this.data.momentIndex === 2 ? { afterMinutes: 120 } : {}) }; },
  decorate(record) {
    const context = this.rangeContext(), targets = this.data.demo ? this._demoTargets : this._snapshot.targets || {}, target = targets[D.targetKey(context)];
    const same = record.moment === context.moment && record.unit === context.unit && (record.moment !== 'after' || record.afterMinutes === 120);
    const rangeStatus = same && target ? Number(record.value) < target.low ? '低于所设范围' : Number(record.value) > target.high ? '高于所设范围' : '在所设范围内' : '';
    return Object.assign({}, record, { contextText: D.momentLabel(record), dayText: dayText(record.measuredAt), timeText: clock(record.measuredAt),
      dateTime: `${dayText(record.measuredAt)} ${clock(record.measuredAt)}`, relativeDate: D.localDateKey(record.measuredAt) === dateToday() ? '今天' : shortDay(record.measuredAt),
      statusText: this.data.demo ? '示例记录' : record.syncStatus === 'synced' ? '已同步' : record.syncStatus === 'conflict' ? '有待处理的版本' : '已存本机，待同步', rangeStatus });
  },
  refresh(snapshot) {
    if (snapshot) this._snapshot = snapshot;
    const s = this._snapshot, demo = this.data.demo;
    const scope = this.currentScope();
    if (this._renderScope !== undefined && this._renderScope !== scope) {
      this._imageGeneration++; this._draftOwner = '';
      this.setData({ view: 'home', title: '家人血糖本', draft: fresh('manual'), detailId: '', detail: null, photoPath: '', ocrRaw: '', ocrMessage: '', cameraOn: false, recognizing: false, formError: '', formFooter: false, showNav: true });
    }
    this._renderScope = scope;
    const records = this.source(), context = this.rangeContext();
    const ranges = demo ? this._demoTargets : s.targets || {}, target = ranges[D.targetKey(context)] || null;
    const summary = D.buildInsights(records, Object.assign({ days: this.data.days, target }, context));
    this._trend = D.getTrendSeries(records, Object.assign({ days: this.data.days }, context));
    const delta = summary.delta === null ? null : Math.round(Math.abs(summary.delta) * 100) / 100;
    const label = contextLabels[this.data.momentIndex];
    const analysisTitle = !summary.count ? `这${this.data.days}天还没有${label}记录` : !summary.canCompare ? '记录还不够，暂时不比较变化' : delta === 0 ? '两段记录的均值相近' : `${label}记录均值比前${this.data.days}天${summary.delta > 0 ? '高' : '低'}${n(delta)} ${context.unit}`;
    const outIds = new Set(summary.below.concat(summary.above).map(r => r.id));
    const list = summary.records.filter(r => !target || !this.data.outsideOnly || outIds.has(r.id));
    const historyRecords = records.filter(r => (!this.data.historyIndex || r.moment === contexts[this.data.historyIndex - 1]) && (!this.data.historyDate || D.localDateKey(r.measuredAt) === this.data.historyDate));
    const statuses = { 'logged-out': '尚未连接微信', connecting: '正在连接微信…', syncing: '正在同步…', synced: '已同步到云端', pending: '已存本机，等待同步', offline: '离线：已存本机，等待联网', conflict: '有记录版本需要确认', error: '已存本机，云同步未完成' };
    this.setData({
      ready: demo || !!s.authenticated, authenticated: !!s.authenticated, largeType: demo ? this._demoLarge : !!s.largeType,
      connecting: s.status === 'connecting', syncText: demo ? '示例模式' : statuses[s.status] || '尚未同步',
      syncTone: !demo && (s.status === 'conflict' || s.status === 'error') ? 'warning' : '', syncError: s.error ? message(s.error) : '',
      outboxCount: s.outboxCount || 0, conflicts: (s.conflicts || []).map(c => Object.assign({}, c, { localText: this.conflictDescription(c.local), cloudText: this.conflictDescription(c.cloud) })),
      latest: records.length ? this.decorate(records[0]) : null,
      todayText: `${new Date().getMonth() + 1}月${new Date().getDate()}日 星期${'日一二三四五六'[new Date().getDay()]}`,
      todayRecords: records.filter(r => D.localDateKey(r.measuredAt) === dateToday()).map(r => this.decorate(r)),
      historyRecords: historyRecords.slice(0, this.data.historyLimit).map(r => this.decorate(r)), historyTotal: historyRecords.length,
      trashRecords: demo ? [] : (s.records || []).filter(r => r.deletedAt).map(r => this.decorate(r)),
      detail: this.data.detailId ? (demo ? records : s.records || []).filter(r => r.id === this.data.detailId).map(r => this.decorate(r))[0] || null : null,
      analysis: summary, analysisTitle, currentMean: n(summary.average), previousMean: n(summary.previousAverage), minimum: n(summary.minimum), maximum: n(summary.maximum),
      periodText: `${shortDay(summary.currentRange.startDate + 'T12:00:00')} – ${shortDay(summary.currentRange.endDate + 'T12:00:00')}`,
      previousPeriod: `${shortDay(summary.previousRange.startDate + 'T12:00:00')} – ${shortDay(summary.previousRange.endDate + 'T12:00:00')}`,
      lowRecords: D.findLowReadings(records, { days: this.data.days }).map(r => this.decorate(r)),
      analysisRecords: list.slice(0, this.data.showAllRecords ? undefined : 5).map(r => this.decorate(r)), analysisRecordCount: list.length,
      previousRecords: summary.previousRecords.map(r => this.decorate(r)),
      target: target ? Object.assign({}, target, { updatedText: `${dayText(target.updatedAt)} ${clock(target.updatedAt)}` }) : null,
      contextLabel: label, unitLabel: context.unit, chartCaption: `${this.data.days}天 · 点选查看`,
      hasDraft: this.hasSavedDraft(),
    }, () => this.drawChart());
  },
  conflictDescription(value) {
    if (!value) return '该版本中没有这条记录';
    if (value.record) value = value.record;
    if (value.value) return `${value.value} ${value.unit || ''} · ${value.deletedAt ? '已删除' : D.momentLabel(value)} · ${value.measuredAt ? dayText(value.measuredAt) + ' ' + clock(value.measuredAt) : ''}${value.note ? ' · ' + value.note : ''}`;
    if (typeof value.largeType === 'boolean') return value.largeType ? '更大字号开启' : '更大字号关闭';
    const ranges = value.ranges || value;
    const text = Object.keys(ranges).filter(key => ranges[key] && typeof ranges[key].low !== 'undefined').map(key => {
      const parts = key.split(':'), range = ranges[key];
      const label = D.MOMENT_LABELS[parts[0]] || parts[0];
      return `${label}${parts[0] === 'after' && parts[2] ? '（' + parts[2] + '分钟）' : ''}：${range.low}–${range.high} ${range.unit || parts[1] || ''}`;
    });
    return text.length ? text.join('；') : '未设置个人范围';
  },
  go(view) {
    this._imageGeneration++; wx.hideKeyboard();
    const titles = { home: '家人血糖本', capture: '拍照录入', review: '核对并保存', analysis: '近期分析', records: '全部记录', detail: '记录详情', mine: '我的血糖本', trash: '最近删除', target: `${contextLabels[this.data.momentIndex]}的范围`, conflicts: '确认记录版本', privacy: '数据与隐私说明' };
    this.setData({ view, title: titles[view] || '家人血糖本', cameraOn: false, recognizing: false, keyboardHeight: 0, formError: '', targetError: '', formScrollTo: 'screen-top', formFooter: view === 'review' || view === 'target', showNav: !['capture', 'review', 'target'].includes(view) }, () => { this.refresh(); wx.nextTick(() => this.setData({ formScrollTo: '' })); });
  },
  toHome() { if (this.keepDraft() !== false) this.go('home'); },
  toAnalysis() { if (this.keepDraft() !== false) this.go('analysis'); },
  toMine() { if (this.keepDraft() !== false) this.go('mine'); },
  toRecords() { this.go('records'); },
  toTrash() { this.go('trash'); },
  toConflicts() { this.go('conflicts'); },
  toPrivacy() { this._privacyOrigin = this.data.view; this.go('privacy'); },
  async connect() {
    if (!getApp().globalData.configured) { this.setData({ syncError: '小程序正在准备云端连接，暂时还不能保存个人记录。你可以先查看功能示例。' }); return; }
    this.setData({ demo: false, syncError: '' });
    try { await this._client.login(); this.refresh(); } catch (_) { this.setData({ syncError: '暂时未能连接，请检查网络后重试。已有的本机记录会保留。' }); }
  },
  showDemo() { this.setData({ demo: true, outsideOnly: true }); this.go('home'); },
  async retrySync() { if (!this.data.authenticated) return this.connect(); await this._client.sync(); this.refresh(); },
  leaveDemo() { this.setData({ demo: false }); this.go('home'); if (getApp().globalData.configured) this.connect(); },
  async logout() {
    const token = this.interactionToken();
    const answer = await wx.showModal({ title: '退出本次登录？', content: this.data.outboxCount ? '还有待同步内容。退出后会隐藏记录，本机内容保留，重新验证同一个微信后再续传。' : '退出后隐藏个人记录，再次进入会验证当前微信身份。', confirmText: '退出登录' });
    if (!this.isCurrentInteraction(token) || !answer.confirm || this.keepDraft() === false) return; this._client.logout(); this.setData({ demo: false, detailId: '' }); this.go('home');
  },
  changeDays(e) { this.setData({ days: Number(e.currentTarget.dataset.days), showAllRecords: false, previousOpen: false }); this.refresh(); },
  changeMoment(e) { this.setData({ momentIndex: Number(e.detail.value), showAllRecords: false, previousOpen: false, outsideOnly: true }); this.refresh(); },
  changeUnit(e) { this.setData({ unitIndex: Number(e.detail.value), showAllRecords: false, previousOpen: false, outsideOnly: true }); this.refresh(); },
  changeHistory(e) { this.setData({ historyIndex: Number(e.detail.value), historyLimit: 50 }); this.refresh(); },
  changeHistoryDate(e) { this.setData({ historyDate: e.detail.value, historyLimit: 50 }); this.refresh(); },
  clearHistory() { this.setData({ historyIndex: 0, historyDate: '', historyLimit: 50 }); this.refresh(); },
  moreHistory() { this.setData({ historyLimit: this.data.historyLimit + 50 }); this.refresh(); },
  showOutside() { this.setData({ outsideOnly: true, showAllRecords: false }); this.refresh(); },
  showEveryRecord() { this.setData({ outsideOnly: false, showAllRecords: false }); this.refresh(); },
  moreRecords() { this.setData({ showAllRecords: !this.data.showAllRecords }); this.refresh(); },
  togglePrevious() { this.setData({ previousOpen: !this.data.previousOpen }); },
  openRecord(e) { const id = e.currentTarget.dataset.id; this.setData({ detailId: id, detailOrigin: this.data.view }); this.go('detail'); },
  back() {
    const token = this.interactionToken();
    if (this.data.view === 'review' && this.dirtyDraft()) {
      wx.showModal({ title: '保留这次填写吗？', content: '保留后，可以从首页继续填写。', confirmText: '保留并返回', cancelText: '继续填写', success: result => { if (this.isCurrentInteraction(token) && result.confirm && this.keepDraft() !== false) this.go('home'); } }); return;
    }
    if (this.data.view === 'target' && this.data.targetChanged) {
      wx.showModal({ title: '暂不保存范围？', content: '这次修改还没有保存。', confirmText: '暂不保存', cancelText: '继续填写', success: result => { if (this.isCurrentInteraction(token) && result.confirm) this.go('analysis'); } }); return;
    }
    this.go(this.data.view === 'detail' ? this.data.detailOrigin : this.data.view === 'trash' ? 'mine' : this.data.view === 'target' ? 'analysis' : this.data.view === 'privacy' ? this._privacyOrigin || 'mine' : 'home');
  },
  currentScope() { return this.data.demo ? 'demo' : this._snapshot.authenticated && this._snapshot.accountKey ? `${getApp().config.cloudEnv}:${this._snapshot.accountKey}` : ''; },
  interactionToken() { return { scope: this.currentScope(), account: this._snapshot.accountKey, generation: this._imageGeneration }; },
  isCurrentInteraction(token) { return !!token && token.scope === this.currentScope() && token.account === this._snapshot.accountKey && token.generation === this._imageGeneration; },
  draftKey() { return this._snapshot.authenticated && this._snapshot.accountKey ? `family-glucose:draft:${getApp().config.cloudEnv}:${this._snapshot.accountKey}` : ''; },
  dirtyDraft() { const d = this.data.draft; return !!(d.value || d.moment || d.note || this.data.photoPath); },
  readDraft() { if (this.data.demo) return this._demoDraft || null; const key = this.draftKey(); if (!key) return null; if (this._draftMemory && this._draftMemory[key]) return this._draftMemory[key]; try { return wx.getStorageSync(key) || null; } catch (_) { return null; } },
  hasSavedDraft() { return !!this.readDraft(); },
  keepDraft() {
    if (this.data.view !== 'review' || !this.dirtyDraft() || !this._draftOwner || this._draftOwner !== this.currentScope()) return true;
    const draft = Object.assign({}, this.data.draft);
    if (this.data.demo) { this._demoDraft = draft; return true; }
    const key = this.draftKey(); if (!key) return false;
    if (!this._draftMemory) this._draftMemory = {}; this._draftMemory[key] = draft;
    try { wx.setStorageSync(key, draft); return true; } catch (_) { this.setData({ formError: '草稿暂时未能保存，请保留当前页面并重试。' }); return false; }
  },
  clearDraft() { if (this.data.demo) { this._demoDraft = null; this.setData({ hasDraft: false }); return; } if (this._draftOwner && this._draftOwner !== this.currentScope()) return; const key = this.draftKey(); if (key) { if (this._draftMemory) delete this._draftMemory[key]; try { wx.removeStorageSync(key); } catch (_) {} } this.setData({ hasDraft: false }); },
  applyDraft(draft, photo) {
    this._draftOwner = this.currentScope();
    const local = D.toLocalDateTimeInput(draft.measuredAt), afterIndex = Math.max(0, intervalValues.indexOf(draft.afterMinutes || null));
    this.setData({ draft, draftDate: local.slice(0, 10), draftTime: local.slice(11, 16), selectedMoment: draft.moment, draftUnitIndex: draft.unit ? units.indexOf(draft.unit) : -1,
      afterIndex, photoPath: photo || '', noteOpen: !!draft.note, ocrMessage: '', ocrRaw: '' });
    this.go('review');
  },
  startRecord() {
    if (!this.data.ready) return this.connect();
    const saved = this.readDraft();
    if (saved && typeof saved.value === 'string' && saved.id) { this.applyDraft(saved); wx.showToast({ title: '已继续上次填写', icon: 'none' }); return; }
    this._draftOwner = this.currentScope();
    this.setData({ draft: fresh('photo'), photoPath: '', ocrMessage: '', ocrRaw: '' }); this.go('capture');
  },
  manual() { const draft = Object.assign({}, this.data.draft, { source: 'manual', unit: this.data.draft.unit || 'mmol/L' }); this.applyDraft(draft); },
  editRecord() {
    if (!this.data.detail) return;
    const token = this.interactionToken(), detail = Object.assign({}, this.data.detail);
    const saved = this.readDraft();
    if (saved && saved.id === detail.id) { this.applyDraft(saved); return; }
    if (saved) { wx.showModal({ title: '还有一条未保存内容', content: '继续草稿，或放弃草稿后修改当前记录。', confirmText: '继续草稿', cancelText: '修改当前', success: result => { if (!this.isCurrentInteraction(token)) return; if (result.confirm) this.startRecord(); else { this.clearDraft(); this.applyDraft(detail); } } }); return; }
    this.applyDraft(detail);
  },
  draftInput(e) { const field = e.currentTarget.dataset.field; if (!['value', 'note'].includes(field)) return; this.setData({ [`draft.${field}`]: e.detail.value, formError: '' }); this.keepDraft(); },
  changeDraftUnit(e) { const index = Number(e.detail.value); this.setData({ 'draft.unit': units[index], draftUnitIndex: index, formError: '' }); this.keepDraft(); },
  chooseMoment(e) { const moment = e.currentTarget.dataset.moment; this.setData({ 'draft.moment': moment, 'draft.afterMinutes': null, selectedMoment: moment, afterIndex: 0, formError: '' }); this.keepDraft(); },
  changeAfter(e) { const index = Number(e.detail.value); this.setData({ afterIndex: index, 'draft.afterMinutes': intervalValues[index], formError: '' }); this.keepDraft(); },
  changeDate(e) { this.setData({ draftDate: e.detail.value, 'draft.measuredAt': `${e.detail.value}T${this.data.draftTime}`, formError: '' }); this.keepDraft(); },
  changeTime(e) { this.setData({ draftTime: e.detail.value, 'draft.measuredAt': `${this.data.draftDate}T${e.detail.value}`, formError: '' }); this.keepDraft(); },
  focusField(e) { this.setData({ formScrollTo: e.currentTarget.dataset.scroll || '' }); },
  toggleNote() { this.setData({ noteOpen: !this.data.noteOpen }); },
  async discardDraft() { const token = this.interactionToken(); const answer = await wx.showModal({ title: '放弃这次填写？', content: '已保存的记录不会受到影响。', confirmText: '放弃填写' }); if (this.isCurrentInteraction(token) && answer.confirm) { this.clearDraft(); this.setData({ draft: fresh('manual'), photoPath: '' }); this.go('home'); } },
  async saveRecord() {
    if (this._saveLock) return;
    if (!this._draftOwner || this._draftOwner !== this.currentScope()) { this.setData({ formError: '微信身份已变化，请返回首页后重新填写。' }); return; }
    const token = this.interactionToken();
    this._saveLock = true; wx.hideKeyboard();
    const input = Object.assign({}, this.data.draft); if (input.afterMinutes === null) delete input.afterMinutes;
    const checked = D.validateRecordInput(input);
    if (!checked.ok) { this._saveLock = false; this.setData({ formError: checked.error, valueFocus: !input.value, formScrollTo: !input.value || !input.unit ? 'value-field' : !input.moment ? 'moment-field' : 'time-field' }); return; }
    if (this.data.demo) { this.clearDraft(); this._saveLock = false; this.setData({ draft: fresh('manual'), photoPath: '' }); this.go('home'); wx.showToast({ title: '示例完成，未保存个人数据', icon: 'none' }); return; }
    try {
      const result = await this._client.saveRecord(Object.assign({ id: input.id }, checked.data));
      if (!this.isCurrentInteraction(token)) return;
      if (!result.ok) { this.setData({ formError: message(result.error) }); return; }
      this.clearDraft(); this.setData({ draft: fresh('manual'), photoPath: '' }); this.go('home'); wx.showToast({ title: '已存本机，正在同步', icon: 'none' });
    } finally { this._saveLock = false; }
  },
  async removeRecord() {
    if (this.data.demo || !this.data.detail) return;
    const token = this.interactionToken(), id = this.data.detail.id;
    const result = await wx.showModal({ title: '移至最近删除？', content: '删除后可以恢复，删除操作也会同步到自己的其他设备。', confirmText: '移至删除' });
    if (!this.isCurrentInteraction(token) || !result.confirm) return; const removed = await this._client.deleteRecord(id);
    if (!this.isCurrentInteraction(token)) return;
    if (!removed.ok) return wx.showToast({ title: message(removed.error), icon: 'none' }); this.go('records');
  },
  async restoreRecord(e) { const token = this.interactionToken(); const restored = await this._client.restoreRecord(e.currentTarget.dataset.id); if (!this.isCurrentInteraction(token)) return; if (!restored.ok) return wx.showToast({ title: message(restored.error), icon: 'none' }); this.refresh(); wx.showToast({ title: '已恢复，正在同步', icon: 'none' }); },

  async ensurePrivacy() {
    if (!wx.getPrivacySetting || !wx.requirePrivacyAuthorize) return;
    const setting = await wx.getPrivacySetting(); if (setting.needAuthorization) await wx.requirePrivacyAuthorize();
  },
  async chooseAlbum() {
    const generation = this._imageGeneration, scope = this.currentScope(), account = this._snapshot.accountKey;
    const valid = () => generation === this._imageGeneration && scope === this.currentScope() && account === this._snapshot.accountKey;
    try { await this.ensurePrivacy(); if (!valid()) return; const result = await wx.chooseMedia({ count: 1, mediaType: ['image'], sourceType: ['album'], sizeType: ['compressed'] }); if (!valid()) return; if (result.tempFiles && result.tempFiles[0]) this.recognizePhoto(result.tempFiles[0].tempFilePath); }
    catch (_) { if (valid()) this.setData({ ocrMessage: '没有选择照片。也可以手动输入。' }); }
  },
  async shutter() {
    if (this.data.recognizing) return;
    const generation = this._imageGeneration, scope = this.currentScope(), account = this._snapshot.accountKey;
    const valid = () => generation === this._imageGeneration && scope === this.currentScope() && account === this._snapshot.accountKey;
    if (!this.data.cameraOn) { try { await this.ensurePrivacy(); if (valid()) this.setData({ cameraOn: true, ocrMessage: '' }); } catch (_) { if (valid()) this.setData({ ocrMessage: '相机尚未授权，可从相册选择或手动输入。' }); } return; }
    wx.createCameraContext().takePhoto({ quality: 'high', success: result => { if (valid()) this.recognizePhoto(result.tempImagePath); }, fail: () => { if (valid()) this.setData({ ocrMessage: '相机暂不可用，可从相册选择或手动输入。' }); } });
  },
  cameraError() { this.setData({ cameraOn: false, ocrMessage: '暂时无法打开相机，可以从相册选择，或手动输入。' }); },
  readBase64(filePath) { return new Promise((resolve, reject) => wx.getFileSystemManager().readFile({ filePath, encoding: 'base64', success: result => resolve(result.data), fail: reject })); },
  async recognizePhoto(path) {
    const generation = ++this._imageGeneration, scope = this.currentScope(), account = this._snapshot.accountKey;
    const valid = () => generation === this._imageGeneration && scope === this.currentScope() && account === this._snapshot.accountKey;
    this.setData({ recognizing: true, photoPath: path, cameraOn: false, ocrMessage: '正在识别照片…' });
    let imagePath = path;
    try {
      if (wx.compressImage) { try { const compressed = await wx.compressImage({ src: imagePath, quality: 65 }); imagePath = compressed.tempFilePath; } catch (_) {} }
      if (!valid()) return;
      const base64 = await this.readBase64(imagePath);
      if (!valid()) return;
      if (base64.length > 4 * 1024 * 1024) throw new Error('照片较大，请裁剪血糖仪屏幕后重试，或对照照片手动输入。');
      if (this.data.demo || !this._snapshot.authenticated || !getApp().globalData.configured) throw new Error('照片识别还在准备，可以先对照照片手动填写。');
      const response = await wx.cloud.callFunction({ name: getApp().config.ocrFunctionName, data: { expectedAccountId: account, image: `data:image/jpeg;base64,${base64}` } });
      if (!valid()) return;
      const result = response.result;
      if (result && !result.ok && result.error && result.error.code === 'ACCOUNT_CHANGED') { this.setData({ ocrMessage: '微信身份已变化，正在重新连接。请在自己的账号中重新选择照片。' }); await this._client.login(); return; }
      if (!result || !result.ok) throw new Error(result && result.error && result.error.code === 'OCR_NOT_CONFIGURED' ? '照片识别暂未开启，请对照照片手动填写。' : '暂未能识别，请对照照片手动填写。');
      const reading = result.data, draft = Object.assign({}, this.data.draft, { source: 'photo', value: reading.value || '', unit: reading.unit || '' });
      this.applyDraft(draft, path); this.setData({ ocrRaw: reading.rawText || '', ocrMessage: reading.special ? `仪器显示${reading.special}，请核对原图，不要记成数字。` : reading.warning || '已识别，请核对数值、小数点和单位。' });
    } catch (error) {
      if (!valid()) return;
      this.applyDraft(Object.assign({}, this.data.draft, { source: 'photo', value: '', unit: '' }), path); this.setData({ ocrMessage: message(error) });
    } finally { if (valid()) this.setData({ recognizing: false }); }
  },
  retake() { if (this.keepDraft() !== false) this.go('capture'); },

  openTarget() { const context = this.rangeContext(), targets = this.data.demo ? this._demoTargets : this._snapshot.targets || {}, target = targets[D.targetKey(context)]; this.setData({ targetLow: target ? String(target.low) : '', targetHigh: target ? String(target.high) : '', targetContext: contextLabels[this.data.momentIndex], targetChanged: false }); this.go('target'); },
  targetInput(e) { const field = e.currentTarget.dataset.field; this.setData({ [field === 'low' ? 'targetLow' : 'targetHigh']: e.detail.value, targetChanged: true, targetError: '' }); },
  async saveTarget() {
    if (this._saveLock) return; this._saveLock = true;
    const token = this.interactionToken();
    try {
      const context = this.rangeContext(), range = { low: this.data.targetLow, high: this.data.targetHigh, unit: context.unit }, checked = D.validateTargetRange(range);
      if (!checked.ok) return this.setData({ targetError: checked.error });
      if (this.data.demo) this._demoTargets[D.targetKey(context)] = checked.data;
      else { const result = await this._client.setTarget(context, range); if (!this.isCurrentInteraction(token)) return; if (!result.ok) return this.setData({ targetError: message(result.error) }); }
      this.setData({ targetChanged: false }); this.go('analysis'); wx.showToast({ title: this.data.demo ? '已应用到示例' : '范围已存本机，正在同步', icon: 'none' });
    } finally { this._saveLock = false; }
  },
  async clearTarget() { const token = this.interactionToken(), context = this.rangeContext(); if (this.data.demo) delete this._demoTargets[D.targetKey(context)]; else { const result = await this._client.removeTarget(context); if (!this.isCurrentInteraction(token)) return; if (!result.ok) return this.setData({ targetError: message(result.error) }); } this.setData({ targetChanged: false }); this.go('analysis'); },
  async toggleLarge() { const token = this.interactionToken(); if (this.data.demo) this._demoLarge = !this._demoLarge; else { const result = await this._client.setLargeType(!this.data.largeType); if (!this.isCurrentInteraction(token)) return; if (!result.ok) return wx.showToast({ title: message(result.error), icon: 'none' }); } this.refresh(); },
  async resolveVersion(e) {
    const id = e.currentTarget.dataset.id, choice = e.currentTarget.dataset.choice;
    const token = this.interactionToken();
    const answer = await wx.showModal({ title: choice === 'local' ? '保留手机上的版本？' : '采用云端的版本？', content: choice === 'local' ? '将保留手机内容，并以它重新尝试云端保存。' : '手机上的这次修改将由云端版本替换。', confirmText: '确认选择' });
    if (!this.isCurrentInteraction(token) || !answer.confirm) return; const result = await this._client.resolveConflict(id, choice); if (!this.isCurrentInteraction(token)) return; if (!result.ok) wx.showToast({ title: message(result.error), icon: 'none' }); this.refresh();
  },
  async exportRecords() {
    if (this.data.demo) return wx.showToast({ title: '示例不导出为个人记录', icon: 'none' });
    if (!this._snapshot.authenticated) return wx.showToast({ title: '请先连接自己的微信记录', icon: 'none' });
    const token = this.interactionToken(), records = this._snapshot.activeRecords || [], name = `血糖记录-${dateToday()}.csv`, path = `${wx.env.USER_DATA_PATH}/glucose-export-${uid()}.csv`;
    try { await new Promise((resolve, reject) => wx.getFileSystemManager().writeFile({ filePath: path, data: D.recordsToCsv(records), encoding: 'utf8', success: resolve, fail: reject })); if (!this.isCurrentInteraction(token)) return; await wx.shareFileMessage({ filePath: path, fileName: name }); }
    catch (_) { if (this.isCurrentInteraction(token)) wx.showToast({ title: '没有转存文件，可稍后重试', icon: 'none' }); }
  },
  openPrivacyContract() { if (wx.openPrivacyContract) wx.openPrivacyContract({ fail: () => wx.showToast({ title: '隐私说明还在准备，请稍后重试', icon: 'none' }) }); },
  agreePrivacy() { const app = getApp(); if (app._privacyResolve) { app._privacyResolve({ event: 'agree', buttonId: 'privacy-agree' }); app._privacyResolve = null; } this.setData({ privacyOpen: false }); },
  declinePrivacy() { const app = getApp(); if (app._privacyResolve) { app._privacyResolve({ event: 'disagree' }); app._privacyResolve = null; } this.setData({ privacyOpen: false }); },

  drawChart() {
    const generation = this._chartGeneration = (this._chartGeneration || 0) + 1;
    this._chartGeometry = null;
    if (this.data.chartImage) this.setData({ chartImage: '' });
    if (!this._trend || !['home', 'analysis'].includes(this.data.view) || !this.data.ready || typeof wx.canvasToTempFilePath !== 'function' || typeof wx.createSelectorQuery !== 'function') return;
    const trend = this._trend, scope = this.currentScope(), view = this.data.view, lifecycle = this._imageGeneration;
    const days = this.data.days, unitIndex = this.data.unitIndex, target = view === 'analysis' ? this.data.target : null;
    const current = () => generation === this._chartGeneration && this.currentScope() === scope && this.data.view === view && this.data.ready && this._trend === trend && this._imageGeneration === lifecycle;
    wx.nextTick(() => {
      if (!current()) return;
      const query = wx.createSelectorQuery().in(this);
      query.select('#trend-canvas').fields({ node: true });
      query.select('#trend-picture').boundingClientRect();
      query.exec(results => {
        if (!current()) return;
        const item = results && results[0], picture = results && results[1];
        if (!item || !item.node || !picture || !(picture.width > 0) || !(picture.height > 0)) return;
        const canvas = item.node, context = canvas.getContext('2d'), info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(), ratio = info.pixelRatio || 1;
        const w = picture.width, h = picture.height;
        canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio);
        context.scale(ratio, ratio); context.clearRect(0, 0, w, h);
        const points = trend.days, values = points.filter(d => d.value !== null).map(d => d.value);
        const left = 30, right = 13, top = 22, bottom = h - 28;
        if (!values.length) {
          context.fillStyle = '#53675d'; context.textAlign = 'center'; context.font = '15px sans-serif'; context.fillText('记录几次，再看看变化', w / 2, h / 2);
        } else {
          const scaleValues = target ? values.concat([target.low, target.high]) : values;
          const min = Math.min(...scaleValues), max = Math.max(...scaleValues), step = unitIndex === 0 ? Math.max(1, Math.ceil((max - min) / 3)) : Math.max(10, Math.ceil((max - min) / 30) * 10);
          const minY = Math.max(0, Math.floor(min / step) * step - step), maxY = Math.max(minY + step * 3, Math.ceil(max / step) * step + step);
          const x = i => left + (w - left - right) * i / Math.max(1, points.length - 1), y = v => bottom - (v - minY) / (maxY - minY) * (bottom - top);
          if (target) { context.fillStyle = '#e4f0eb'; context.fillRect(left, y(target.high), w - left - right, y(target.low) - y(target.high)); }
          context.font = '11px sans-serif'; context.lineWidth = 1;
          for (let i = 0; i < 4; i++) { const v = minY + (maxY - minY) * i / 3; context.strokeStyle = '#dde6e1'; context.setLineDash([3, 3]); context.beginPath(); context.moveTo(left, y(v)); context.lineTo(w - right, y(v)); context.stroke(); context.fillStyle = '#65716e'; context.textAlign = 'right'; context.fillText(n(v), left - 7, y(v) + 4); }
          context.setLineDash([]); context.strokeStyle = '#116d61'; context.lineWidth = 2.3; let drawing = false; context.beginPath();
          points.forEach((d, i) => { if (d.value === null) { drawing = false; return; } if (!drawing) context.moveTo(x(i), y(d.value)); else context.lineTo(x(i), y(d.value)); drawing = true; }); context.stroke();
          points.forEach((d, i) => { if (days === 7 || i % 5 === 0 || i === points.length - 1) { context.fillStyle = '#65716e'; context.textAlign = 'center'; context.font = '11px sans-serif'; context.fillText(Number(d.dateKey.slice(-2)), x(i), h - 6); } if (d.value === null) return; context.fillStyle = '#fff'; context.strokeStyle = '#116d61'; context.beginPath(); context.arc(x(i), y(d.value), days === 7 ? 3.5 : 2.7, 0, Math.PI * 2); context.fill(); context.stroke(); if (days === 7) { context.fillStyle = '#116d61'; context.textAlign = 'center'; context.fillText(n(d.value), x(i), y(d.value) - 11); } });
        }
        if (!current()) return;
        const failed = () => { if (current()) { this._chartGeometry = null; this.setData({ chartImage: '', chartCaption: '图表暂时未能显示，可以查看原始记录。' }); } };
        try {
          // Export the whole DPR-sized bitmap. Logical width/height here would
          // crop the physical canvas on devices with a pixel ratio above one.
          wx.canvasToTempFilePath({ canvas, fileType: 'png', success: result => {
            if (!current()) return;
            if (!result || !result.tempFilePath) return failed();
            this._chartGeometry = { left, right, width: w, height: h, generation, scope, view, lifecycle, trend, unit: units[unitIndex] };
            this.setData({ chartImage: result.tempFilePath });
          }, fail: failed }, this);
        } catch (_) { failed(); }
      });
    });
  },
  selectChart(e) {
    const g = this._chartGeometry, touch = e.changedTouches && e.changedTouches[0];
    if (!g || !touch || !g.trend.days.length || typeof wx.createSelectorQuery !== 'function') return;
    const clientX = Number.isFinite(touch.clientX) ? touch.clientX : Number.isFinite(touch.pageX) ? touch.pageX : null;
    if (clientX === null) return;
    const current = () => g === this._chartGeometry && g.generation === this._chartGeneration && g.scope === this.currentScope() && g.view === this.data.view && g.lifecycle === this._imageGeneration && g.trend === this._trend && this.data.ready;
    if (!current()) return;
    wx.createSelectorQuery().in(this).select('#trend-picture').boundingClientRect().exec(results => {
      const rect = results && results[0];
      if (!current() || !rect || !(rect.width > 0) || !(rect.height > 0)) return;
      // Touch coordinates on image are viewport/page coordinates. Account for
      // image aspectFit letterboxing if its layout changed after rendering.
      const scale = Math.min(rect.width / g.width, rect.height / g.height);
      const pictureLeft = rect.left + (rect.width - g.width * scale) / 2;
      const localX = (clientX - pictureLeft) / scale;
      const index = Math.max(0, Math.min(g.trend.days.length - 1, Math.round((localX - g.left) / (g.width - g.left - g.right) * (g.trend.days.length - 1))));
      const point = g.trend.days[index];
      this.setData({ chartCaption: point.value === null ? `${point.label} 没有记录` : `${point.label}：${n(point.value)} ${g.unit}${point.count > 1 ? `（${point.count}次日均）` : ''}` });
    });
  },
});
