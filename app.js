const STORAGE_SLOT = "blood-glucose-records-v1";
const SETTINGS_KEY = "blood-glucose-settings-v1";

const PERIODS = [
  { id: "morning", label: "早" },
  { id: "noon", label: "中" },
  { id: "evening", label: "晚" }
];

const MEAL_TYPES = [
  { id: "fasting", label: "空腹" },
  { id: "preMeal", label: "餐前" },
  { id: "postMeal", label: "餐后" }
];

const STAT_MODULES = [
  { id: "summary", title: "本周总结" },
  { id: "overview", title: "核心指标" },
  { id: "trend", title: "近7天趋势" },
  { id: "periodAverage", title: "早中晚平均值" },
  { id: "periodAbnormal", title: "异常分布" },
  { id: "mealCompare", title: "餐前/餐后对比" }
];

const DEFAULT_SETTINGS = {
  lowThreshold: 3.9,
  preMealHigh: 6.1,
  postMealHigh: 7.8,
  fontSize: "standard",
  appearance: "system",
  recentCount: 3,
  statsFilter: "all",
  statOrder: STAT_MODULES.map((item) => item.id),
  pinnedStats: ["summary", "trend"]
};

const state = {
  view: "today",
  selectedDate: toDateInputValue(new Date()),
  editingRecordId: null,
  records: loadRecords(),
  settings: loadSettings(),
  toast: "",
  dialog: null,
  recordReturn: null,
  pendingImportRecords: null
};

const app = document.querySelector("#app");

function loadRecords() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_SLOT) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveRecords() {
  localStorage.setItem(STORAGE_SLOT, JSON.stringify(state.records));
}

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
  } catch {
    return normalizeSettings({ ...DEFAULT_SETTINGS });
  }
}

function normalizeSettings(settings) {
  const known = new Set(STAT_MODULES.map((item) => item.id));
  const existingOrder = Array.isArray(settings.statOrder) ? settings.statOrder.filter((id) => known.has(id)) : [];
  const missing = STAT_MODULES.map((item) => item.id).filter((id) => !existingOrder.includes(id));
  return {
    ...settings,
    statOrder: [...existingOrder, ...missing],
    pinnedStats: Array.isArray(settings.pinnedStats) ? settings.pinnedStats.filter((id) => known.has(id)) : []
  };
}

function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
  applySettings();
}

function applySettings() {
  const scale = state.settings.fontSize === "large" ? 1.12 : state.settings.fontSize === "xlarge" ? 1.24 : 1;
  document.documentElement.style.setProperty("--font-scale", String(scale));
  document.documentElement.dataset.theme = state.settings.appearance;
  updateViewportOffset();
}

function updateViewportOffset() {
  const visualHeight = window.visualViewport?.height || window.innerHeight;
  const offset = Math.max(0, window.innerHeight - visualHeight);
  document.documentElement.style.setProperty("--viewport-bottom-offset", `${offset}px`);
}

function rememberRecordReturn() {
  state.recordReturn = {
    view: state.view,
    selectedDate: state.selectedDate,
    scrollY: window.scrollY || 0
  };
}

function scrollToPageTop() {
  requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0, behavior: "auto" }));
}

function restoreRecordReturn(record) {
  const target = state.recordReturn;
  state.editingRecordId = null;
  state.recordReturn = null;
  if (!target) {
    state.selectedDate = record ? getRecordDate(record) : state.selectedDate;
    state.view = "today";
    return;
  }
  state.view = target.view || "today";
  state.selectedDate = record && target.view === "calendar" ? getRecordDate(record) : target.selectedDate;
  requestAnimationFrame(() => window.scrollTo({ top: target.scrollY || 0, left: 0, behavior: "auto" }));
}

