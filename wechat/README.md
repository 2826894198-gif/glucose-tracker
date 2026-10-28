# 家人血糖本 · 原生微信工程

公开源码包括原生页面、共享统计模型、云函数、同步客户端和 OCR 容器实现。部署身份已替换为 `YOUR_WECHAT_APPID` 与 `YOUR_CLOUD_ENV_ID`；原用户的数据、照片、上传回执和云验收输出不随仓库提供。

## 本地检查

从本目录执行：

```sh
npm ci
npm --prefix cloudfunctions/glucose ci --ignore-scripts
npm --prefix cloudfunctions/recognize ci --ignore-scripts
cp project.config.example.json project.config.json
npm run build
npm run check
npm test
```

`project.config.example.json` 使用游客模式；云环境占位值不会调用 `wx.cloud.init`。`npm run ready` 在默认示例配置下应返回未就绪，不能通过关闭校验宣称已接通。

构建使用工程内 `shared/` 的纯逻辑生成 `miniprogram/utils/domain.js`。`check` 仅检查源码、包体与本机原生编译器，不登录、不上传。示例使用通用图表图标，测试数值来自合成 fixture，不包含实际健康照片或个人测值。

原项目开发版本曾上传，管理员身份基本云端读写已有验收记录；历史私有截图与回执不随公开包附带。体验版设置、父母双账号、换机、弱网及线上 OCR 仍需独立验收。

接自己的环境见 [接入指南](docs/registration-guide.md)，权限契约见 [云端安全](docs/cloud-security.md)。本工程只做记录与描述性分析，不提供医疗诊断。
