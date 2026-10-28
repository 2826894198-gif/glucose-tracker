# 微信云端身份、数据隔离与保存

此文对应 `cloudfunctions/glucose/`。云函数实现与本地安全测试已提供；是否已在真实云环境部署、创建权限和索引、通过两台真实微信账号验收，以根目录部署记录为准。代码测试通过不代表这些外部步骤已发生。

## 身份与权限边界

- 小程序调用云函数 `glucose`。入口直接执行 `cloud.getWXContext()`，只使用平台提供的 `OPENID` 和 `APPID`。
- 事件中的 `userInfo` 被丢弃，即使字段内容来自客户端也不能用于登录。客户端自带的 `ownerKey`、`openid`、`appid` 等字段不在白名单内，会被拒绝。
- 内部账户键是 `sha256(固定命名空间 + APPID + OPENID)`，返回给客户端的 `accountId` 为此不透明键。没有昵称、头像、手机号或家庭成员资料的要求。
- 每个记录和幂等操作的数据库文档编号，再由账户键、文档类别和本人提供的稳定记录/操作编号哈希得到。知道他人的记录编号或数据库编号不能指定他人的文档。
- 服务每次读、改、删除、恢复、目标和偏好操作都重新建立身份范围；列表查询同时带 `ownerKey`，返回前再校验归属。记录和目标不会因为前端切换一个人物字段而切换所有者。
- 除 `bootstrap` 外的全部请求还必须携带上次登录返回的 `expectedAccountId`，与本次可信身份重新推导的账户键一致才执行。该字段只用于阻止登录与请求之间换微信账号导致缓存或离线队列串入，绝不用于选择数据归属；不匹配返回 `ACCOUNT_CHANGED`，不附带任何新账号内容。
- 可在云函数环境变量配置 `GLUCOSE_ALLOWED_APP_ID` 为自己的公开 AppID，将函数进一步限定到该小程序。未配置时仍按可信 APPID/OPENID 两者隔离；不共享同一用户在其他 AppID 下的数据。
- 不创建 HTTP 访问触发器。即使误配置 HTTP 调用，缺少可信微信上下文也返回 `AUTH_REQUIRED`；不接受在请求体中补齐身份。

服务器/云控制台管理员仍具有技术管理能力。这不是端到端加密，也不能声称管理员看不到数据库。

## 集合、客户端权限和索引

在小程序所属云开发环境中创建三个集合：

| 集合 | 用途 |
| --- | --- |
| `glucose_accounts` | 个人目标、字体偏好、同步版本 |
| `glucose_records` | 原始测量记录和可恢复删除墓碑 |
| `glucose_operations` | 稳定操作编号、请求指纹和成功回执，保证重试不重复 |

三个集合均设置为**仅管理端可读写**，或在安全规则编辑器中设置：

```json
{ "read": false, "write": false }
```

完整规格见 `cloudfunctions/glucose/database.rules.json`。这些规则拒绝小程序直接调用 `wx.cloud.database()` 读取或写入；管理端云函数拥有数据库权限，因此必须保留服务代码中的归属校验。不得为了调试临时改成所有人可读写。

给 `glucose_records` 建立 `ownerKey` 升序、`syncVersion` 升序的唯一复合索引，规格见 `database.indexes.json`。账户和操作日志只按文档主键读取，使用默认主键索引。不要把索引文件的存在称为云端索引已经创建。

## 保存、重试、冲突和离线拉取

创建和修改均使用稳定记录 `id`、稳定 `opId` 与 `baseRevision`。服务器校验数值结构、单位、测量时机、餐后间隔、原始来源、备注和测量时间；生成 `createdAt`、`updatedAt`、`revision`、`syncVersion`，不信任客户端伪造的服务器字段。

测量时间必须是含 `Z` 或明确偏移的 ISO 时间，例如 `2026-10-22T07:10:00+08:00`。不能把没有时区的本地表单字符串直接上传，让服务器猜测日期归属。真实客户端应从本地日期构建 Date，再使用 `toISOString()`。

记录、账户同步版本、操作成功回执在同一个数据库事务中提交。重复发送相同 `opId` 和相同内容得到第一次的回执；同一编号配上不同内容返回 `OPERATION_REUSED`。`baseRevision` 落后返回 `CONFLICT` 并只附带当前本人的版本，不能静默覆盖，客户端需要保留未上传内容供核对。

删除为软删除，不永久移除记录；删除和恢复均更新版本、进入增量拉取。直接编辑已删除记录不会将它意外恢复，必须显式调用 `restore`。

