> 公开源码说明：原仪表照片与历史推理回执不随仓库提供。页面使用无测值的通用图标；本地单元测试采用合成响应。可选容器推理需通过 `OCR_SYNTHETIC_FIXTURE` 指定自行制作的合成仪表图，不能将默认图标或历史描述当作本副本已完成真实推理。

# 生产照片识别接入

本轮没有可靠核实微信 `cloud.openapi.ocr.printedText` 的现行调用参数与账号权限，因此没有把第三方旧示例当作可用接口。采用已有实际验证的 RapidOCR 模型，提供可部署容器和受保护的云函数桥接；没有购买或开通任何收费 OCR。

## 当前交付与边界

- `cloudfunctions/recognize/` 是微信事件云函数，接受 `{image: dataURL, expectedAccountId}`。可信身份仅来自每次 `cloud.getWXContext()`，拒绝客户端 owner、openid、endpoint 或 headers。
- 未配置服务时明确返回 `OCR_NOT_CONFIGURED`。不会将本机 localhost 写入小程序，也不固定填入样例数值。
- `runtime/` 是无状态容器，部署到有 HTTPS 入口的受控云运行环境后，用仅保存在服务端的 bearer token 连接。照片在内存中处理，不上传长期对象存储，不写请求/识别日志。
- 解析模块从已经验证的 `preview/server/parse-reading.mjs` 原样复制；测试检查一致性，不猜小数点，不将 HI/LO 转成 0，不确定数字或单位留待人工核对。
- 代码和安全测试完成不等于生产服务已开通；真实环境、权限、配额、计费和父母实际血糖仪样本仍需账号侧配置及实测。

## 调用契约

```js
wx.cloud.callFunction({
  name: 'recognize',
  data: {
    image: 'data:image/jpeg;base64,...',
    expectedAccountId: accountIdFromLatestGlucoseBootstrap
  }
})
```

`expectedAccountId` 必须取自最近一次成功 `glucose` bootstrap 的 `accountId`。识别入口用本次可信 APPID/OPENID 重新计算相同命名空间的账户哈希；缺少、不一致或在登录与识别间换了微信账号，返回 `ACCOUNT_CHANGED`，**在读取/解码图片及发送外部 OCR 之前停止**。该字段只是断言原账号未变，不能用于选择记录归属或替代微信身份。客户端应保留照片并重新确认登录，不能将旧账号照片在新账号下自动重试；微信可能附带的 `userInfo` 也不用于身份判断。

返回 `res.result` 为：

```js
{ ok: true, data: { value: '6.1', unit: 'mmol/L', confidence: 0.98,
  rawText: '...', candidates: [], engine: 'rapidocr-cloud', processedLocally: false } }
// 或
{ ok: false, error: { code: 'OCR_NOT_CONFIGURED', message: '...' } }
```

`value`、`unit` 可能为 `null`，识别成功也必须本人确认保存。失败保留当前照片供手动输入。base64 字符串限制 4 MiB，解码图片约 3 MiB，以免超过云函数调用包限制；客户端应先压缩图片。支持 JPEG/PNG/WebP，服务端检查文件签名及解码尺寸，上限 48MP，识别前缩至最长边1800px。

## 环境变量与部署

云函数：

| 变量 | 用途 |
| --- | --- |
| `OCR_URL` | 受控 OCR 容器的固定 HTTPS `/api/ocr` 地址；不允许客户端传入 |
| `OCR_TOKEN` | 随机生成至少32字符的服务凭据，只在云函数和容器环境中配置 |
| `EXPECTED_APPID` | 可选，进一步限定允许调用的 AppID |

容器：`OCR_TOKEN` 必填，`PORT` 默认8080。密钥不能写进小程序包、Dockerfile、Git或聊天；凭据轮换需同步两端。

