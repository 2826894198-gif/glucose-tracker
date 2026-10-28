import { activeRecords, localDateKey, type DataResult, type GlucoseRecord, type GlucoseUnit, type MeasurementMoment, type RecordStore } from './data'

export interface TargetRange {
  low: number
  high: number
  unit: GlucoseUnit
  updatedAt: string
}
export interface TargetContext {
  moment: MeasurementMoment
  unit: GlucoseUnit
  /** Analysis defaults to the explicitly recorded 120-minute post-meal group. */
  afterMinutes?: number
}
export interface TargetRangeInput {
  low: string | number
  high: string | number
  unit: GlucoseUnit | ''
}
export type TargetRanges = Record<string, TargetRange>
export const TARGET_STORAGE_KEY = 'family-glucose-preview:targets:v1'

export interface InsightOptions extends TargetContext {
  days: 7 | 30
  now?: Date
  target?: TargetRange | null
}
export interface InsightDateRange { startDate: string; endDate: string }
export interface InsightSummary {
  count: number
  daysRecorded: number
  /** Arithmetic mean of the recorded readings, not a daily-weighted or continuous-time mean. */
  average: number | null
  previousCount: number
  previousDaysRecorded: number
  previousAverage: number | null
  /** Current minus previous mean; absent unless both periods have at least 3 readings on 3 days. */
  delta: number | null
  canCompare: boolean
  records: GlucoseRecord[]
  previousRecords: GlucoseRecord[]
  currentRange: InsightDateRange
  previousRange: InsightDateRange
  minimum: number | null
  maximum: number | null
  target: TargetRange | null
  targetError: string
  below: GlucoseRecord[]
  above: GlucoseRecord[]
  belowCount: number | null
  aboveCount: number | null
  inRangeCount: number | null
  outOfRangeCount: number | null
  /** Only recorded readings are assessed. This denominator is never elapsed time. */
  assessedCount: number | null
  inRangePercentage: number | null
}

const units: GlucoseUnit[] = ['mmol/L', 'mg/dL']
const moments: MeasurementMoment[] = ['fasting', 'before', 'after', 'bedtime', 'other']
const error = <T>(message: string): DataResult<T> => ({ ok: false, error: message })
const validInterval = (value: unknown): value is number => Number.isInteger(value) && Number(value) > 0 && Number(value) <= 1440

export function targetKey(context: TargetContext): string {
  if (!moments.includes(context.moment) || !units.includes(context.unit)) throw new RangeError('目标的测量时机或单位无效。')
  if (context.moment !== 'after') return `${context.moment}:${context.unit}`
  const minutes = context.afterMinutes ?? 120
  if (!validInterval(minutes)) throw new RangeError('餐后间隔应为 1 至 1440 分钟。')
  return `after:${minutes}:${context.unit}`
}

function parseBound(value: string | number): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const text = String(value).trim().replace(/[０-９]/g, character => String(character.charCodeAt(0) - 0xff10)).replace(/[．，,]/g, '.')
  // Structural validation only. These are not treatment targets or clinical limits.
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(text)) return null
  const number = Number(text)
  return Number.isFinite(number) && number > 0 ? number : null
}

export function validateTargetRange(input: TargetRangeInput, now: Date = new Date()): DataResult<TargetRange> {
  const low = parseBound(input.low), high = parseBound(input.high)
  if (low === null || high === null) return error('请输入大于 0 的目标下限和上限，最多保留两位小数。')
  if (!units.includes(input.unit as GlucoseUnit)) return error('请选择目标范围使用的单位。')
  if (low >= high) return error('目标下限需要小于上限，请核对后再保存。')
  if (!Number.isFinite(now.getTime())) return error('目标更新时间无效，尚未保存。')
  return { ok: true, data: { low, high, unit: input.unit as GlucoseUnit, updatedAt: now.toISOString() } }
}

function storedTarget(value: unknown): value is TargetRange {
  if (!value || typeof value !== 'object') return false
  const range = value as Partial<TargetRange>
  return typeof range.low === 'number' && typeof range.high === 'number' &&
    parseBound(range.low) !== null && parseBound(range.high) !== null && range.low < range.high &&
    units.includes(range.unit as GlucoseUnit) && typeof range.updatedAt === 'string' &&
    range.updatedAt.length > 0 && Number.isFinite(new Date(range.updatedAt).getTime())
}