function uid() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function toDateInputValue(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function toDateTimeLocalValue(date) {
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${toDateInputValue(date)}T${hours}:${minutes}`;
}

function formatDate(dateString) {
  const date = new Date(`${dateString}T00:00:00`);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

function formatRecentRangeLabel(days = 7) {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - days + 1);
  return `${formatDate(toDateInputValue(start))} - ${formatDate(toDateInputValue(end))}`;
}

function formatDateTime(value) {
  const date = new Date(value);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function formatDateTimeChinese(value) {
  const date = new Date(value);
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function getRecordDate(record) {
  return record.measuredAt.slice(0, 10);
}

function getMealLabel(record) {
  const meal = MEAL_TYPES.find((item) => item.id === record.mealType)?.label || "记录";
  if (record.mealType === "postMeal") {
    if (record.postMealMinutes === 60) return "餐后1小时";
    if (record.postMealMinutes === 120) return "餐后2小时";
    return `餐后${record.postMealMinutes || 120}分钟`;
  }
  return meal;
}

function getPeriodLabel(period) {
  return PERIODS.find((item) => item.id === period)?.label || "";
}

function classifyRecord(record) {
  const value = Number(record.glucose);
  if (value < Number(state.settings.lowThreshold)) return "low";
  const high = record.mealType === "postMeal" ? Number(state.settings.postMealHigh) : Number(state.settings.preMealHigh);
  if (value > high) return "high";
  return "normal";
}

function statusLabel(status) {
  if (status === "high") return "异常";
  if (status === "low") return "偏低";
  return "正常";
}

function statusTone(status) {
  if (status === "high") return "tone-alert";
  if (status === "low") return "tone-low";
  if (status === "normal") return "tone-normal";
  return "tone-empty";
}

function periodStatus(records) {
  if (!records.length) return "empty";
  if (records.some((record) => classifyRecord(record) === "high")) return "high";
  if (records.some((record) => classifyRecord(record) === "low")) return "low";
  return "normal";
}

function filterRecords(records, filter = state.settings.statsFilter) {
  if (filter === "pre") return records.filter((record) => record.mealType === "fasting" || record.mealType === "preMeal");
  if (filter === "post") return records.filter((record) => record.mealType === "postMeal");
  return records;
}

function sortRecords(records) {
  return [...records].sort((a, b) => new Date(b.measuredAt) - new Date(a.measuredAt));
}

function getRecentRecords() {
  return sortRecords(state.records).slice(0, Number(state.settings.recentCount));
}

function getTodayRecords() {
  return state.records.filter((record) => getRecordDate(record) === toDateInputValue(new Date()));
}

function getRecordsByDate(dateString) {
  return sortRecords(state.records.filter((record) => getRecordDate(record) === dateString)).reverse();
}

function startOfWeek(date) {
  const next = new Date(date);
  const day = next.getDay() || 7;
  next.setDate(next.getDate() - day + 1);
  next.setHours(0, 0, 0, 0);
  return next;
}

function recordsInLastDays(days) {
  const start = new Date();
  start.setDate(start.getDate() - days + 1);
  start.setHours(0, 0, 0, 0);
  return state.records.filter((record) => new Date(record.measuredAt) >= start);
}

function calcStats(records) {
  const values = records.map((record) => Number(record.glucose)).filter(Number.isFinite);
  const abnormal = records.filter((record) => classifyRecord(record) !== "normal");
  const average = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  return {
    count: records.length,
    average,
    abnormalCount: abnormal.length,
    abnormalRate: records.length ? Math.round((abnormal.length / records.length) * 100) : 0,
    max: values.length ? Math.max(...values) : 0,
    min: values.length ? Math.min(...values) : 0
  };
}

function getSummaryText() {
  const records = filterRecords(recordsInLastDays(7));
  if (!records.length) return "近7天还没有可统计的记录。先记录几次后，这里会自动总结趋势和异常情况。";
  const stats = calcStats(records);
  const abnormalByPeriod = PERIODS.map((period) => ({
    label: period.label,
    count: records.filter((record) => record.period === period.id && classifyRecord(record) !== "normal").length
  })).sort((a, b) => b.count - a.count);
  const postAbnormal = records.filter((record) => record.mealType === "postMeal" && classifyRecord(record) !== "normal").length;
  const preAbnormal = records.filter((record) => record.mealType !== "postMeal" && classifyRecord(record) !== "normal").length;
  const mealHint = postAbnormal > preAbnormal ? "餐后异常更明显" : preAbnormal > postAbnormal ? "餐前/空腹异常更明显" : "餐前和餐后整体接近";
  const periodHint = abnormalByPeriod[0].count ? `${abnormalByPeriod[0].label}间异常次数最多` : "目前没有异常记录";
  return `近7天共记录${stats.count}次，平均血糖${stats.average.toFixed(1)} mmol/L，异常率${stats.abnormalRate}%。${mealHint}，${periodHint}。`;
}

function h(strings, ...values) {
  return strings.reduce((result, string, index) => result + string + (values[index] ?? ""), "");
}

function render() {
  applySettings();
  app.innerHTML = h`
    <main class="phone-frame">
      ${renderView()}
    </main>
    ${renderNav()}
    ${renderDialog()}
    ${state.toast ? `<div class="toast">${state.toast}</div>` : ""}
  `;
  bindEvents();
  requestAnimationFrame(updateViewportOffset);
  window.setTimeout(updateViewportOffset, 120);
}

function renderView() {
  if (state.view === "calendar") return renderCalendarPage();
  if (state.view === "record") return renderRecordPage();
  if (state.view === "stats") return renderStatsPage();
  if (state.view === "settings") return renderSettingsPage();
  return renderTodayPage();
}

function renderHeader(title, subtitle = "") {
  return h`
    <header class="page-header">
      <div>
        <h1 class="page-title">${title}</h1>
        ${subtitle ? `<p class="page-subtitle">${subtitle}</p>` : ""}
      </div>
    </header>
  `;
}

function renderTodayPage() {
  const todayRecords = getTodayRecords();
  const pinned = state.settings.pinnedStats;
  return h`
    ${renderHeader("今日", `${formatDate(toDateInputValue(new Date()))} 星期${"日一二三四五六"[new Date().getDay()]}`)}
    ${renderTodayStatusPanel(todayRecords)}
    ${renderTodayAlert(todayRecords)}
    <section class="card">
      <div class="card-title-row">
        <h2 class="card-title">最近记录</h2>
        <select id="recentCountSelect" aria-label="最近记录数量">
          <option value="3" ${state.settings.recentCount === 3 ? "selected" : ""}>3条</option>
          <option value="4" ${state.settings.recentCount === 4 ? "selected" : ""}>4条</option>
          <option value="5" ${state.settings.recentCount === 5 ? "selected" : ""}>5条</option>
        </select>
      </div>
      ${renderRecordsList(getRecentRecords(), { compact: true })}
    </section>
    <section>
      <div class="card-title-row">
        <h2 class="card-title">固定板块</h2>
      </div>
      ${pinned.length ? `<div class="stats-grid">${pinned.map((id) => renderStatModule(id, true)).join("")}</div>` : `<div class="card empty-state">还没有固定统计板块</div>`}
    </section>
  `;
}

function renderTodayStatusPanel(records) {
  const windows = {
    morning: "6-10点",
    noon: "10-16点",
    evening: "16-22点"
  };
  return h`
    <section class="card today-status-card">
      <div class="today-status-grid">
        ${PERIODS.map((period) => {
          const periodRecords = records.filter((record) => record.period === period.id);
          const status = periodStatus(periodRecords);
          const label = status === "empty" ? "未记录" : statusLabel(status);
          return `<div class="today-period ${status}">
            <span class="today-period-name">${period.label}</span>
            <strong>${label}</strong>
            <span class="today-period-time">${windows[period.id]}</span>
            <span class="today-period-bar"></span>
          </div>`;
        }).join("")}
      </div>
    </section>
  `;
}

function renderTodayAlert(records) {
  const abnormal = sortRecords(records.filter((record) => classifyRecord(record) !== "normal"));
  if (!records.length) {
    return h`
      <section class="today-alert calm">
        <div class="alert-icon">＋</div>
        <div>
          <strong>今天还没有记录</strong>
          <span>可以使用底部中间的 +记录 补充。</span>
        </div>
      </section>
    `;
  }
  if (!abnormal.length) {
    return h`
      <section class="today-alert calm">
        <div class="alert-icon">✓</div>
        <div>
          <strong>今天记录正常</strong>
          <span>已记录的数据目前都在设定范围内。</span>
        </div>
      </section>
    `;
  }
  const latest = abnormal[0];
  return h`
    <section class="today-alert warning">
      <div class="alert-icon">!</div>
      <div>
        <strong>血糖偏高提醒</strong>
        <span>${getPeriodLabel(latest.period)} ${getMealLabel(latest)} ${latest.glucose} mmol/L，${latest.tookMedicine ? "已吃药" : "未吃药"}。</span>
      </div>
      <span class="alert-chevron">›</span>
    </section>
  `;
}

function renderTodayReminder(records) {
  if (!records.length) return "今天还没有记录。可以使用底部中间的 +记录 补充。";
  const abnormal = records.filter((record) => classifyRecord(record) !== "normal");
  if (!abnormal.length) return "今天已记录的数据目前都在设定范围内。";
  const latest = sortRecords(abnormal)[0];
  return `${getPeriodLabel(latest.period)} ${getMealLabel(latest)} ${latest.glucose} mmol/L ${statusLabel(classifyRecord(latest))}，请留意。`;
}

function renderPeriodStatus(records) {
  return h`
    <div class="status-grid">
      ${PERIODS.map((period) => {
        const periodRecords = records.filter((record) => record.period === period.id);
        const status = periodStatus(periodRecords);
        return `<div class="status-tile">
          <span class="status-name">${period.label}</span>
          <span class="status-value ${statusTone(status)}">${status === "empty" ? "未记录" : statusLabel(status)}</span>
        </div>`;
      }).join("")}
    </div>
  `;
}

function renderRecordsList(records, options = {}) {
  if (!records.length) return renderEmptyState("records", "暂无记录", "使用底部 +记录 添加第一条血糖数据");
  return h`
    <div class="records-list">
      ${records.map((record) => renderRecordItem(record, options)).join("")}
    </div>
  `;
}

function renderRecordItem(record, options = {}) {
  const status = classifyRecord(record);
  const icon = status === "normal" ? "✓" : status === "low" ? "!" : "!";
  const compact = Boolean(options.compact);
  return h`
    <article class="record-item ${compact ? "compact" : ""} ${status}">
      <div class="record-drop">${icon}</div>
      <div class="record-main">
        <div class="record-title">
          ${getPeriodLabel(record.period)} ${getMealLabel(record)}
        </div>
        <div class="record-meta">
          ${formatDateTime(record.measuredAt)} · ${record.tookMedicine ? "已吃药" : "未吃药"}${!compact && record.note ? ` · ${escapeHtml(record.note)}` : ""}
        </div>
      </div>
      <div class="record-value">
        <strong>${record.glucose}</strong>
        <span>mmol/L</span>
      </div>
      <span class="status-badge ${status}">${statusLabel(status)}</span>
      <div class="record-actions ${compact ? "hidden" : ""}">
        <button class="icon-button" data-edit-record="${record.id}" aria-label="修改记录">${svgIcon("edit")}</button>
        <button class="icon-button danger" data-delete-record="${record.id}" aria-label="删除记录">${svgIcon("trash")}</button>
      </div>
    </article>
  `;
}

function renderCalendarPage() {
  const selectedRecords = getRecordsByDate(state.selectedDate);
  const date = new Date(`${state.selectedDate}T00:00:00`);
  const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
  const startOffset = (monthStart.getDay() + 6) % 7;
  const daysInMonth = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startOffset; i += 1) cells.push("");
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(toDateInputValue(new Date(date.getFullYear(), date.getMonth(), day)));
  return h`
    ${renderHeader("日历", `${date.getFullYear()}年${date.getMonth() + 1}月`)}
    <section class="card">
      <div class="calendar-toolbar">
        <button class="month-button" data-month="-1" aria-label="上月">‹</button>
        <strong>${date.getFullYear()}年${date.getMonth() + 1}月</strong>
        <button class="month-button" data-month="1" aria-label="下月">›</button>
      </div>
      <div class="calendar-grid">
        ${["一", "二", "三", "四", "五", "六", "日"].map((day) => `<div class="weekday">${day}</div>`).join("")}
        ${cells.map((cell) => cell ? renderDayCell(cell) : `<div></div>`).join("")}
      </div>
    </section>
    <section class="card">
      <div class="card-title-row">
        <h2 class="card-title">${formatDate(state.selectedDate)}</h2>
        <button class="secondary-button" data-add-date="${state.selectedDate}">补记</button>
      </div>
      ${renderDayDetails(selectedRecords)}
    </section>
  `;
}

function renderDayCell(dateString) {
  const records = state.records.filter((record) => getRecordDate(record) === dateString);
  const today = toDateInputValue(new Date());
  return h`
    <button class="day-cell ${dateString === today ? "is-today" : ""} ${dateString === state.selectedDate ? "is-selected" : ""}" data-select-date="${dateString}">
      <span class="day-number">${Number(dateString.slice(8, 10))}</span>
      <span class="segment-pill">
        ${PERIODS.map((period) => {
          const periodRecords = records.filter((record) => record.period === period.id);
          const status = periodStatus(periodRecords);
          const number = periodRecords.length >= 2 ? periodRecords.length : "";
          return `<span class="segment seg-${status}">${number}</span>`;
        }).join("")}
      </span>
    </button>
  `;
}

function renderDayDetails(records) {
  if (!records.length) return renderEmptyState("calendar", "这一天还没有记录", "可以点击补记添加早中晚记录");
  return PERIODS.map((period) => {
    const periodRecords = records.filter((record) => record.period === period.id);
    return h`
      <div class="day-detail-group">
        <p class="day-detail-title">${period.label}</p>
        ${periodRecords.length ? `<div class="day-detail-list">${periodRecords.map(renderDayDetailItem).join("")}</div>` : `<div class="day-detail-empty">未记录</div>`}
      </div>
    `;
  }).join("");
}

function renderDayDetailItem(record) {
  const status = classifyRecord(record);
  const time = new Date(record.measuredAt);
  const clock = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
  return h`
    <article class="day-record ${status}">
      <div class="record-drop">${status === "normal" ? "✓" : "!"}</div>
      <div class="day-record-main">
        <strong>${getMealLabel(record)}</strong>
        <span>${clock} · ${record.tookMedicine ? "已吃药" : "未吃药"}${record.note ? ` · ${escapeHtml(record.note)}` : ""}</span>
      </div>
      <div class="day-record-value">
        <strong>${record.glucose}</strong>
        <span>mmol/L</span>
      </div>
      <span class="status-badge ${status}">${statusLabel(status)}</span>
      <div class="day-record-actions">
        <button class="icon-button" data-edit-record="${record.id}" aria-label="修改记录">${svgIcon("edit")}</button>
        <button class="icon-button danger" data-delete-record="${record.id}" aria-label="删除记录">${svgIcon("trash")}</button>
      </div>
    </article>
  `;
}

function renderRecordPage() {
  const editing = state.records.find((record) => record.id === state.editingRecordId);
  const now = new Date();
  const defaults = editing || {
    measuredAt: toDateTimeLocalValue(now),
    period: now.getHours() < 11 ? "morning" : now.getHours() < 17 ? "noon" : "evening",
    mealType: "fasting",
    postMealMinutes: 120,
    glucose: "",
    tookMedicine: false,
    note: ""
  };
  return h`
    <div class="record-page">
      ${renderHeader(editing ? "修改记录" : "+记录", editing ? "更新这条血糖记录" : "默认使用当前日期，可补记过去时间")}
      <form id="recordForm" class="card form-grid record-form-card">
        <input type="hidden" name="id" value="${editing?.id || ""}" />
        <div class="field">
          <label>日期时间</label>
          <button class="date-display-button" type="button" data-open-datetime>
            <span>${formatDateTimeChinese(defaults.measuredAt)}</span>
            ${svgIcon("calendar")}
          </button>
          <input class="native-datetime-input" type="datetime-local" name="measuredAt" value="${defaults.measuredAt}" required />
        </div>
        <div class="field">
          <label>时间段</label>
          <div class="segmented" data-segmented="period">
            ${PERIODS.map((period) => `<button type="button" data-value="${period.id}" class="${defaults.period === period.id ? "is-active" : ""}">${period.label}</button>`).join("")}
          </div>
          <input type="hidden" name="period" value="${defaults.period}" />
        </div>
        <div class="field">
          <label>测量类型</label>
          <div class="segmented" data-segmented="mealType">
            ${MEAL_TYPES.map((meal) => `<button type="button" data-value="${meal.id}" class="${defaults.mealType === meal.id ? "is-active" : ""}">${meal.label}</button>`).join("")}
          </div>
          <input type="hidden" name="mealType" value="${defaults.mealType}" />
        </div>
        <div class="field ${defaults.mealType === "postMeal" ? "" : "hidden"}" id="postMealField">
          <label>餐后时间</label>
          <div class="segmented" data-segmented="postMealMinutes">
            ${[60, 120, 180].map((minute) => `<button type="button" data-value="${minute}" class="${Number(defaults.postMealMinutes) === minute ? "is-active" : ""}">${minute === 60 ? "1小时" : minute === 120 ? "2小时" : "3小时"}</button>`).join("")}
          </div>
          <input type="hidden" name="postMealMinutes" value="${defaults.postMealMinutes || 120}" />
        </div>
        <div class="field">
          <label>血糖数值 mmol/L</label>
          <input type="number" inputmode="decimal" name="glucose" min="0" step="0.1" placeholder="例如 6.8" value="${defaults.glucose}" required />
        </div>
        <div class="field">
          <label>是否吃药</label>
          <div class="segmented" data-segmented="tookMedicine">
            <button type="button" data-value="false" class="${!defaults.tookMedicine ? "is-active" : ""}">未吃药</button>
            <button type="button" data-value="true" class="${defaults.tookMedicine ? "is-active" : ""}">已吃药</button>
          </div>
          <input type="hidden" name="tookMedicine" value="${String(defaults.tookMedicine)}" />
        </div>
        <div class="field">
          <label>备注</label>
          <textarea name="note" placeholder="例如：晚饭吃得较多">${escapeHtml(defaults.note || "")}</textarea>
        </div>
        <div class="record-form-actions">
          <button class="primary-button" type="submit">${editing ? "保存修改" : "保存记录"}</button>
          ${editing ? `<button class="secondary-button" type="button" data-cancel-edit>取消修改</button>` : ""}
        </div>
      </form>
    </div>
  `;
}

function renderStatsPage() {
  const ordered = state.settings.statOrder.filter((id) => STAT_MODULES.some((item) => item.id === id));
  return h`
    ${renderHeader("统计", formatRecentRangeLabel(7))}
    <div class="stats-grid stats-top-grid">
      ${renderStatModule("summary")}
      ${renderStatModule("overview")}
    </div>
    <section class="card filter-card">
      <div class="segmented" data-filter-tabs>
        <button data-filter="all" class="${state.settings.statsFilter === "all" ? "is-active" : ""}">合并</button>
        <button data-filter="pre" class="${state.settings.statsFilter === "pre" ? "is-active" : ""}">餐前空腹</button>
        <button data-filter="post" class="${state.settings.statsFilter === "post" ? "is-active" : ""}">餐后</button>
      </div>
    </section>
    <div class="stats-grid" id="statsGrid">
      ${ordered.filter((id) => id !== "summary" && id !== "overview").map((id) => renderStatModule(id)).join("")}
    </div>
  `;
}

function renderStatModule(id, inToday = false) {
  const meta = STAT_MODULES.find((item) => item.id === id);
  if (!meta) return "";
  const pinned = state.settings.pinnedStats.includes(id);
  const content = renderStatContent(id);
  return h`
    <article class="card stat-card stat-module-${id}" data-stat-id="${id}">
      <div class="card-title-row">
        <h2 class="card-title">${meta.title}</h2>
        ${inToday ? `<button class="remove-button" data-unpin="${id}" aria-label="从今日页移除">×</button>` : `<button class="pin-button ${pinned ? "is-pinned" : ""}" data-pin="${id}" aria-label="${pinned ? "取消固定" : "固定到今日页"}"><span></span></button>`}
      </div>
      ${content}
    </article>
  `;
}

function renderStatContent(id) {
  const records = filterRecords(recordsInLastDays(7));
  const stats = calcStats(records);
  if (id === "summary") return renderStatsSummary(records);
  if (id === "overview") {
    return renderKpiTiles(stats);
  }
  if (id === "trend") return renderTrendChart(records);
  if (id === "periodAverage") return renderPeriodAverageChart(records);
  if (id === "periodAbnormal") return renderAbnormalDonut(records);
  if (id === "mealCompare") return renderMealCompare(records);
  return "";
}

function renderStatsSummary(records) {
  const stats = calcStats(records);
  return h`
    <p class="summary-text">${getSummaryText()}</p>
    <div class="summary-chips">
      <span class="summary-chip red">↑ 餐后偏高</span>
      <span class="summary-chip orange">☀ 早间异常多</span>
      <span class="summary-chip green">✓ 记录率${stats.count ? Math.max(1, 100 - stats.abnormalRate) : 0}%</span>
    </div>
  `;
}

function renderKpiTiles(stats) {
  return h`
    <div class="kpi-grid">
      <div class="kpi-tile blue"><span>◒ 平均血糖</span><strong>${stats.average ? stats.average.toFixed(1) : "--"} <small>mmol/L</small></strong></div>
      <div class="kpi-tile red"><span>△ 异常次数</span><strong>${stats.abnormalCount} <small>次</small></strong></div>
      <div class="kpi-tile green"><span>◎ 达标率</span><strong>${stats.count ? Math.max(0, 100 - stats.abnormalRate) : 0}<small>%</small></strong></div>
      <div class="kpi-tile orange"><span>${svgIcon("trend")} 最高值</span><strong>${stats.max ? stats.max.toFixed(1) : "--"} <small>mmol/L</small></strong></div>
    </div>
  `;
}

function renderTrendChart(records) {
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setDate(date.getDate() - 6 + index);
    return toDateInputValue(date);
  });
  const points = days.map((day) => {
    const dayRecords = records.filter((record) => getRecordDate(record) === day);
    const stat = calcStats(dayRecords);
    return stat.average || null;
  });
  const values = points.filter((value) => value !== null);
  if (!values.length) return `<div class="empty-state">暂无趋势数据</div>`;
  const min = Math.min(...values, 3);
  const max = Math.max(...values, 12);
  const coords = points.map((value, index) => {
    const x = 28 + index * 40;
    if (value === null) return null;
    const y = 128 - ((value - min) / Math.max(max - min, 1)) * 94;
    const dayRecords = records.filter((record) => getRecordDate(record) === days[index]);
    const abnormal = dayRecords.some((record) => classifyRecord(record) !== "normal");
    return { x, y, abnormal };
  });
  const highY = 128 - ((Number(state.settings.postMealHigh) - min) / Math.max(max - min, 1)) * 94;
  const lowY = 128 - ((Number(state.settings.lowThreshold) - min) / Math.max(max - min, 1)) * 94;
  return h`
    <svg class="chart trend-chart" viewBox="0 0 300 170" role="img" aria-label="近7天血糖趋势">
      <text x="270" y="16" fill="var(--muted)" font-size="10" text-anchor="end">mmol/L</text>
      ${[32, 64, 96, 128].map((y) => `<path d="M28 ${y}H276" stroke="var(--line)" stroke-width="1" stroke-dasharray="4 5"/>`).join("")}
      <path d="M28 ${Math.max(24, Math.min(128, highY))}H276" stroke="var(--red)" stroke-width="1.4" stroke-dasharray="6 5"/>
      <path d="M28 ${Math.max(24, Math.min(128, lowY))}H276" stroke="var(--green)" stroke-width="1.4" stroke-dasharray="6 5"/>
      <text x="284" y="${Math.max(28, Math.min(130, highY + 4))}" text-anchor="end" fill="var(--red)" font-size="11">${state.settings.postMealHigh}</text>
      <text x="284" y="${Math.max(28, Math.min(130, lowY + 4))}" text-anchor="end" fill="var(--green)" font-size="11">${state.settings.lowThreshold}</text>
      <polyline points="${coords.filter(Boolean).map((point) => `${point.x},${point.y}`).join(" ")}" fill="none" stroke="var(--blue)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/>
      ${coords.map((point) => point ? `<circle cx="${point.x}" cy="${point.y}" r="5.2" fill="${point.abnormal ? "var(--red)" : "var(--blue)"}"/>` : "").join("")}
      <path d="M28 145H276" stroke="var(--line)" stroke-width="2"/>
      ${days.map((day, index) => `<text x="${28 + index * 40}" y="164" text-anchor="middle" fill="var(--muted)" font-size="11">${Number(day.slice(8))}</text>`).join("")}
    </svg>
  `;
}

function renderPeriodAverageChart(records) {
  const rows = PERIODS.map((period) => {
    const periodRecords = records.filter((record) => record.period === period.id);
    const stat = calcStats(periodRecords);
    return { label: period.label, value: stat.average, display: stat.average ? stat.average.toFixed(1) : "--" };
  });
  const max = Math.max(...rows.map((row) => row.value), 1);
  return h`
    <div class="vertical-bars">
      ${rows.map((row, index) => `<div class="vertical-bar-item">
        <strong>${row.display}</strong>
        <div class="vertical-bar-track"><span class="vertical-bar-fill color-${index}" style="height: ${Math.max(12, Math.round((row.value / max) * 100))}%"></span></div>
        <span>${row.label}</span>
      </div>`).join("")}
    </div>
  `;
}

function renderAbnormalDonut(records) {
  const rows = getPeriodAbnormalRows(records);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const safeTotal = Math.max(total, 1);
  const first = Math.round((rows[0].count / safeTotal) * 100);
  const second = first + Math.round((rows[1].count / safeTotal) * 100);
  return h`
    <div class="donut-layout">
      <div class="donut" style="--first:${first}%; --second:${second}%;">
        <div class="donut-center">
          <strong>${total}</strong>
          <span>次异常</span>
        </div>
      </div>
      <div class="donut-legend">
        ${rows.map((row, index) => `<div><span class="legend-dot color-${index}"></span>${row.label} <strong>${row.count}次</strong> (${Math.round((row.count / safeTotal) * 100)}%)</div>`).join("")}
      </div>
    </div>
  `;
}

function renderMealCompare(records) {
  const preRecords = records.filter((record) => record.mealType === "fasting" || record.mealType === "preMeal");
  const postRecords = records.filter((record) => record.mealType === "postMeal");
  const pre = calcStats(preRecords).average;
  const post = calcStats(postRecords).average;
  return h`
    <div class="meal-compare">
      <div class="meal-side pre">
        <span>餐前空腹</span>
        <strong>${pre ? pre.toFixed(1) : "--"} <small>mmol/L</small></strong>
      </div>
      <div class="vs-badge">VS</div>
      <div class="meal-side post">
        <span>餐后</span>
        <strong>${post ? post.toFixed(1) : "--"} <small>mmol/L</small></strong>
      </div>
    </div>
  `;
}

function getPeriodAbnormalRows(records) {
  return PERIODS.map((period) => {
    const periodRecords = records.filter((record) => record.period === period.id);
    return {
      label: period.label,
      count: periodRecords.filter((record) => classifyRecord(record) !== "normal").length
    };
  });
}

function renderCompletion(records) {
  const weekStart = startOfWeek(new Date());
  const weekRecords = state.records.filter((record) => new Date(record.measuredAt) >= weekStart);
  const days = new Set(weekRecords.map(getRecordDate));
  const expected = 7 * 3;
  const completedSlots = new Set(weekRecords.map((record) => `${getRecordDate(record)}-${record.period}`)).size;
  const rate = Math.round((completedSlots / expected) * 100);
  return h`
    <div class="metric-row">
      <div class="metric"><strong>${rate}%</strong><span>本周记录完整度</span></div>
      <div class="metric"><strong>${days.size}</strong><span>本周有记录天数</span></div>
    </div>
  `;
}

function renderSettingsPage() {
  const isLocal = location.hostname === "localhost" || location.hostname === "127.0.0.1";
  return h`
    ${renderHeader("设置", "阈值、字体、外观和数据备份")}
    <section class="card settings-list">
      <div class="setting-block">
        <p class="setting-title">血糖提醒值</p>
        <div class="two-col">
          <div class="field"><label>偏低低于</label><input type="number" step="0.1" id="lowThreshold" value="${state.settings.lowThreshold}" /></div>
          <div class="field"><label>餐前/空腹高于</label><input type="number" step="0.1" id="preMealHigh" value="${state.settings.preMealHigh}" /></div>
        </div>
        <div class="field"><label>餐后高于</label><input type="number" step="0.1" id="postMealHigh" value="${state.settings.postMealHigh}" /></div>
        <p class="page-subtitle">参考值仅用于日常记录，具体控制目标请以医生建议为准。</p>
      </div>
      <div class="setting-block">
        <p class="setting-title">字体大小</p>
        <div class="segmented" data-setting-tabs="fontSize">
          <button data-value="standard" class="${state.settings.fontSize === "standard" ? "is-active" : ""}">标准</button>
          <button data-value="large" class="${state.settings.fontSize === "large" ? "is-active" : ""}">大</button>
          <button data-value="xlarge" class="${state.settings.fontSize === "xlarge" ? "is-active" : ""}">特大</button>
        </div>
      </div>
      <div class="setting-block">
        <p class="setting-title">外观模式</p>
        <div class="segmented" data-setting-tabs="appearance">
          <button data-value="light" class="${state.settings.appearance === "light" ? "is-active" : ""}">白色</button>
          <button data-value="dark" class="${state.settings.appearance === "dark" ? "is-active" : ""}">黑色</button>
          <button data-value="system" class="${state.settings.appearance === "system" ? "is-active" : ""}">跟随系统</button>
        </div>
      </div>
      <div class="setting-block">
        <p class="setting-title">数据备份</p>
        <div class="two-col">
          <button class="secondary-button" data-export="json">导出JSON</button>
          <button class="secondary-button" data-export="csv">导出CSV</button>
        </div>
        <div class="field">
          <label>导入JSON备份</label>
          <input type="file" id="importFile" accept="application/json,.json" />
        </div>
        <p class="page-subtitle">建议每月导出一次备份，换手机前请先导出 JSON。</p>
      </div>
      ${isLocal ? `<div class="setting-block">
        <p class="setting-title">本地演示数据</p>
        <div class="two-col">
          <button class="secondary-button" data-demo="seed">填充演示数据</button>
          <button class="danger-button" data-demo="clear">清空演示数据</button>
        </div>
        <p class="page-subtitle">仅用于本机预览效果，正式部署前请清空。</p>
      </div>` : ""}
    </section>
  `;
}

function renderNav() {
  const items = [
    ["today", "今日", "home"],
    ["calendar", "日历", "calendar"],
    ["record", "记录", "plus"],
    ["stats", "统计", "bars"],
    ["settings", "设置", "settings"]
  ];
  return h`
    <nav class="bottom-nav" aria-label="底部导航">
      ${items.map(([id, label, icon]) => `<button class="nav-button ${id === "record" ? "add" : ""} ${state.view === id ? "is-active" : ""}" data-view="${id}">
        <span class="nav-icon">${svgIcon(icon)}</span>
        <span>${label}</span>
      </button>`).join("")}
    </nav>
  `;
}

function renderDialog() {
  if (!state.dialog) return "";
  return h`
    <div class="sheet-backdrop" data-dialog-cancel>
      <section class="bottom-sheet" role="dialog" aria-modal="true" aria-label="${state.dialog.title}">
        <div class="sheet-handle"></div>
        <h2>${state.dialog.title}</h2>
        <p>${state.dialog.message}</p>
        <div class="sheet-actions">
          ${state.dialog.actions.map((action) => `<button class="${action.danger ? "danger-button" : "primary-button"}" data-dialog-action="${action.id}">${action.label}</button>`).join("")}
          <button class="secondary-button" data-dialog-cancel>取消</button>
        </div>
      </section>
    </div>
  `;
}

function renderEmptyState(icon, title, body) {
  return h`
    <div class="empty-state">
      <div class="empty-icon">${svgIcon(icon)}</div>
      <strong>${title}</strong>
      <span>${body}</span>
    </div>
  `;
}

function svgIcon(name) {
  const icons = {
    home: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3.5 10.8 12 4l8.5 6.8v8.7a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1v-8.7Z"/></svg>`,
    calendar: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3v3M17 3v3M4.5 9h15M6 5h12a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z"/></svg>`,
    plus: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>`,
    bars: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 20V11M12 20V5M19 20v-7"/></svg>`,
    settings: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2 3.4-.2-.1a1.7 1.7 0 0 0-2 .3 1.7 1.7 0 0 0-.8 1.6V22H9.2v-.2a1.7 1.7 0 0 0-.8-1.6 1.7 1.7 0 0 0-2-.3l-.2.1-2-3.4.1-.1A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.4-1H3v-4h.2a1.7 1.7 0 0 0 1.4-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 2-3.4.2.1a1.7 1.7 0 0 0 2-.3 1.7 1.7 0 0 0 .8-1.6V2h5.6v.2a1.7 1.7 0 0 0 .8 1.6 1.7 1.7 0 0 0 2 .3l.2-.1 2 3.4-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.4 1h.2v4h-.2a1.7 1.7 0 0 0-1.4 1Z"/></svg>`,
    edit: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m4 16.8-.5 3.7 3.7-.5L18.6 8.6l-3.2-3.2L4 16.8Z"/><path d="m14.5 6.3 3.2 3.2"/></svg>`,
    trash: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M9 7V5h6v2M8 10v8M12 10v8M16 10v8M7 7l1 14h8l1-14"/></svg>`,
    trend: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16 9 11l4 4 7-8"/><path d="M15 7h5v5"/></svg>`,
    records: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4h10a2 2 0 0 1 2 2v14H5V6a2 2 0 0 1 2-2Z"/><path d="M8 9h8M8 13h8M8 17h5"/></svg>`
  };
  return icons[name] || icons.records;
}

