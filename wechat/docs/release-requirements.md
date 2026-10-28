# 微信体验版接通条件与本机工具核查

核查日期：2026-10-23。这里只记录已查证条件，不将本地代码或浏览器预览称为已上传的体验版。

## 已确认

- 本机已安装微信开发者工具 `2.01.2510290`，版本来自应用 Info.plist。
- CLI 路径：`/Applications/wechatwebdevtools.app/Contents/MacOS/cli`。
- 已运行 `--help`、`open --help`、`preview --help`、`upload --help`、`cloud env list --help`、`cloud functions deploy --help`；命令入口可执行。本次核查未登录、未上传、未开通收费服务。
- 开始核查时，本项目未找到已有 `project.config.json`、真实 AppID 或云环境配置；后续新增模板不能当成已有真实账号配置。

## 最短接通路径

1. 用小程序管理员/有开发权限的微信完成开发者工具登录，确认本项目的真实 AppID。
2. 确认该 AppID 已关联可用的微信云开发环境，填入环境 ID。是否有配额或需付费以账号控制台为准，本次不擅自购买。
3. 在云数据库建立本项目集合与索引，采用管理员/云函数访问模式；客户端不能直接读写健康记录。具体集合和规则以 `cloud-security.md` 为准。
4. 部署 `glucose` 云函数并完成两个不同微信账号的隔离验证；再上传小程序代码。照片识别如果未配生产服务，应显示未配置并保留手输，不能指向开发电脑 localhost。
5. 在微信公众平台的版本管理中将上传开发版本设为体验版，并添加父母为体验成员。临时 preview 二维码与后台配置好的体验版是不同交付物。
6. 父母分别用自己的微信扫码验证新增、重开恢复、断网后补传、改错、删除恢复与跨账号不可见，再进行日常试用。

其中 AppID、云环境与账号权限是部署输入；管理员扫码、平台条款/购买确认及父母的体验成员信息不能由代码捏造。代码、测试、部署脚本和待上传项目可提前准备完成。

## 本机 CLI 命令模板

以下命令格式来自本机实际 `--help`。替换真实配置后执行，不在命令行打印密钥。

```sh
/Applications/wechatwebdevtools.app/Contents/MacOS/cli open --project /path/to/glucose-tracker/wechat

/Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud env list --project /path/to/glucose-tracker/wechat

/Applications/wechatwebdevtools.app/Contents/MacOS/cli cloud functions deploy --env REAL_ENV_ID --names glucose --project /path/to/glucose-tracker/wechat

/Applications/wechatwebdevtools.app/Contents/MacOS/cli preview --project /path/to/glucose-tracker/wechat --qr-format image --qr-output /private/tmp/glucose-preview.jpg

/Applications/wechatwebdevtools.app/Contents/MacOS/cli upload --project /path/to/glucose-tracker/wechat --version 0.1.0 --desc '家人血糖本：本人登录、数据隔离与云端保存'
```

优先执行 `npm run deploy`：它先核验公开配置、安装并校验锁定依赖、运行测试，再调用 CLI。上述直接 CLI 命令不执行这些前置步骤；不要添加 `--remote-npm-install` 使已核验的本地依赖被远端未知安装器替换。

CLI 使用当前开发者工具的正常登录权限。若服务端口关闭，应由用户在工具中允许该工具的服务端口；不修改账号安全设置来绕过权限。

本机还附带 WXML/WXSS 编译器，可用于不涉及云端账号的本地构建检查：

- `/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec/wcc`
- `/Applications/wechatwebdevtools.app/Contents/Resources/package.nw/node_modules/wcc-exec/wcsc`

它们的存在不是云端部署成功证据。

## CI 可选路径

官方 `miniprogram-ci` 支持代码预览、上传及云函数上传。它需要真实 AppID、管理员下载的代码上传密钥、符合配置的 IP 白名单。首版优先使用已登录开发者工具，避免额外收集 CI 私钥。若采用 CI，私钥仅留在用户本机忽略目录或 CI secret，不能提交仓库、放进客户端或输出到聊天。[微信官方 miniprogram-ci 文档](https://github.com/wechat-miniprogram/miniprogram-ci-dist/blob/master/README.md)

## 类目与隐私的账号侧确认

本轮无法从可读取的微信官方类目资料确认“个人主体血糖记录工具”在当前账号可选哪一类，因此不承诺一定允许或一概禁止。应在真实小程序后台按实际功能核对可选类目；当前产品只做本人记录与描述性回看，不提供诊断、处方、在线问诊或医疗器械销售。不要为通过审核虚报功能或类目，也不要因未核实的传闻停掉独立可完成的代码工作。

云端保存前，界面应说明处理哪些记录、用途与保存位置；相机/相册接口需配合微信平台隐私授权。微信官方 API 类型说明确认 `wx.getPrivacySetting` / `wx.requirePrivacyAuthorize`（基础库 2.32.3）及 `agreePrivacyAuthorization` 按钮可用于处理微信隐私流程。后台未声明隐私收集时 `needAuthorization=false` 不等于应用没有收集数据，仍需按实际功能填写平台隐私指引。不要申请本项目不需要的手机号、通讯录、位置或头像权限。[微信官方 API 类型说明](https://github.com/wechat-miniprogram/api-typings/blob/master/types/wx/lib.wx.api.d.ts)

## 官方依据

- [微信云开发调用云函数](https://docs.cloudbase.net/en/recipes/add-cloud-function-wechat-miniprogram)：AppID 与环境关联、`wx.cloud.init`、`wx.cloud.callFunction`，服务端使用 `getWXContext()` 获取可信身份。示例中的日志做法不能直接用于健康记录，项目不打印完整 event、身份或读数。
- [微信官方 wx-server-sdk](https://github.com/wechat-miniprogram/wx-server-sdk)：`getWXContext()` 与 `DYNAMIC_CURRENT_ENV` 定义。
- [微信开发者工具 CLI 官方入口](https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html)：本轮网页直开受限，命令参数以本机工具实测结果为证。
- [微信小程序隐私协议开发指南](https://developers.weixin.qq.com/miniprogram/dev/framework/user-privacy/PrivacyAuthorize.html)：本轮网页直开受限；隐私 API 行为已通过官方 API 类型源文件核查。
