# 家人血糖本 · 面向长辈的个人健康记录

**把记录、趋势回看和弱网下的数据保护做成一个完整工具。**

原生微信工程包含较大字号、手动输入、照片核对、历史分析、离线待上传、按身份隔离的云保存、删除恢复与冲突处理。OCR 以独立桥接和 Linux 容器实现，未配置时保留手动输入。

原项目 0.1.0 已上传开发版本，尚未完成父母双账号真机验收或公开发布。这里提供清除真实配置和健康照片的公开源码，默认不接任何真实业务环境。

## 微信工程

需要 Node.js 22+、npm 和微信开发者工具。从仓库根执行：

```sh
cd wechat
npm ci
npm --prefix cloudfunctions/glucose ci --ignore-scripts
npm --prefix cloudfunctions/recognize ci --ignore-scripts
cp project.config.example.json project.config.json
npm run build
npm run check
npm test
```

在微信开发者工具导入 `wechat/`。游客示例配置用于原生页面预览，`YOUR_CLOUD_ENV_ID` 表示未配置云端；`npm run ready` 此时应返回未就绪。连接自己的环境时，按 [注册与接入指南](wechat/docs/registration-guide.md) 配置本人 AppID、云环境、数据库规则和云函数。不要使用别人的环境或上传密钥。

`check` 使用本机官方 WXML/WXSS 编译器；没有编译器时不能宣称原生检查通过。Docker OCR 测试是单独的可选流程，不是默认预览前置条件。

## 早期本地 PWA

仓库根保留独立的早期浏览器版本，数据只保存在当前浏览器，没有 Firebase、远程业务接口或云同步。开一个新终端，从仓库根执行：

```sh
npm ci
npm run dev -- --host 127.0.0.1
```

该版本与 `wechat/` 的数据存储独立。`scripts/seed-demo-data.js` 是在浏览器控制台主动执行的合成样例生成器，记录带 `demo` 标志；不要在实际健康记录的浏览器环境运行样例脚本。

## 示例与边界

- 页面示例、测试数值与目标均为代码构造的 DEMO，不来自本人或家人的健康记录。
- 原血糖仪演示照片已移除，示例图片改用仓库现有的通用图表图标，不含测值、人物或照片元数据。
- OCR 仍需使用者自己准备不含个人信息的测试图片；容器工程不代表线上识别已部署或准确率已验收。
- 云服务只信任可信微信身份。只做记录和描述性回看，不提供医疗诊断；上游依赖审计与真机验收边界见 [工程状态](wechat/docs/engineering-status.md)。

更多见 [仓库状态](docs/REPOSITORY_STATUS.md)、[安全说明](SECURITY.md) 与 [资源说明](RIGHTS.md)。