`list` 以个人递增版本拉取，包含删除墓碑。第一页返回冻结 `watermark`；后续页用同一个 `uptoVersion` 和 `nextCursor`。分页期间记录可能更新到更高版本，因此响应同时返回查询后的 `latestVersion`；拉完一轮后若 `latestVersion > watermark`，客户端继续从 `watermark` 追赶一轮。同步中断不能提前推进本机已完成水位。

这提供可靠的增量和幂等基础，不保证离线未传数据已在云端，也不是手机后台持续实时同步。界面必须区别“已存本机、待上传、云端已保存、同步失败/版本冲突”。

## 云函数请求契约

所有响应：`{ ok: true, data }`，或 `{ ok: false, error: { code, message, details? } }`。只有成功回执才能显示云端已保存。

除 `bootstrap` 外，下表每个请求还必须含 `expectedAccountId`，取自最近一次成功 `bootstrap` 的 `accountId`。

| action | 请求字段（另含 action） | data |
| --- | --- | --- |
| `bootstrap` | 无 | `accountId, serverTime, syncVersion, preferences:{largeType,revision}, targets:{ranges,revision}` |
| `list` | `afterVersion?, uptoVersion?, cursor?, limit?` | `records, watermark, latestVersion, hasMore, nextCursor` |
| `get` | `id` | `record` |
| `upsert` | `opId, baseRevision, record` | `record, syncVersion` |
| `delete` / `restore` | `opId, baseRevision, id` | `record, syncVersion` |
| `targets.get` | 无 | `ranges, revision` |
| `targets.set` | `opId, baseRevision, context, range` | `ranges, revision, syncVersion` |
| `targets.remove` | `opId, baseRevision, context` | `ranges, revision, syncVersion` |
| `preferences.set` | `opId, baseRevision, preferences:{largeType:boolean}` | `preferences:{largeType,revision}, syncVersion` |

`record` 可上传字段仅为 `id,value,unit,moment,afterMinutes?,measuredAt,note?,source?`。服务返回模型另含服务器时间、版本及可选 `deletedAt`，不会返回内部 `ownerKey` 或数据库 `_id`。`id` 长 8–80、`opId` 长 8–100，允许字母、数字、下划线和连字符。明确拒绝 `demo-`/`demo_` 开头的示例记录上传。

`context` 为 `{moment,unit,afterMinutes?}`；餐后未指定间隔的个人目标键默认为 120 分钟，其他时机不能带餐后间隔。`range` 为 `{low,high,unit}`，上下限含于范围之内，无预设医学目标。`CONFLICT` 的 `error.details.current` 分别为当前记录、`{ranges,revision}` 或 `{largeType,revision}`。

## 真实部署步骤

1. 先在微信开发者工具登录有权管理此 AppID 的微信账号，选择小程序自己的云开发环境。创建环境、套餐、账单或协议可能需要账号持有人完成；不预先购买付费服务。
2. 创建上述三个集合、客户端拒绝读写规则和复合索引。与旧版网站数据库隔离。
3. 入口 `index.main`，运行时按平台实际支持版本核对。当前微信工具创建的是 Node.js 16.13，本工程发布包已按这一版本编译；完整 CloudBase 平台还支持较新版本，可在实际配置入口选择。固定 `wx-server-sdk` 正式版本及安全维护依赖，用 npm >=8.3.0 执行 `npm ci --ignore-scripts`，验证 Axios 0.34.0 / lodash.unset 4.18.0 后，将业务和依赖打成独立 CommonJS 文件上传；不使用云端 npm 安装。发布清单保留锁文件、输入与输出 SHA-256，避免云端重装回 SDK 原有旧版。函数不需要微信开放 API 权限，`config.json` 的 `openapi` 为空。源码中的 userInfo、tcbContext 都只按不可信平台元信息丢弃，不能选择账号身份。
4. 将小程序配置中的云环境 ID 指向同一环境。建议设置函数环境变量 `GLUCOSE_ALLOWED_APP_ID` 为实际 AppID；此处不需要在小程序内放 AppSecret。
5. 用测试微信 A、B 各记录不同数值，在云端验证 `ownerKey` 不同、两端各自只能看到本人记录。修改请求体的 owner/openid、复用另一个人的记录 id、直接数据库调用都应失败或只能操作本人同编号记录。
6. 同一账号两设备编辑同条记录，验证冲突保留；断网记录后关闭重开再联网，验证重传不重复、删除/恢复同步一致。新设备登录确认可从云端取回记录和目标。
7. 完成云端备份策略与恢复演练，再供父母长期使用。云端保存副本不等于独立备份已做好；未上传的本机离线记录不在云端恢复范围内。