function bindEvents() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      if (state.view === "record") {
        state.editingRecordId = null;
        state.recordReturn = null;
        scrollToPageTop();
      }
      render();
    });
  });

  document.querySelectorAll("[data-select-date]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedDate = button.dataset.selectDate;
      render();
    });
  });

  document.querySelectorAll("[data-month]").forEach((button) => {
    button.addEventListener("click", () => {
      const date = new Date(`${state.selectedDate}T00:00:00`);
      date.setMonth(date.getMonth() + Number(button.dataset.month));
      state.selectedDate = toDateInputValue(date);
      render();
    });
  });

  document.querySelectorAll("[data-add-date]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberRecordReturn();
      state.editingRecordId = null;
      state.view = "record";
      render();
      scrollToPageTop();
      const input = document.querySelector("input[name='measuredAt']");
      const dateButton = document.querySelector("[data-open-datetime] span");
      if (input) {
        input.value = `${button.dataset.addDate}T08:00`;
        if (dateButton) dateButton.textContent = formatDateTimeChinese(input.value);
      }
    });
  });

  bindRecordForm();
  bindRecordActions();
  bindStats();
  bindSettings();
  bindDialog();
}

function bindRecordForm() {
  const form = document.querySelector("#recordForm");
  if (!form) return;

  const dateInput = form.elements.measuredAt;
  const dateButton = form.querySelector("[data-open-datetime]");
  dateButton?.addEventListener("click", () => {
    if (typeof dateInput.showPicker === "function") {
      dateInput.showPicker();
      return;
    }
    dateInput.focus();
    dateInput.click();
  });
  dateInput?.addEventListener("change", () => {
    const label = dateButton?.querySelector("span");
    if (label && dateInput.value) label.textContent = formatDateTimeChinese(dateInput.value);
  });

  form.querySelectorAll("[data-segmented]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const target = event.target.closest("button[data-value]");
      if (!target) return;
      const name = group.dataset.segmented;
      form.elements[name].value = target.dataset.value;
      group.querySelectorAll("button").forEach((button) => button.classList.remove("is-active"));
      target.classList.add("is-active");
      if (name === "mealType") {
        document.querySelector("#postMealField")?.classList.toggle("hidden", target.dataset.value !== "postMeal");
      }
    });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(form);
    const id = data.get("id") || uid();
    const now = new Date().toISOString();
    const record = {
      id,
      measuredAt: data.get("measuredAt"),
      period: data.get("period"),
      mealType: data.get("mealType"),
      postMealMinutes: Number(data.get("postMealMinutes") || 120),
      glucose: Number(data.get("glucose")),
      tookMedicine: data.get("tookMedicine") === "true",
      note: String(data.get("note") || "").trim(),
      createdAt: state.records.find((item) => item.id === id)?.createdAt || now,
      updatedAt: now
    };
    if (record.mealType !== "postMeal") record.postMealMinutes = null;
    state.records = state.records.some((item) => item.id === id)
      ? state.records.map((item) => item.id === id ? record : item)
      : [...state.records, record];
    saveRecords();
    restoreRecordReturn(record);
    showToast("记录已保存");
  });

  document.querySelector("[data-cancel-edit]")?.addEventListener("click", () => {
    restoreRecordReturn();
    render();
  });
}

