var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// scripts/domain-entry.js
var domain_entry_exports = {};
__export(domain_entry_exports, {
  MOMENT_LABELS: () => MOMENT_LABELS,
  activeRecords: () => activeRecords,
  buildInsights: () => buildInsights,
  buildSeedRecords: () => buildSeedRecords,
  findLowReadings: () => findLowReadings,
  fromLocalDateTimeInput: () => fromLocalDateTimeInput,
  getTrendSeries: () => getTrendSeries,
  localDateKey: () => localDateKey,
  momentLabel: () => momentLabel,
  recordsToCsv: () => recordsToCsv,
  recordsToJson: () => recordsToJson,
  targetKey: () => targetKey,
  toLocalDateTimeInput: () => toLocalDateTimeInput,
  validateRecordInput: () => validateRecordInput,
  validateTargetRange: () => validateTargetRange
});
module.exports = __toCommonJS(domain_entry_exports);

// shared/data.ts
var MOMENT_LABELS = {
  fasting: "\u7A7A\u8179",
  before: "\u9910\u524D",
  after: "\u9910\u540E",
  bedtime: "\u7761\u524D",
  other: "\u5176\u4ED6 / \u4E0D\u786E\u5B9A"
};
var MOMENTS = Object.keys(MOMENT_LABELS);
var UNITS = ["mmol/L", "mg/dL"];
var pad = (value) => String(value).padStart(2, "0");
function localDateKey(value = /* @__PURE__ */ new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function toLocalDateTimeInput(value = /* @__PURE__ */ new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return `${localDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function fromLocalDateTimeInput(value) {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!parts) return "";
  const [, year, month, day, hour, minute, second = "0"] = parts;
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day) || date.getHours() !== Number(hour) || date.getMinutes() !== Number(minute) || date.getSeconds() !== Number(second)) return "";
  return date.toISOString();
}
function momentLabel(record) {
  if (record.moment !== "after" || record.afterMinutes === void 0) return MOMENT_LABELS[record.moment];
  const minutes = record.afterMinutes;
  return minutes % 60 === 0 ? `\u9910\u540E${minutes / 60}\u5C0F\u65F6` : `\u9910\u540E${minutes}\u5206\u949F`;
}
function normalizeValue(value) {
  const normalized = value.trim().replace(/[０-９]/g, (character) => String(character.charCodeAt(0) - 65296)).replace(/[．，,]/g, ".");
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) return null;
  return normalized.replace(/^0+(?=\d)/, "");
}
function validateRecordInput(input, now = /* @__PURE__ */ new Date()) {
  var _a, _b;
  const value = normalizeValue(input.value);
  if (value === null) return { ok: false, error: "\u8BF7\u8F93\u5165\u5927\u4E8E 0 \u7684\u8840\u7CD6\u6570\u503C\uFF0C\u6700\u591A\u4FDD\u7559\u4E24\u4F4D\u5C0F\u6570\u3002HI\u3001LO \u6216\u9519\u8BEF\u7801\u8BF7\u52FF\u586B\u4E3A\u6570\u5B57\u3002" };
  if (!UNITS.includes(input.unit)) return { ok: false, error: "\u8BF7\u6838\u5BF9\u5E76\u9009\u62E9\u8840\u7CD6\u4EEA\u663E\u793A\u7684\u5355\u4F4D\u3002" };
  if (!MOMENTS.includes(input.moment)) return { ok: false, error: "\u8BF7\u9009\u62E9\u6D4B\u91CF\u65F6\u673A\uFF1B\u4E0D\u786E\u5B9A\u65F6\u53EF\u9009\u201C\u5176\u4ED6 / \u4E0D\u786E\u5B9A\u201D\u3002" };
  if (input.moment === "after" && input.afterMinutes !== void 0 && (!Number.isInteger(input.afterMinutes) || input.afterMinutes <= 0 || input.afterMinutes > 1440)) {
    return { ok: false, error: "\u8BF7\u586B\u5199\u6B63\u786E\u7684\u9910\u540E\u95F4\u9694\u5206\u949F\u6570\uFF0C\u6216\u6682\u4E0D\u586B\u5199\u3002" };
  }
  const localInput = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input.measuredAt);
  const measuredAt = localInput ? fromLocalDateTimeInput(input.measuredAt) : input.measuredAt;
  const date = new Date(measuredAt);
  if (!measuredAt || !Number.isFinite(date.getTime())) return { ok: false, error: "\u8BF7\u586B\u5199\u6709\u6548\u7684\u6D4B\u91CF\u65E5\u671F\u548C\u65F6\u95F4\u3002" };
  if (date.getTime() > now.getTime() + 5 * 6e4) return { ok: false, error: "\u6D4B\u91CF\u65F6\u95F4\u665A\u4E8E\u73B0\u5728\uFF0C\u8BF7\u6838\u5BF9\u5B9E\u9645\u6D4B\u91CF\u65F6\u95F4\u3002" };
  const note = ((_a = input.note) != null ? _a : "").trim();
  if (note.length > 2e3) return { ok: false, error: "\u5907\u6CE8\u8BF7\u63A7\u5236\u5728 2000 \u5B57\u4EE5\u5185\u3002" };
  if (input.source !== void 0 && input.source !== "manual" && input.source !== "photo") return { ok: false, error: "\u8BB0\u5F55\u6765\u6E90\u65E0\u6548\u3002" };
  return { ok: true, data: {
    value,
    unit: input.unit,
    moment: input.moment,
    ...input.moment === "after" && input.afterMinutes !== void 0 ? { afterMinutes: input.afterMinutes } : {},
    measuredAt: date.toISOString(),
    note,
    source: (_b = input.source) != null ? _b : "manual"
  } };
}
function activeRecords(records) {
  return records.filter((record) => !record.deletedAt).sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime());
}
function buildSeedRecords(anchorDate = /* @__PURE__ */ new Date()) {
  const fasting = ["6.4", "6.0", "6.3", "6.1", "6.2", "6.4", "6.1"];
  const records = [];
  for (let index = 0; index < 7; index += 1) {
    const measured = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() - 6 + index, 7, 10);
    const dateKey = localDateKey(measured);
    const add = (value, moment, date) => {
      const stamp = date.toISOString();
      records.push({
        id: `demo-${dateKey}-${moment}`,
        value,
        unit: "mmol/L",
        moment,
        ...moment === "after" ? { afterMinutes: 120 } : {},
        measuredAt: stamp,
        createdAt: stamp,
        updatedAt: stamp,
        note: "\u6F14\u793A\u8BB0\u5F55",
        source: "manual"
      });
    };
    add(fasting[index], "fasting", measured);
    if (index % 2 === 0) {
      const after = new Date(measured);
      after.setHours(9, 20, 0, 0);
      add(index === 6 ? "7.6" : ["7.8", "7.4", "7.9"][index / 2], "after", after);
    }
  }
  return activeRecords(records);
}
function getTrendSeries(records, options) {
  var _a;
  const anchor = (_a = options.anchorDate) != null ? _a : /* @__PURE__ */ new Date();
  const days = Array.from({ length: options.days }, (_, index) => {
    const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - options.days + 1 + index);
    return { dateKey: localDateKey(date), label: `${date.getMonth() + 1}/${date.getDate()}`, value: null, count: 0, samples: [] };
  });
  const byDay = new Map(days.map((day) => [day.dateKey, day]));
  const samples = [];
  for (const record of activeRecords(records).reverse()) {
    if (record.moment !== options.moment || record.unit !== options.unit || record.moment === "after" && record.afterMinutes !== options.afterMinutes) continue;
    const dateKey = localDateKey(record.measuredAt);
    const day = byDay.get(dateKey);
    if (!day) continue;
    const sample = { id: record.id, measuredAt: record.measuredAt, dateKey, value: Number(record.value), record };
    day.samples.push(sample);
    samples.push(sample);
  }
  for (const day of days) {
    day.count = day.samples.length;
    day.value = day.count ? day.samples.reduce((total, sample) => total + sample.value, 0) / day.count : null;
  }
  return { days, samples, count: samples.length };
}
function csvCell(value) {
  const text = String(value);
  const escaped = /^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text) ? `'${text}` : text;
  return `"${escaped.replace(/"/g, '""')}"`;
}
function recordsToCsv(records) {
  const header = ["\u6D4B\u91CF\u65F6\u95F4\uFF08ISO 8601\uFF09", "\u8840\u7CD6\u6570\u503C", "\u5355\u4F4D", "\u6D4B\u91CF\u65F6\u673A", "\u9910\u540E\u95F4\u9694\uFF08\u5206\u949F\uFF09", "\u5907\u6CE8", "\u5F55\u5165\u65B9\u5F0F"];
  const rows = activeRecords(records).map((record) => {
    var _a;
    return [
      record.measuredAt,
      record.value,
      record.unit,
      momentLabel(record),
      (_a = record.afterMinutes) != null ? _a : "",
      record.note,
      record.source === "photo" ? "\u62CD\u7167" : "\u624B\u52A8"
    ];
  });
  return "\uFEFF" + [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
}
function recordsToJson(records, now = /* @__PURE__ */ new Date()) {
  return JSON.stringify({ version: 1, exportedAt: now.toISOString(), records: activeRecords(records) }, null, 2);
}

// shared/insights.ts
var units = ["mmol/L", "mg/dL"];
var moments = ["fasting", "before", "after", "bedtime", "other"];
var error = (message) => ({ ok: false, error: message });
var validInterval = (value) => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1440;
function targetKey(context) {
  var _a;
  if (!moments.includes(context.moment) || !units.includes(context.unit)) throw new RangeError("\u76EE\u6807\u7684\u6D4B\u91CF\u65F6\u673A\u6216\u5355\u4F4D\u65E0\u6548\u3002");
  if (context.moment !== "after") return `${context.moment}:${context.unit}`;
  const minutes = (_a = context.afterMinutes) != null ? _a : 120;
  if (!validInterval(minutes)) throw new RangeError("\u9910\u540E\u95F4\u9694\u5E94\u4E3A 1 \u81F3 1440 \u5206\u949F\u3002");
  return `after:${minutes}:${context.unit}`;
}
function parseBound(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  const text = String(value).trim().replace(/[０-９]/g, (character) => String(character.charCodeAt(0) - 65296)).replace(/[．，,]/g, ".");
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) && number > 0 ? number : null;
}
function validateTargetRange(input, now = /* @__PURE__ */ new Date()) {
  const low = parseBound(input.low), high = parseBound(input.high);
  if (low === null || high === null) return error("\u8BF7\u8F93\u5165\u5927\u4E8E 0 \u7684\u76EE\u6807\u4E0B\u9650\u548C\u4E0A\u9650\uFF0C\u6700\u591A\u4FDD\u7559\u4E24\u4F4D\u5C0F\u6570\u3002");
  if (!units.includes(input.unit)) return error("\u8BF7\u9009\u62E9\u76EE\u6807\u8303\u56F4\u4F7F\u7528\u7684\u5355\u4F4D\u3002");
  if (low >= high) return error("\u76EE\u6807\u4E0B\u9650\u9700\u8981\u5C0F\u4E8E\u4E0A\u9650\uFF0C\u8BF7\u6838\u5BF9\u540E\u518D\u4FDD\u5B58\u3002");
  if (!Number.isFinite(now.getTime())) return error("\u76EE\u6807\u66F4\u65B0\u65F6\u95F4\u65E0\u6548\uFF0C\u5C1A\u672A\u4FDD\u5B58\u3002");
  return { ok: true, data: { low, high, unit: input.unit, updatedAt: now.toISOString() } };
}
function storedTarget(value) {
  if (!value || typeof value !== "object") return false;
  const range = value;
  return typeof range.low === "number" && typeof range.high === "number" && parseBound(range.low) !== null && parseBound(range.high) !== null && range.low < range.high && units.includes(range.unit) && typeof range.updatedAt === "string" && range.updatedAt.length > 0 && Number.isFinite(new Date(range.updatedAt).getTime());
}
function average(records) {
  return records.length ? records.reduce((sum, record) => sum + Number(record.value), 0) / records.length : null;
}
function daysRecorded(records) {
  return new Set(records.map((record) => localDateKey(record.measuredAt))).size;
}
function uniqueActiveRecords(input) {
  const byId = /* @__PURE__ */ new Map();
  for (const record of input) {
    const previous = byId.get(record.id);
    if (!previous || new Date(record.updatedAt).getTime() >= new Date(previous.updatedAt).getTime()) byId.set(record.id, record);
  }
  return activeRecords([...byId.values()]);
}
function findLowReadings(input, options) {
  var _a;
  const now = (_a = options.now) != null ? _a : /* @__PURE__ */ new Date();
  if (!Number.isFinite(now.getTime()) || options.days !== 7 && options.days !== 30) throw new RangeError("\u5206\u6790\u65F6\u95F4\u8303\u56F4\u65E0\u6548\u3002");
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.days + 1);
  return uniqueActiveRecords(input).filter((record) => {
    const time = new Date(record.measuredAt).getTime(), value = Number(record.value);
    return Number.isFinite(time) && time >= start.getTime() && time <= now.getTime() && Number.isFinite(value) && value > 0 && (record.unit === "mmol/L" && value < 3.9 || record.unit === "mg/dL" && value < 70);
  });
}
function buildInsights(input, options) {
  var _a, _b;
  const now = (_a = options.now) != null ? _a : /* @__PURE__ */ new Date();
  if (!Number.isFinite(now.getTime()) || options.days !== 7 && options.days !== 30) throw new RangeError("\u5206\u6790\u65F6\u95F4\u8303\u56F4\u65E0\u6548\u3002");
  targetKey(options);
  const currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.days + 1);
  const previousStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.days * 2 + 1);
  const previousEnd = new Date(currentStart.getFullYear(), currentStart.getMonth(), currentStart.getDate() - 1);
  const interval = options.moment === "after" ? (_b = options.afterMinutes) != null ? _b : 120 : void 0;
  const relevant = uniqueActiveRecords(input).filter((record) => {
    const time = new Date(record.measuredAt).getTime();
    return record.moment === options.moment && record.unit === options.unit && (record.moment !== "after" || record.afterMinutes === interval) && Number.isFinite(time) && time <= now.getTime() && Number.isFinite(Number(record.value)) && Number(record.value) > 0;
  });
  const records = relevant.filter((record) => new Date(record.measuredAt).getTime() >= currentStart.getTime());
  const previousRecords = relevant.filter((record) => {
    const time = new Date(record.measuredAt).getTime();
    return time >= previousStart.getTime() && time < currentStart.getTime();
  });
  const currentAverage = average(records), previousAverage = average(previousRecords);
  const currentDays = daysRecorded(records), previousDays = daysRecorded(previousRecords);
  const canCompare = records.length >= 3 && previousRecords.length >= 3 && currentDays >= 3 && previousDays >= 3;
  const delta = canCompare && currentAverage !== null && previousAverage !== null ? currentAverage - previousAverage : null;
  const validTarget = options.target && storedTarget(options.target) && options.target.unit === options.unit ? options.target : null;
  const targetError = options.target && !validTarget ? "\u5F53\u524D\u76EE\u6807\u8303\u56F4\u6216\u5355\u4F4D\u65E0\u6548\uFF0C\u6682\u4E0D\u5224\u65AD\u8303\u56F4\u5185\u5916\u3002" : "";
  const below = validTarget ? records.filter((record) => Number(record.value) < validTarget.low) : [];
  const above = validTarget ? records.filter((record) => Number(record.value) > validTarget.high) : [];
  const outOfRangeCount = validTarget ? below.length + above.length : null;
  const inRangeCount = validTarget ? records.length - (outOfRangeCount != null ? outOfRangeCount : 0) : null;
  const values = records.map((record) => Number(record.value));
  return {
    count: records.length,
    daysRecorded: currentDays,
    average: currentAverage,
    previousCount: previousRecords.length,
    previousDaysRecorded: previousDays,
    previousAverage,
    delta,
    canCompare,
    records,
    previousRecords,
    currentRange: { startDate: localDateKey(currentStart), endDate: localDateKey(now) },
    previousRange: { startDate: localDateKey(previousStart), endDate: localDateKey(previousEnd) },
    minimum: values.length ? Math.min(...values) : null,
    maximum: values.length ? Math.max(...values) : null,
    target: validTarget,
    targetError,
    below,
    above,
    belowCount: validTarget ? below.length : null,
    aboveCount: validTarget ? above.length : null,
    inRangeCount,
    outOfRangeCount,
    assessedCount: validTarget ? records.length : null,
    inRangePercentage: validTarget && records.length ? (inRangeCount != null ? inRangeCount : 0) / records.length * 100 : null
  };
}