## 安全测试与尚未验证的边界

本地测试命令：`node --test wechat/tests/cloud-service.test.cjs wechat/tests/cloud-dependency.test.cjs`。17 项通过，已覆盖可信身份、伪造身份拒绝、跨用户/跨 AppID 隔离、字段校验、幂等回执、并发冲突、事务失败回滚、删除墓碑、分页追赶、个人目标、显示偏好及实际 SDK 的依赖接口兼容性。

本地使用内存事务仓库和 SDK 适配器契约测试，没有声称代替真实云数据库事务、权限、安全索引或两个真实微信账号的验证。云函数不记录请求体、身份、读数、照片或备注日志，不接外部 OCR、不接广告分析。

### 已修复的依赖与剩余审计项

2026-10-22 从 npm 官方仓库核实，`wx-server-sdk` 最新正式版本为 4.0.2。最新同来源 `@cloudbase/node-sdk` 3.18.7 仍固定 Axios 0.27.2 与数据库 1.4.3。本项目保留 SDK 4.0.2 及其 CloudBase node 3.17.2 / database 1.4.3，通过范围限定的 npm overrides 安装修复版：

- Axios 0.27.2 → 官方仍维护的 **0.34.0（0.x 维护线）**。0.30.x 仍落入后续安全公告范围，未选择 0.30.x，也未跨到 1.x。[官方 0.34.0 发行说明](https://github.com/axios/axios/releases/tag/v0.34.0) 包含请求配置与代理安全修复；维护版也有安全驱动的行为变更，不能仅凭未跨主版本假定完全兼容。
- lodash.unset 4.5.2 → **4.18.0**，保持相同包名、原作者来源及主版本。[官方发行说明](https://github.com/lodash/lodash/releases/tag/4.18.0) 确认发布了该模块包和原型属性删除修复。

新增兼容测试调用已安装的 CloudBase 元数据函数，经过 Axios 真正的 Node HTTP adapter 与内存 transport，核验固定元数据主机/路径、30/200 毫秒超时传递、HTTP 错误及超时中止；同时核验扩展 shim 的可调用 Axios 配置接口/JSON 序列化，以及 lodash.unset 普通路径和原型删除防护。测试没有访问真实元数据、凭据或云网络，不代替真实环境 DNS、代理和事务验收。

修复后 `npm audit` 从 **6 个受影响包（5 high、1 moderate）降至 4 个 high 包**；剩余四项是同一个 [lodash.set 原型污染公告](https://github.com/advisories/GHSA-p6mc-m468-83gw) 沿 lodash.set → database → node-sdk → wx-server-sdk 传播，不能称为四个独立根因，也不能称为漏洞已清零。官方 lodash.set 最新仍为 4.3.2，没有同包可用修补版。

已对锁定的 database 1.4.3 源码与实际 CommonJS 文件核对：唯一运行时导入在 `dist/commonjs/realtime/virtual-websocket-client.js:3`，调用在该文件第 477 行（对应 `src/realtime/virtual-websocket-client.ts:734`）。触发过程为 `query.ts:581` 或 `document.ts:389` 的 `watch` → `websocket-client.ts:975` 的 watch → 实时局部更新中将 `updatedFields` 的字段路径传给 `set(doc, fieldPath, value)`。该依赖仍被安装和加载；本服务的 `index.js`、`service.cjs`、`repository.cjs` 没有调用 watch，也不接受 URL、字段路径、`updatedFields` 或任意深层更新对象，仓库只用归属限定查询、文档 get/set 和事务。这里提供的是当前应用未调用已识别危险路径的源码证据，不是对依赖漏洞已修复或所有运行时路径不可达的证明。

详细版本、审计计数和可达性证据见 `cloudfunctions/glucose/dependency-audit.json`。没有执行 `npm audit fix --force` 当前推荐的 SDK 1.8.3 大版本降级，也没有把数据库强行替换为 2.x。正式云端接入后还需复验依赖解析版本、数据库事务、客户端权限及两个实际微信账号；未来同来源正式修补发布后可更新锁文件并复验。

官方依据：微信维护的 [wx-server-sdk](https://github.com/wechat-miniprogram/wx-server-sdk) 提供 `getWXContext`、动态环境与事务 API；腾讯云开发的 [事务文档](https://docs.cloudbase.net/database/transaction) 说明服务端事务及提交/回滚语义。微信开发者文档直开可能受访问限制，部署时仍应核对当前控制台运行时与权限面板。