function bindRecordActions() {
  document.querySelectorAll("[data-edit-record]").forEach((button) => {
    button.addEventListener("click", () => {
      rememberRecordReturn();
      state.editingRecordId = button.dataset.editRecord;
      state.view = "record";
      render();
      scrollToPageTop();
    });
  });

  document.querySelectorAll("[data-delete-record]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dialog = {
        title: "删除这条记录？",
        message: "删除后不会影响其他日期记录，但这条数据无法自动恢复。",
        actions: [{ id: `delete-record:${button.dataset.deleteRecord}`, label: "删除", danger: true }]
      };
      render();
    });
  });
}

function bindStats() {
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.settings.statsFilter = button.dataset.filter;
      saveSettings();
      render();
    });
  });

  document.querySelectorAll("[data-pin]").forEach((button) => {
    button.addEventListener("click", () => {
      const id = button.dataset.pin;
      const exists = state.settings.pinnedStats.includes(id);
      state.settings.pinnedStats = exists
        ? state.settings.pinnedStats.filter((item) => item !== id)
        : [...state.settings.pinnedStats, id];
      saveSettings();
      render();
    });
  });

  document.querySelectorAll("[data-unpin]").forEach((button) => {
    button.addEventListener("click", () => {
      state.dialog = {
        title: "从今日页移除？",
        message: "只会取消这个统计板块在今日页的固定，不会删除任何血糖数据。",
        actions: [{ id: `unpin:${button.dataset.unpin}`, label: "移除", danger: true }]
      };
      render();
    });
  });

  const grid = document.querySelector("#statsGrid");
  if (!grid) return;
  let draggedId = null;
  let pressTimer = null;

  grid.querySelectorAll(".stat-card").forEach((card) => {
    card.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button")) return;
      pressTimer = window.setTimeout(() => {
        draggedId = card.dataset.statId;
        card.classList.add("is-dragging");
        grid.querySelectorAll(".stat-card").forEach((item) => item.classList.add("is-editing"));
        card.setPointerCapture(event.pointerId);
      }, 280);
    });

    card.addEventListener("pointermove", (event) => {
      if (!draggedId) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(".stat-card");
      if (!target || target.dataset.statId === draggedId) return;
      const order = [...state.settings.statOrder];
      const from = order.indexOf(draggedId);
      const to = order.indexOf(target.dataset.statId);
      if (from < 0 || to < 0) return;
      order.splice(to, 0, order.splice(from, 1)[0]);
      state.settings.statOrder = order;
      saveSettings();
      render();
    });

    card.addEventListener("pointerup", () => {
      window.clearTimeout(pressTimer);
      draggedId = null;
      grid.querySelectorAll(".stat-card").forEach((item) => item.classList.remove("is-editing", "is-dragging"));
    });

    card.addEventListener("pointerleave", () => window.clearTimeout(pressTimer));
  });
}