function validStoredKey(key: string, range: TargetRange): boolean {
  const parts = key.split(':')
  if (parts[0] === 'after') {
    return parts.length === 3 && /^\d{1,4}$/.test(parts[1]) && validInterval(Number(parts[1])) &&
      String(Number(parts[1])) === parts[1] && parts[2] === range.unit
  }
  return parts.length === 2 && moments.includes(parts[0] as MeasurementMoment) && parts[0] !== 'after' && parts[1] === range.unit
}

function getStore(store?: RecordStore): RecordStore {
  if (store) return store
  if (typeof window === 'undefined') throw new Error('storage unavailable')
  return window.localStorage
}

export function loadTargetRanges(store?: RecordStore): DataResult<TargetRanges> {
  try {
    const saved = getStore(store).getItem(TARGET_STORAGE_KEY)
    if (saved === null) return { ok: true, data: {} }
    const parsed: unknown = JSON.parse(saved)
    if (!parsed || typeof parsed !== 'object' || (parsed as { version?: unknown }).version !== 1) return error('本机目标设置格式异常，原设置已保留，请勿清空。')
    const ranges = (parsed as { ranges?: unknown }).ranges
    if (!ranges || typeof ranges !== 'object' || Array.isArray(ranges)) return error('本机目标设置无法读取，原设置已保留。')
    for (const [key, value] of Object.entries(ranges)) {
      if (!storedTarget(value) || !validStoredKey(key, value)) return error('本机目标设置存在无效条目，原设置已保留。')
    }
    return { ok: true, data: ranges as TargetRanges }
  } catch { return error('暂时无法读取本机目标设置，请检查浏览器存储权限。原设置不会被覆盖。') }
}

function persistTargets(ranges: TargetRanges, store?: RecordStore): DataResult<TargetRanges> {
  try {
    getStore(store).setItem(TARGET_STORAGE_KEY, JSON.stringify({ version: 1, ranges }))
    return { ok: true, data: ranges }
  } catch { return error('目标保存失败，请检查本机存储空间或浏览器权限后重试。') }
}

export function saveTargetRange(context: TargetContext, input: TargetRangeInput, store?: RecordStore, now: Date = new Date()): DataResult<TargetRanges> {
  let key: string
  try { key = targetKey(context) } catch { return error('目标的测量时机、餐后间隔或单位无效。') }
  const validated = validateTargetRange(input, now)
  if (!validated.ok) return validated
  if (validated.data.unit !== context.unit) return error('目标单位与当前查看单位不一致，请核对后再保存。')
  const existing = loadTargetRanges(store)
  if (!existing.ok) return existing
  return persistTargets({ ...existing.data, [key]: validated.data }, store)
}

export function removeTargetRange(context: TargetContext, store?: RecordStore): DataResult<TargetRanges> {
  let key: string
  try { key = targetKey(context) } catch { return error('目标的测量时机、餐后间隔或单位无效。') }
  const existing = loadTargetRanges(store)
  if (!existing.ok) return existing
  const ranges = { ...existing.data }
  delete ranges[key]
  return persistTargets(ranges, store)
}

function average(records: GlucoseRecord[]): number | null {
  return records.length ? records.reduce((sum, record) => sum + Number(record.value), 0) / records.length : null
}

function daysRecorded(records: GlucoseRecord[]): number {
  return new Set(records.map(record => localDateKey(record.measuredAt))).size
}

function uniqueActiveRecords(input: GlucoseRecord[]): GlucoseRecord[] {
  // A newer tombstone must win over an older duplicate, before active-record filtering.
  const byId = new Map<string, GlucoseRecord>()
  for (const record of input) {
    const previous = byId.get(record.id)
    if (!previous || new Date(record.updatedAt).getTime() >= new Date(previous.updatedAt).getTime()) byId.set(record.id, record)
  }
  return activeRecords([...byId.values()])
}

