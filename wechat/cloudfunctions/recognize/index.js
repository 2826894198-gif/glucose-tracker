'use strict';

const cloud = require('wx-server-sdk');
const { createHash } = require('node:crypto');
const { createRecognizer } = require('./service');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const recognize = createRecognizer();

// Keep this namespace identical to glucose/service.cjs. The supplied expected
// account is only a precondition; only trusted WeChat context chooses identity.
const accountKey = context => createHash('sha256').update(`glucose-account-v1\0${context.APPID}\0${context.OPENID}`).digest('hex');
const failure = (code, message) => ({ ok: false, error: { code, message } });

exports.main = async event => {
  const context = cloud.getWXContext();
  if (!context || typeof context.OPENID !== 'string' || !context.OPENID || context.OPENID.length > 128 ||
      typeof context.APPID !== 'string' || !/^wx[a-zA-Z0-9]{16}$/.test(context.APPID)) {
    return failure('UNAUTHENTICATED', '请先使用本人的微信登录后再识别照片。');
  }
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return failure('INVALID_INPUT', '识别请求无效，请重新选择照片或手动输入。');
  }
  // Validate before touching the image or invoking its decoder/external OCR.
  if (event.expectedAccountId !== accountKey(context)) {
    return failure('ACCOUNT_CHANGED', '微信账号身份已变化，照片尚未识别，请重新确认登录后再试。');
  }
  const { expectedAccountId: _scopeAssertion, userInfo: _untrustedUserInfo, tcbContext: _untrustedCloudContext, ...request } = event;
  return recognize(request, context);
};