function bindSettings() {
  document.querySelector("#recentCountSelect")?.addEventListener("change", (event) => {
    state.settings.recentCount = Number(event.target.value);
    saveSettings();
    render();
  });

  document.querySelectorAll("[data-setting-tabs]").forEach((group) => {
    group.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-value]");
      if (!button) return;
      state.settings[group.dataset.settingTabs] = button.dataset.value;
      saveSettings();
      render();
    });
  });

  ["lowThreshold", "preMealHigh", "postMealHigh"].forEach((id) => {
    document.querySelector(`#${id}`)?.addEventListener("change", (event) => {
      state.settings[id] = Number(event.target.value);
      saveSettings();
      showToast("提醒值已更新");
    });
  });

  document.querySelectorAll("[data-export]").forEach((button) => {
    button.addEventListener("click", () => exportData(button.dataset.export));
  });

  document.querySelector("#importFile")?.addEventListener("change", importData);

  document.querySelectorAll("[data-demo]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.demo === "seed") {
        state.records = generateDemoRecords();
        saveRecords();
        showToast("演示数据已填充");
        return;
      }
      state.records = state.records.filter((record) => !record.demo);
      saveRecords();
      showToast("演示数据已清空");
    });
  });
}

function bindDialog() {
  document.querySelectorAll("[data-dialog-cancel]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.closest(".bottom-sheet") && !event.target.matches("[data-dialog-cancel]")) return;
      closeDialog();
    });
  });

  document.querySelectorAll("[data-dialog-action]").forEach((button) => {
    button.addEventListener("click", () => handleDialogAction(button.dataset.dialogAction));
  });
}

