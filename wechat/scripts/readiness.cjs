const path = require('node:path');
const { inspectConfiguration } = require('./configuration.cjs');
const root = path.resolve(__dirname, '..');
const { complete, missing, errors } = inspectConfiguration(root);
console.log(JSON.stringify({
  configurationComplete: complete,
  externalUnverified: ['AppID developer permission and cloud environment association', 'Cloud deployment, database rules and indexes', 'Two actual WeChat accounts and real-device synchronization'],
  missing,
  configurationErrors: errors,
  next: !complete ? 'Configure the two public IDs and fix configuration errors first. No login, deployment or upload has been attempted.' : 'Public configuration is present only. Verify environment access, deploy and test cloud authorization before uploading.',
}, null, 2));
process.exitCode = complete ? 0 : 2;
