export type GlucoseUnit = 'mmol/L' | 'mg/dL'
export type MeasurementMoment = 'fasting' | 'before' | 'after' | 'bedtime' | 'other'
export type RecordSource = 'manual' | 'photo'

export interface GlucoseRecord {
  id: string
  value: string
  unit: GlucoseUnit
  moment: MeasurementMoment
  afterMinutes?: number
  measuredAt: string
  createdAt: string
  updatedAt: string
  note: string
  source: RecordSource
  deletedAt?: string
}

export interface RecordInput {
  value: string
  unit: GlucoseUnit | ''
  moment: MeasurementMoment | ''
  afterMinutes?: number
  measuredAt: string
  note?: string
  source?: RecordSource
}

export interface ValidatedRecordInput extends Omit<RecordInput, 'unit' | 'moment' | 'note' | 'source'> {
  unit: GlucoseUnit
  moment: MeasurementMoment
  note: string
  source: RecordSource
}

export type DataResult<T> = { ok: true; data: T } | { ok: false; error: string }
export type RecordStore = Pick<Storage, 'getItem' | 'setItem'>

/** Separate from every legacy app key. This preview stores only in this browser. */
export const STORAGE_KEY = 'family-glucose-preview:personal:v1'
export const MOMENT_LABELS: Record<MeasurementMoment, string> = {
  fasting: '空腹', before: '餐前', after: '餐后', bedtime: '睡前', other: '其他 / 不确定',
}
const MOMENTS = Object.keys(MOMENT_LABELS) as MeasurementMoment[]
const UNITS: GlucoseUnit[] = ['mmol/L', 'mg/dL']
const pad = (value: number) => String(value).padStart(2, '0')