function closeDialog() {
  state.dialog = null;
  state.pendingImportRecords = null;
  render();
}

function handleDialogAction(action) {
  if (action.startsWith("delete-record:")) {
    const id = action.split(":")[1];
    state.records = state.records.filter((record) => record.id !== id);
    saveRecords();
    state.dialog = null;
    showToast("记录已删除");
    return;
  }

  if (action.startsWith("unpin:")) {
    const id = action.split(":")[1];
    state.settings.pinnedStats = state.settings.pinnedStats.filter((item) => item !== id);
    saveSettings();
    state.dialog = null;
    showToast("已从今日页移除");
    return;
  }

  if (action === "import-merge" || action === "import-replace") {
    const incoming = state.pendingImportRecords || [];
    if (action === "import-replace") {
      state.records = incoming.map(normalizeRecord);
    } else {
      const existingIds = new Set(state.records.map((record) => record.id));
      const merged = incoming.map(normalizeRecord).filter((record) => !existingIds.has(record.id));
      state.records = [...state.records, ...merged];
    }
    saveRecords();
    state.dialog = null;
    state.pendingImportRecords = null;
    showToast(`导入完成，共${incoming.length}条`);
  }
}

function exportData(type) {
  if (type === "csv") {
    const header = ["日期时间", "时间段", "测量类型", "餐后分钟", "血糖", "是否吃药", "备注"];
    const rows = state.records.map((record) => [
      record.measuredAt,
      getPeriodLabel(record.period),
      getMealLabel(record),
      record.postMealMinutes || "",
      record.glucose,
      record.tookMedicine ? "已吃药" : "未吃药",
      record.note || ""
    ]);
    downloadFile(`血糖记录-${toDateInputValue(new Date())}.csv`, [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\n"), "text/csv;charset=utf-8");
    return;
  }

  const payload = {
    app: "blood-glucose-pwa",
    version: 1,
    exportedAt: new Date().toISOString(),
    records: state.records,
    settings: state.settings
  };
  downloadFile(`血糖记录备份-${toDateInputValue(new Date())}.json`, JSON.stringify(payload, null, 2), "application/json");
}

function importData(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const payload = JSON.parse(String(reader.result || "{}"));
      const incoming = Array.isArray(payload.records) ? payload.records : [];
      if (!incoming.length) {
        showToast("没有找到可导入的记录");
        return;
      }
      state.pendingImportRecords = incoming;
      state.dialog = {
        title: "导入备份数据？",
        message: `检测到 ${incoming.length} 条记录。建议选择合并，除非你确定要用备份覆盖当前手机数据。`,
        actions: [
          { id: "import-merge", label: "合并导入" },
          { id: "import-replace", label: "覆盖本地", danger: true }
        ]
      };
      render();
    } catch {
      showToast("导入失败，请检查 JSON 文件");
    }
  };
  reader.readAsText(file);
}

