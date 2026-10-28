const base = require('./config');
const { createClient } = require('./services/client');
let local = {};
try { local = require('./config.local'); } catch (_) { /* Optional public environment identifiers. */ }

App({
  config: Object.assign({}, base, local),
  globalData: { client: null, configured: false },
  onLaunch() {
    const env = this.config.cloudEnv;
    this.globalData.configured = !!(env && !/^YOUR|REPLACE|example/i.test(env) && wx.cloud);
    if (this.globalData.configured) wx.cloud.init({ env, traceUser: false });
    this.globalData.client = createClient({ wxApi: wx, functionName: this.config.functionName, environmentId: env || 'unconfigured' });
    if (this.globalData.configured && wx.onNeedPrivacyAuthorization) wx.onNeedPrivacyAuthorization(resolve => {
      this._privacyResolve = resolve;
      const pages = getCurrentPages();
      if (pages.length) pages[pages.length - 1].setData({ privacyOpen: true });
    });
    this._networkHandler = state => {
      if (state.isConnected && this.globalData.client.getSnapshot().authenticated) this.globalData.client.sync();
    };
    wx.onNetworkStatusChange(this._networkHandler);
  },
  onShow() {
    const client = this.globalData.client;
    if (client && client.getSnapshot().authenticated) client.sync();
  },
});