export function localDateKey(value: Date | string = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function toLocalDateTimeInput(value: Date | string = new Date()): string {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  return `${localDateKey(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Returns an ISO instant, or an empty string for invalid/rollover local dates. */
export function fromLocalDateTimeInput(value: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (!parts) return ''
  const [, year, month, day, hour, minute, second = '0'] = parts
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second))
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day) || date.getHours() !== Number(hour) ||
      date.getMinutes() !== Number(minute) || date.getSeconds() !== Number(second)) return ''
  return date.toISOString()
}

export function momentLabel(record: Pick<GlucoseRecord, 'moment' | 'afterMinutes'>): string {
  if (record.moment !== 'after' || record.afterMinutes === undefined) return MOMENT_LABELS[record.moment]
  const minutes = record.afterMinutes
  return minutes % 60 === 0 ? `餐后${minutes / 60}小时` : `餐后${minutes}分钟`
}

function normalizeValue(value: string): string | null {
  const normalized = value.trim().replace(/[０-９]/g, (character) => String(character.charCodeAt(0) - 0xff10))
    .replace(/[．，,]/g, '.')
  // Structural limits only; these are not clinical thresholds. Never infer a missing decimal point.
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(normalized) || Number(normalized) <= 0) return null
  return normalized.replace(/^0+(?=\d)/, '')
}

export function validateRecordInput(input: RecordInput, now: Date = new Date()): DataResult<ValidatedRecordInput> {
  const value = normalizeValue(input.value)
  if (value === null) return { ok: false, error: '请输入大于 0 的血糖数值，最多保留两位小数。HI、LO 或错误码请勿填为数字。' }
  if (!UNITS.includes(input.unit as GlucoseUnit)) return { ok: false, error: '请核对并选择血糖仪显示的单位。' }
  if (!MOMENTS.includes(input.moment as MeasurementMoment)) return { ok: false, error: '请选择测量时机；不确定时可选“其他 / 不确定”。' }
  if (input.moment === 'after' && input.afterMinutes !== undefined &&
      (!Number.isInteger(input.afterMinutes) || input.afterMinutes <= 0 || input.afterMinutes > 1440)) {
    return { ok: false, error: '请填写正确的餐后间隔分钟数，或暂不填写。' }
  }
  const localInput = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(input.measuredAt)
  const measuredAt = localInput ? fromLocalDateTimeInput(input.measuredAt) : input.measuredAt
  const date = new Date(measuredAt)
  if (!measuredAt || !Number.isFinite(date.getTime())) return { ok: false, error: '请填写有效的测量日期和时间。' }
  if (date.getTime() > now.getTime() + 5 * 60_000) return { ok: false, error: '测量时间晚于现在，请核对实际测量时间。' }
  const note = (input.note ?? '').trim()
  if (note.length > 2000) return { ok: false, error: '备注请控制在 2000 字以内。' }
  if (input.source !== undefined && input.source !== 'manual' && input.source !== 'photo') return { ok: false, error: '记录来源无效。' }
  return { ok: true, data: {
    value, unit: input.unit as GlucoseUnit, moment: input.moment as MeasurementMoment,
    ...(input.moment === 'after' && input.afterMinutes !== undefined ? { afterMinutes: input.afterMinutes } : {}),
    measuredAt: date.toISOString(), note, source: input.source ?? 'manual',
  } }
}

function validInstant(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && Number.isFinite(new Date(value).getTime())
}

function isRecord(value: unknown): value is GlucoseRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Partial<GlucoseRecord>
  return typeof record.id === 'string' && record.id.length > 0 && typeof record.value === 'string' &&
    normalizeValue(record.value) !== null && UNITS.includes(record.unit as GlucoseUnit) &&
    MOMENTS.includes(record.moment as MeasurementMoment) && typeof record.note === 'string' &&
    (record.source === 'manual' || record.source === 'photo') && validInstant(record.measuredAt) &&
    validInstant(record.createdAt) && validInstant(record.updatedAt) &&
    (record.deletedAt === undefined || validInstant(record.deletedAt)) &&
    (record.afterMinutes === undefined || (Number.isInteger(record.afterMinutes) && record.afterMinutes > 0 && record.afterMinutes <= 1440))
}

function getStore(store?: RecordStore): RecordStore {
  if (store) return store
  if (typeof window === 'undefined') throw new Error('storage unavailable')
  return window.localStorage
}

/** Stable IDs make retries idempotent. Duplicate IDs use the most recently updated record. */
function deduplicate(records: GlucoseRecord[]): GlucoseRecord[] {
  const byId = new Map<string, GlucoseRecord>()
  for (const record of records) {
    const previous = byId.get(record.id)
    if (!previous || new Date(record.updatedAt).getTime() >= new Date(previous.updatedAt).getTime()) byId.set(record.id, record)
  }
  return [...byId.values()].sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
}

export function loadRecords(store?: RecordStore): DataResult<GlucoseRecord[]> {
  try {
    const saved = getStore(store).getItem(STORAGE_KEY)
    if (saved === null) return { ok: true, data: [] }
    const parsed: unknown = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1 ||
        !Array.isArray((parsed as { records?: unknown }).records)) {
      return { ok: false, error: '本机记录格式异常，已保留原数据，请先导出备份后检查。' }
    }
    const records = (parsed as { records: unknown[] }).records
    if (!records.every(isRecord)) return { ok: false, error: '本机记录中存在无法读取的条目，已保留原数据，请勿清空。' }
    return { ok: true, data: deduplicate(records) }
  } catch {
    return { ok: false, error: '暂时无法读取本机记录。请检查浏览器存储权限，原有数据不会被覆盖。' }
  }
}

export function persistRecords(records: GlucoseRecord[], store?: RecordStore): DataResult<GlucoseRecord[]> {
  if (!records.every(isRecord)) return { ok: false, error: '记录格式无效，尚未保存，请核对输入。' }
  try {
    const normalized = deduplicate(records)
    getStore(store).setItem(STORAGE_KEY, JSON.stringify({ version: 1, records: normalized }))
    return { ok: true, data: normalized }
  } catch {
    return { ok: false, error: '本机保存失败，输入内容仍保留在页面中。请检查存储空间或浏览器权限后重试。' }
  }
}

export function saveRecord(record: GlucoseRecord, store?: RecordStore): DataResult<GlucoseRecord[]> {
  const existing = loadRecords(store)
  if (!existing.ok) return existing
  return persistRecords([...existing.data.filter((entry) => entry.id !== record.id), record], store)
}

export function deleteRecord(id: string, store?: RecordStore, now: Date = new Date()): DataResult<GlucoseRecord[]> {
  const existing = loadRecords(store)
  if (!existing.ok) return existing
  if (!existing.data.some((record) => record.id === id)) return { ok: false, error: '这条记录已不存在，请刷新后重试。' }
  const stamp = now.toISOString()
  return persistRecords(existing.data.map((record) => record.id === id ? { ...record, deletedAt: stamp, updatedAt: stamp } : record), store)
}

export function restoreRecord(id: string, store?: RecordStore, now: Date = new Date()): DataResult<GlucoseRecord[]> {
  const existing = loadRecords(store)
  if (!existing.ok) return existing
  if (!existing.data.some((record) => record.id === id && record.deletedAt)) return { ok: false, error: '没有找到可恢复的记录。' }
  return persistRecords(existing.data.map((record) => {
    if (record.id !== id) return record
    const { deletedAt: _deletedAt, ...rest } = record
    return { ...rest, updatedAt: now.toISOString() }
  }), store)
}

export function activeRecords(records: GlucoseRecord[]): GlucoseRecord[] {
  return records.filter((record) => !record.deletedAt).sort((a, b) => new Date(b.measuredAt).getTime() - new Date(a.measuredAt).getTime())
}

/** Fictional sample data: caller must label it as a demo and opt in explicitly. */
export function buildSeedRecords(anchorDate: Date = new Date()): GlucoseRecord[] {
  const fasting = ['6.4', '6.0', '6.3', '6.1', '6.2', '6.4', '6.1']
  const records: GlucoseRecord[] = []
  for (let index = 0; index < 7; index += 1) {
    const measured = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), anchorDate.getDate() - 6 + index, 7, 10)
    const dateKey = localDateKey(measured)
    const add = (value: string, moment: MeasurementMoment, date: Date) => {
      const stamp = date.toISOString()
      records.push({ id: `demo-${dateKey}-${moment}`, value, unit: 'mmol/L', moment,
        ...(moment === 'after' ? { afterMinutes: 120 } : {}), measuredAt: stamp,
        createdAt: stamp, updatedAt: stamp, note: '演示记录', source: 'manual' })
    }
    add(fasting[index], 'fasting', measured)
    if (index % 2 === 0) {
      const after = new Date(measured)
      after.setHours(9, 20, 0, 0)
      add(index === 6 ? '7.6' : ['7.8', '7.4', '7.9'][index / 2], 'after', after)
    }
  }
  return activeRecords(records)
}

export interface TrendSample {
  id: string
  measuredAt: string
  dateKey: string
  value: number
  record: GlucoseRecord
}
export interface TrendDay {
  dateKey: string
  label: string
  /** Daily mean when multiple samples exist; show count and mark the aggregation in UI. */
  value: number | null
  count: number
  samples: TrendSample[]
}
export interface TrendOptions {
  days: 7 | 30
  moment: MeasurementMoment
  unit: GlucoseUnit
  /** An omitted interval matches only unspecified post-meal intervals, never mixes them with 120min. */
  afterMinutes?: number
  anchorDate?: Date
}

export function getTrendSeries(records: GlucoseRecord[], options: TrendOptions): { days: TrendDay[]; samples: TrendSample[]; count: number } {
  const anchor = options.anchorDate ?? new Date()
  const days: TrendDay[] = Array.from({ length: options.days }, (_, index) => {
    const date = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - options.days + 1 + index)
    return { dateKey: localDateKey(date), label: `${date.getMonth() + 1}/${date.getDate()}`, value: null, count: 0, samples: [] }
  })
  const byDay = new Map(days.map((day) => [day.dateKey, day]))
  const samples: TrendSample[] = []
  for (const record of activeRecords(records).reverse()) {
    if (record.moment !== options.moment || record.unit !== options.unit ||
        (record.moment === 'after' && record.afterMinutes !== options.afterMinutes)) continue
    const dateKey = localDateKey(record.measuredAt)
    const day = byDay.get(dateKey)
    if (!day) continue
    const sample: TrendSample = { id: record.id, measuredAt: record.measuredAt, dateKey, value: Number(record.value), record }
    day.samples.push(sample)
    samples.push(sample)
  }
  for (const day of days) {
    day.count = day.samples.length
    day.value = day.count ? day.samples.reduce((total, sample) => total + sample.value, 0) / day.count : null
  }
  return { days, samples, count: samples.length }
}

function csvCell(value: string | number): string {
  const text = String(value)
  // Spreadsheet programs can execute formulas even inside quoted CSV cells.
  const escaped = /^[\t\r\n]/.test(text) || /^\s*[=+\-@]/.test(text) ? `'${text}` : text
  return `"${escaped.replace(/"/g, '""')}"`
}

export function recordsToCsv(records: GlucoseRecord[]): string {
  const header = ['测量时间（ISO 8601）', '血糖数值', '单位', '测量时机', '餐后间隔（分钟）', '备注', '录入方式']
  const rows = activeRecords(records).map((record) => [record.measuredAt, record.value, record.unit,
    momentLabel(record), record.afterMinutes ?? '', record.note, record.source === 'photo' ? '拍照' : '手动'])
  return '\uFEFF' + [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')
}

export function recordsToJson(records: GlucoseRecord[], now: Date = new Date()): string {
  return JSON.stringify({ version: 1, exportedAt: now.toISOString(), records: activeRecords(records) }, null, 2)
}
