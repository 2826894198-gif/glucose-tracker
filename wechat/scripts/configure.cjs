const path = require('node:path');
const { parseConfigureArgs, configure } = require('./configuration.cjs');
const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  console.log('npm run configure -- --appid wx... --env cloud-environment-id\n只写入公开标识；不登录、不部署、不购买服务。');
} else {
  try {
    configure(root, parseConfigureArgs(args));
    console.log('Configured dedicated public AppID and cloud environment. No credentials stored.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