容器启动时先加载模型，加载成功才监听端口；健康检查使用 `GET /health`。错误/短 token 或模型启动失败时不会对外报告健康。桥接的 HTTPS 请求包含 15 秒整体时限，覆盖连接、TLS 和持续滴流的响应；不能仅依赖 socket 空闲超时。部署后将 `recognize` 云函数的执行超时设为至少 20 秒并核对实际值；CloudBase 文档列出的事件函数默认超时为 3 秒。[CloudBase 官方基础配置](https://docs.cloudbase.net/cloud-function/function-configuration/config)

从 `runtime/` 目录构建镜像，部署到腾讯云运行环境或用户已选定的受控容器服务；镜像内安装固定依赖与模型。不要对外开放无鉴权 OCR 接口，也不要允许请求参数选择出站地址。容器仅放行 `/health` 和携带正确 bearer 的 `/api/ocr`。健康检查不包含用户信息；容器一次处理一张，繁忙时503，客户端仍可手动填写。可按真实CPU/内存负载配置扩容；本轮没有创建云资源、费用承诺或上传镜像。

`config.json` 不申请微信 openapi 权限，因为此方案不使用未经核实的印刷体 OCR 云调用。云函数使用事件触发，不开放匿名 HTTP 入口。SDK身份能力见[微信官方 wx-server-sdk](https://github.com/wechat-miniprogram/wx-server-sdk)；云函数调用与环境绑定见[CloudBase 官方说明](https://docs.cloudbase.net/en/recipes/add-cloud-function-wechat-miniprogram)。RapidOCR 模型及运行库来源见[RapidAI 官方项目](https://github.com/RapidAI/RapidOCR)。

## 隐私与验证

生产照片会从父母手机经微信云函数传往配置的 OCR 容器。这与浏览器预览“在这台电脑上识别”不同，发布前需按真实部署更新页面及微信后台隐私指引。只用于识别，不长期保留照片；云服务基础设施的请求日志策略也需在控制台核对，不将应用不写日志夸大为平台完全无日志。

本地测试：

```sh
node --test tests/recognize.test.cjs
```

覆盖可信身份缺失、伪造身份/endpoint、账户断言缺少或伪造、不同 OPENID/APPID 的身份变化、正确账户断言、未配置、HTTPS地址、大小和格式、真实响应解析、HI/LO、失败与超时。入口测试确认账户不符时不读取图片、不调用内部识别器或外部服务，账户哈希与 glucose bootstrap 的纯函数一致。集成实测需在部署后分别用父母微信调用，验证返回自己的照片结果、切换微信后的旧照片不自动重试、没有直传对象存储、错误后可手动保存。任何样例识别成功都不代表实际仪器准确率承诺。

2026-10-22 本机核验：12 项 Node 测试通过；用已有项目 Python 环境直接执行新 `runtime/app.py` 的解码和真实 RapidOCR 工作函数，1122×1402 示例照片识别文本为 `6.1`、`mmol/L`。这是工作代码在 macOS Python 3.9.6 上的实际推理验证，五个顶层固定包版本与 requirements 一致，不能据此声称 Linux 容器已验证。

2026-10-23 先对 Linux x86_64 / CPython 3.11 完成仅二进制包的依赖解析，五个固定依赖及传递依赖均有兼容 wheel；报告在 `artifacts/ocr-linux-dependencies.json`，结果固定于 `runtime/requirements.lock.txt`。

同日继续启动本机 Docker Desktop，构建并实际运行 `linux/amd64` 镜像 `family-glucose-ocr:0.1.0`。真实推理与 HTTP 测试均通过：

```sh
docker build --platform linux/amd64 -t family-glucose-ocr:0.1.0 cloudfunctions/recognize/runtime
npm run test:ocr
```

9 项 Python/HTTP 测试覆盖模型就绪、鉴权、错误/超大/分块请求、图片 MIME 与真实格式、像素上限、EXIF 方向、繁忙状态、短凭据拒绝启动，以及真实示例照片识别。测试运行于禁网、无主机端口、只读根文件系统的容器，使用非 root 用户和随机临时测试 token；只挂载工程示例图及测试脚本。真实 HTTP 响应继续送入生产桥接/解析，确认返回数值 `6.1`、单位 `mmol/L`；本轮联测报告（历史证据或本机配置未随公开包附带）包含样例、源码指纹及实际耗时。微信身份与 HTTPS 传输在该联测中是明确的测试替身，不是已连接真实微信云端。

另有 6 项 Node HTTPS 传输测试覆盖整体时限、连接卡住、响应滴流、正常完成后释放计时器、拒绝重定向及超大/中断响应。工程测试还覆盖接入和 CLI 错误判断，最终数量见工程状态中的原始 TAP 记录；没有上传云镜像或创建云资源。样例成功不代表云端延时或父母真实仪器准确率承诺。