function normalizeRecord(record) {
  return {
    id: record.id || uid(),
    measuredAt: record.measuredAt || toDateTimeLocalValue(new Date()),
    period: record.period || "morning",
    mealType: record.mealType || "fasting",
    postMealMinutes: record.postMealMinutes ?? null,
    glucose: Number(record.glucose || 0),
    tookMedicine: Boolean(record.tookMedicine),
    note: record.note || "",
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: record.updatedAt || new Date().toISOString()
  };
}

function generateDemoRecords() {
  const notes = ["", "饭后散步20分钟", "昨晚睡眠一般", "早餐较清淡", "中午主食较多", "晚饭偏晚"];
  const mealTypesByPeriod = {
    morning: ["fasting", "postMeal"],
    noon: ["preMeal", "postMeal"],
    evening: ["preMeal", "postMeal"]
  };
  const records = [];
  for (let day = 0; day < 21; day += 1) {
    PERIODS.forEach((period, periodIndex) => {
      if ((day + periodIndex) % 7 === 2) return;
      const shouldDouble = (day + periodIndex) % 4 === 0;
      mealTypesByPeriod[period.id].slice(0, shouldDouble ? 2 : 1).forEach((mealType, mealIndex) => {
        const hour = period.id === "morning" ? 7 + mealIndex * 2 : period.id === "noon" ? 11 + mealIndex * 2 : 18 + mealIndex * 2;
        const index = day * 3 + periodIndex + mealIndex;
        records.push({
          id: `demo-${day}-${period.id}-${mealType}`,
          measuredAt: demoDateTime(day, hour, mealIndex ? 20 : 10),
          period: period.id,
          mealType,
          postMealMinutes: mealType === "postMeal" ? 120 : null,
          glucose: demoGlucose(mealType, index),
          tookMedicine: (day + periodIndex + mealIndex) % 3 !== 0,
          note: notes[index % notes.length],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          demo: true
        });
      });
    });
  }
  return records;
}

function demoDateTime(daysAgo, hour, minute) {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return toDateTimeLocalValue(date);
}

function demoGlucose(mealType, index) {
  const base = mealType === "postMeal" ? 8.2 : 5.8;
  const wave = Math.sin(index * 1.7) * 1.1;
  const spike = index % 9 === 0 ? 2.8 : index % 13 === 0 ? -2.1 : 0;
  return Math.max(3.2, Number((base + wave + spike).toFixed(1)));
}

function downloadFile(filename, content, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function showToast(message) {
  state.toast = message;
  render();
  window.setTimeout(() => {
    state.toast = "";
    render();
  }, 1800);
}

const params = new URLSearchParams(location.search);
if (params.get("demo") === "seed") {
  state.records = generateDemoRecords();
  saveRecords();
  state.view = "today";
  history.replaceState(null, "", location.pathname);
}
if (params.get("demo") === "clear") {
  state.records = state.records.filter((record) => !record.demo);
  saveRecords();
  state.view = "today";
  history.replaceState(null, "", location.pathname);
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  });
}

window.visualViewport?.addEventListener("resize", updateViewportOffset);
window.visualViewport?.addEventListener("scroll", updateViewportOffset);
window.addEventListener("resize", updateViewportOffset);

render();