/**
 * Independent low-reading review, across measurement contexts and original units.
 * ADA Standards of Care 2026, section 6: below 3.9 mmol/L or below 70 mg/dL.
 * https://diabetesjournals.org/care/article/49/Supplement_1/S132/163927/6-Glycemic-Goals-Hypoglycemia-and-Hyperglycemic
 * This list is not a diagnosis, emergency monitoring system, or treatment instruction.
 * Personal target changes must not disable it.
 */
export function findLowReadings(input: GlucoseRecord[], options: { days: 7 | 30; now?: Date }): GlucoseRecord[] {
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime()) || (options.days !== 7 && options.days !== 30)) throw new RangeError('分析时间范围无效。')
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.days + 1)
  return uniqueActiveRecords(input).filter(record => {
    const time = new Date(record.measuredAt).getTime(), value = Number(record.value)
    return Number.isFinite(time) && time >= start.getTime() && time <= now.getTime() &&
      Number.isFinite(value) && value > 0 &&
      ((record.unit === 'mmol/L' && value < 3.9) || (record.unit === 'mg/dL' && value < 70))
  })
}

/** Describes sampled records only. It does not infer disease, causes, treatment, TIR, or HbA1c. */
export function buildInsights(input: GlucoseRecord[], options: InsightOptions): InsightSummary {
  const now = options.now ?? new Date()
  if (!Number.isFinite(now.getTime()) || (options.days !== 7 && options.days !== 30)) throw new RangeError('分析时间范围无效。')
  targetKey(options)
  const currentStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.days + 1)
  const previousStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() - options.days * 2 + 1)
  const previousEnd = new Date(currentStart.getFullYear(), currentStart.getMonth(), currentStart.getDate() - 1)
  const interval = options.moment === 'after' ? options.afterMinutes ?? 120 : undefined

  const relevant = uniqueActiveRecords(input).filter(record => {
    const time = new Date(record.measuredAt).getTime()
    return record.moment === options.moment && record.unit === options.unit &&
      (record.moment !== 'after' || record.afterMinutes === interval) &&
      Number.isFinite(time) && time <= now.getTime() && Number.isFinite(Number(record.value)) && Number(record.value) > 0
  })
  const records = relevant.filter(record => new Date(record.measuredAt).getTime() >= currentStart.getTime())
  const previousRecords = relevant.filter(record => {
    const time = new Date(record.measuredAt).getTime()
    return time >= previousStart.getTime() && time < currentStart.getTime()
  })
  const currentAverage = average(records), previousAverage = average(previousRecords)
  const currentDays = daysRecorded(records), previousDays = daysRecorded(previousRecords)
  const canCompare = records.length >= 3 && previousRecords.length >= 3 && currentDays >= 3 && previousDays >= 3
  const delta = canCompare && currentAverage !== null && previousAverage !== null ? currentAverage - previousAverage : null
  const validTarget = options.target && storedTarget(options.target) && options.target.unit === options.unit ? options.target : null
  const targetError = options.target && !validTarget ? '当前目标范围或单位无效，暂不判断范围内外。' : ''
  const below = validTarget ? records.filter(record => Number(record.value) < validTarget.low) : []
  const above = validTarget ? records.filter(record => Number(record.value) > validTarget.high) : []
  const outOfRangeCount = validTarget ? below.length + above.length : null
  const inRangeCount = validTarget ? records.length - (outOfRangeCount ?? 0) : null
  const values = records.map(record => Number(record.value))
  return {
    count: records.length, daysRecorded: currentDays, average: currentAverage,
    previousCount: previousRecords.length, previousDaysRecorded: previousDays, previousAverage,
    delta, canCompare, records, previousRecords,
    currentRange: { startDate: localDateKey(currentStart), endDate: localDateKey(now) },
    previousRange: { startDate: localDateKey(previousStart), endDate: localDateKey(previousEnd) },
    minimum: values.length ? Math.min(...values) : null, maximum: values.length ? Math.max(...values) : null,
    target: validTarget, targetError, below, above,
    belowCount: validTarget ? below.length : null, aboveCount: validTarget ? above.length : null,
    inRangeCount, outOfRangeCount, assessedCount: validTarget ? records.length : null,
    inRangePercentage: validTarget && records.length ? (inRangeCount ?? 0) / records.length * 100 : null,
  }
}
