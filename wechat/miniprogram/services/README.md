# 微信身份与同步服务

入口：`require('./services/client').createClient({ wxApi: wx, functionName: 'glucose', environmentId: cloudEnv })`。应用需先使用真实环境调用 `wx.cloud.init`。`environmentId` 用于隔离不同云环境的本机缓存和待同步队列，不能省略为测试与生产共用一个命名空间。

## API

```js
const client = createClient({ wxApi: wx, functionName: 'glucose', environmentId: env })
const unsubscribe = client.subscribe(snapshot => { /* update view */ })
await client.login()
client.saveRecord({ id: optionalStableId, value: '6.1', unit: 'mmol/L', moment: 'fasting', measuredAt: isoInstant, note: '', source: 'manual' })
client.deleteRecord(id)
client.restoreRecord(id)
client.setTarget({ moment: 'after', afterMinutes: 120, unit: 'mmol/L' }, { low: '4.4', high: '9', unit: 'mmol/L' })
client.removeTarget(context)
client.setLargeType(true)
await client.sync()
client.resolveConflict(conflictId, 'local') // or 'cloud'; explicit user choice
client.logout()
```

上面的数值仅用于展示接口结构，不是个人目标建议。应用不得自动使用这些示例值。

- 本机修改 API 同步返回 `{ok:true,data:{record?,targets?,largeType?,queued:true}}`，或 `{ok:false,error:{code,message}}`。视图可 `await`，但 `ok` 仅代表本机数据和 outbox 均写入成功；不能据此显示“已云同步”。
- 默认会异步尝试上传；断网失败不清除本机记录。`autoSync:false` 只用于可控集成测试。
- `login()` 和 `sync()` 是异步方法。身份检查失败时登录返回失败，页面不显示上一个账号的缓存。
- `subscribe` 立即发出当前快照，并返回取消订阅函数。页面销毁时取消订阅。

## 快照

```js
{
  authenticated: true,
  accountKey: 'opaque server-derived scope',
  records: [],          // 包含可恢复删除的墓碑
  activeRecords: [],    // 未删除，按测量时间降序
  targets: {},         // contextKey -> {low,high,unit,updatedAt}
  largeType: false,
  outboxCount: 0,
  conflicts: [],
  status: 'synced',
  lastSyncedAt: null,
  error: null
}
```

每条快照记录额外有 `revision`、`syncVersion`、`syncStatus`（`synced` / `pending` / `conflict`）。同步状态枚举为：

- `logged-out`：尚未确认身份或当前身份已改变；不可展示旧账号记录。
- `connecting`：正在确认微信身份。
- `syncing`：正在同步，不代表已上传成功。
- `synced`：当前队列为空，最近一次拉取完成。
- `pending`：仍有待处理操作，或云端持续更新需要续拉。
- `offline`：当前无法连接云端；已验证身份的本进程可以继续本机保存。
- `conflict`：保留了本机和云端两个版本，等待明确选择。
- `error`：本机写入或云端格式/规则错误，显示具体提示。

冲突项为 `{id,entity,kind,recordId?,context?,local,cloud,message,createdAt}`。`entity` 是 `record:<id>`、`targets` 或 `preferences`。两种选择都不会静默丢弃内容；选择保留本机后用云端当前版本生成新的操作，若再次被其他设备修改仍会再次冲突。个人范围的“保留本机”只重放本机触及的时机，保留其他设备新增但本机未触及的范围。

## 数据与身份保证

- 身份仅来自 `glucose.bootstrap` 的服务端 `getWXContext()`，不调用手机号或头像授权，也不由客户端提交 OpenID。
- 每次同步先重新确认身份，再处理队列。每个非 bootstrap 请求都附带服务端返回的 opaque `expectedAccountId`；云端将它与本次真实上下文重新推导的身份比较，防止微信账号在两次请求之间变化导致串入数据。该字段只是范围一致性断言，不是授权来源。
- 本机缓存按云环境、服务端账号标识隔离。切换微信账号先锁定旧快照；旧账号待同步数据保留在旧命名空间，不能上传给新账号。
- 完全关闭后离线冷启动不能可靠证明当前微信身份，因此先锁定缓存，恢复网络确认身份后解锁并续传。此前已写入的本机内容和队列不会丢失；已经在线确认身份的同一进程断网时可以继续记录。
- 稳定操作 ID 保证丢失响应后的重试不会产生重复记录；同一记录的后续本机修改依赖前一操作回执，按云端版本顺序发送。
- 先上传，再按稳定版本水位分页拉取；墓碑参与同步，缺失项不会复活旧记录。分页期间记录变化会从水位继续拉取，不将半个分页快照提交为同步完成。
- 云端记录、目标和字号均做版本并发校验。冲突保持两个版本，不采用“最后上传覆盖”。
- 本机缓存损坏或写入失败时保留原存储，不假报成功，不在运行日志记录健康值或身份。

## 测试边界

`node --test tests/sync-client.test.cjs` 将客户端连接到实际 `cloudfunctions/glucose/service.cjs`，使用内存事务仓库和 fake wx 传输模拟网络/账号变化。它验证同步及隔离逻辑，不能代替真实 CloudBase 数据库权限、微信 SDK、真机网络与体验版的验收。
