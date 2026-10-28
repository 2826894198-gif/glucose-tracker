/** Interpret OCR observations conservatively. This module never invents digits or units. */
const UNIT_PATTERNS = [
  { unit: 'mmol/L', pattern: /mmol\s*[\/／]\s*l/iu },
  { unit: 'mg/dL', pattern: /mg\s*[\/／]\s*dl/iu },
];

const normalize = (text) => String(text ?? '').normalize('NFKC').trim();
const center = (box) => ({ x: box.x + box.width / 2, y: box.y + box.height / 2 });
const unitFromText = (text) => UNIT_PATTERNS.find(({ pattern }) => pattern.test(text))?.unit ?? null;
const prohibitedContext = /(?:\b(?:err(?:or)?|code|date|time|year|month|day|hour|minute|sec|memory|mem)\b|错误|代码|日期|时间|年|月|日|时|分)/iu;

function extractNumeric(text) {
  if (prohibitedContext.test(text) || /\d\s*[:／/]\s*\d/u.test(text) || /\d\s*-\s*\d/u.test(text)) return [];
  // Strip a recognized unit, not arbitrary words. A bare reading must be a whole OCR token.
  let stripped = text;
  for (const { pattern } of UNIT_PATTERNS) stripped = stripped.replace(pattern, ' ');
  stripped = stripped.replace(/\b(?:glucose|blood|血糖)\b/giu, ' ').trim();
  const pieces = stripped.split(/\s+/u).filter(Boolean);
  return pieces.filter((piece) => /^\d{1,3}(?:[.,]\d{1,2})?$/u.test(piece))
    .map((piece) => piece.replace(',', '.'));
}

function association(observation, unitObservation) {
  const a = center(observation.box);
  const b = center(unitObservation.box);
  const horizontalOverlap = Math.max(0, Math.min(observation.box.x + observation.box.width, unitObservation.box.x + unitObservation.box.width) - Math.max(observation.box.x, unitObservation.box.x));
  const dy = Math.abs(a.y - b.y);
  const dx = Math.abs(a.x - b.x);
  // The printed unit must be on the reading line or close below/above it.
  if (dy > Math.max(0.22, observation.box.height * 2.5)) return null;
  if (dx > 0.5 && horizontalOverlap === 0) return null;
  return Math.max(0, 1 - dy * 2 - dx * 0.5);
}

export function parseReading(output) {
  const observations = (Array.isArray(output?.observations) ? output.observations : [])
    .filter((o) => o && typeof o.text === 'string' && Number.isFinite(o.confidence) && o.box && ['x','y','width','height'].every((k) => Number.isFinite(o.box[k])))
    .map((o) => ({ ...o, text: normalize(o.text) }));
  const rawText = observations.map((o) => o.text).join('\n').slice(0, 8000);
  const units = observations.map((o) => ({ ...o, unit: unitFromText(o.text) })).filter((o) => o.unit);
  const candidates = [];
  const specials = [];
  for (const observation of observations) {
    const localUnit = unitFromText(observation.text);
    const nearby = units.map((u) => ({ unit: u.unit, affinity: association(observation, u), confidence: u.confidence }))
      .filter((u) => u.affinity !== null).sort((a,b) => b.affinity - a.affinity);
    const unit = localUnit ?? nearby[0]?.unit ?? null;
    const specialText = observation.text.replace(/\s+/gu, '').toUpperCase();
    if (/^(?:HI|LO)$/u.test(specialText)) {
      specials.push({ special: specialText, confidence: observation.confidence, unit, height: observation.box.height });
      continue;
    }
    for (const value of extractNumeric(observation.text)) {
      const number = Number(value);
      if (!Number.isFinite(number) || number <= 0) continue;
      // Unit-specific format checks only; no "normal" or clinical range is assumed.
      if (unit === 'mg/dL' && value.includes('.')) continue;
      if (unit === 'mmol/L' && number >= 100) continue;
      const score = observation.confidence * 0.45 + Math.min(observation.box.height * 3, 0.3) + (unit ? 0.2 : 0) + (value.includes('.') ? 0.05 : 0);
      candidates.push({ value, unit, confidence: Math.min(observation.confidence, localUnit ? observation.confidence : (nearby[0]?.confidence ?? observation.confidence)), score, box: observation.box });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  const deduped = candidates.filter((candidate, index) => candidates.findIndex((c) => c.value === candidate.value && c.unit === candidate.unit) === index);
  const special = specials.sort((a,b) => (b.height + b.confidence) - (a.height + a.confidence))[0];
  if (special && (!deduped.length || special.height > deduped[0].box.height * 1.5)) {
    return { value: null, unit: special.unit, special: special.special, confidence: special.confidence, rawText, candidates: [], warning: '仪器显示特殊读数，请核对原屏幕；不会转换为数字。' };
  }
  const best = deduped[0];
  if (!best || best.confidence < 0.35) return { value: null, unit: units[0]?.unit ?? null, confidence: 0, rawText, candidates: [], warning: '没有找到清晰的血糖数值，请重拍或手动输入。' };
  const ambiguous = deduped[1] && best.value !== deduped[1].value && Math.abs(best.score - deduped[1].score) < 0.045;
  if (ambiguous) return { value: null, unit: best.unit, confidence: best.confidence, rawText, candidates: deduped.slice(0, 4).map(({value,unit,confidence}) => ({value,unit,confidence})), warning: '照片中有多个相近的数字，请对照屏幕手动核对。' };
  // No decimal insertion, OCR-character substitution or unit defaulting is performed here.
  return { value: best.value, unit: best.unit, confidence: best.confidence, rawText, candidates: deduped.slice(0, 4).map(({value,unit,confidence}) => ({value,unit,confidence})), ...(best.unit ? {} : { warning: '未识别到单位，请核对并选择血糖仪使用的单位。' }) };
}
