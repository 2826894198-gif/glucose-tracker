'use strict';

const https = require('node:https');
const MAX_BASE64_LENGTH = 4 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const failure = (code, message) => ({ ok: false, error: { code, message } });

function endpointFromEnvironment(env) {
  if (typeof env.OCR_URL !== 'string' || typeof env.OCR_TOKEN !== 'string' || env.OCR_TOKEN.length < 32) return null;
  try {
    const url = new URL(env.OCR_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || (url.port && url.port !== '443')) return null;
    if (url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || /^127\./.test(url.hostname) || url.hostname === '[::1]') return null;
    return url;
  } catch { return null; }
}

function validateImage(image) {
  if (typeof image !== 'string') return null;
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]*={0,2})$/.exec(image);
  if (!match || !match[2] || match[2].length % 4 || match[2].length > MAX_BASE64_LENGTH) return null;
  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length < 12 || bytes.toString('base64') !== match[2]) return null;
  const png = match[1] === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = match[1] === 'image/jpeg' && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const webp = match[1] === 'image/webp' && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  return png || jpeg || webp ? image : null;
}

function postOcr(url, token, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload));
    let request, settled = false;
    const finish = (error, data) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(data);
    };
    const abort = () => {
      const error = Object.assign(new Error('OCR_TIMEOUT'), { code: 'OCR_TIMEOUT' });
      finish(error);
      if (request) request.destroy(error);
    };
    // Socket timeout alone only measures inactivity. Enforce a whole-request
    // deadline too, including DNS/TLS and an upstream that trickles bytes.
    const deadline = setTimeout(abort, 15000);
    try { request = https.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length, Authorization: `Bearer ${token}` },
      timeout: 15000,
    }, response => {
      // Deliberately do not follow redirects: the bearer token stays at the configured endpoint.
      if (response.statusCode !== 200) { finish(Object.assign(new Error('OCR_UPSTREAM'), { code: 'OCR_UPSTREAM' })); response.on('error', () => {}); response.destroy(); return; }
      const chunks = []; let length = 0;
      response.on('data', chunk => { length += chunk.length; if (length > MAX_RESPONSE_BYTES) { finish(Object.assign(new Error('OCR_RESPONSE_TOO_LARGE'), { code: 'OCR_UPSTREAM' })); response.destroy(); } else chunks.push(chunk); });
      response.on('end', () => { try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(Object.assign(new Error('OCR_INVALID_RESPONSE'), { code: 'OCR_UPSTREAM' })); } });
      response.on('aborted', () => finish(Object.assign(new Error('OCR_ABORTED'), { code: 'OCR_UPSTREAM' })));
      response.on('error', error => finish(error));
    });
    request.on('timeout', abort);
    request.on('error', error => finish(error));
    request.end(body);
    } catch (error) { finish(error); }
  });
}

function validObservation(o) {
  return o && typeof o.text === 'string' && o.text.length <= 300 && Number.isFinite(o.confidence) && o.confidence >= 0 && o.confidence <= 1 && o.box && ['x','y','width','height'].every(key => Number.isFinite(o.box[key])) && o.box.width >= 0 && o.box.height >= 0;
}

function createRecognizer({ env = process.env, request = postOcr } = {}) {
  return async function recognize(event, context) {
    if (!context || typeof context.OPENID !== 'string' || !context.OPENID || typeof context.APPID !== 'string' || !context.APPID) return failure('UNAUTHENTICATED', '请先使用本人的微信登录后再识别照片。');
    if (env.EXPECTED_APPID && context.APPID !== env.EXPECTED_APPID) return failure('FORBIDDEN', '当前小程序未获准使用照片识别。');
    if (!event || typeof event !== 'object' || Array.isArray(event) || Object.keys(event).some(key => key !== 'image')) return failure('INVALID_INPUT', '识别请求无效，请重新选择照片或手动输入。');
    const endpoint = endpointFromEnvironment(env);
    if (!endpoint) return failure('OCR_NOT_CONFIGURED', '照片自动识别尚未接通。可以保留照片，对照血糖仪手动输入。');
    const image = validateImage(event.image);
    if (!image) return failure('INVALID_IMAGE', '请选择清晰的 JPG、PNG 或 WebP 照片，图片压缩后需小于3 MB。');
    try {
      const result = await request(endpoint, env.OCR_TOKEN, { image });
      if (!result || !Array.isArray(result.observations) || result.observations.length > 500 || !result.observations.every(validObservation)) return failure('OCR_UNAVAILABLE', '暂时无法读取识别结果，请对照照片手动输入。');
      const { parseReading } = await import('./parse-reading.mjs');
      return { ok: true, data: { ...parseReading(result), engine: 'rapidocr-cloud', processedLocally: false } };
    } catch (error) {
      return error && error.code === 'OCR_TIMEOUT'
        ? failure('OCR_TIMEOUT', '识别等待较久，请重试或对照照片手动输入。')
        : failure('OCR_UNAVAILABLE', '照片识别暂不可用，请重试或手动输入。');
    }
  };
}

module.exports = { createRecognizer, endpointFromEnvironment, validateImage, postOcr, MAX_BASE64_LENGTH };
