'use strict';

const cloud = require('wx-server-sdk');
const { createRepository } = require('./repository.cjs');
const { createService } = require('./service.cjs');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const service = createService({ repository: createRepository(cloud.database()), allowedAppId: process.env.GLUCOSE_ALLOWED_APP_ID || '' });

exports.main = async event => service(event, cloud.getWXContext());
