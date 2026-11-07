# 变更记录

本项目从 `0.9.2` 起维护本文件。更早版本只能靠 git tag 和提交记录回溯 —— 这正是本文件存在的原因：
`0.8.3` 加了一道会让反代部署整页 403 的 Host 白名单，却没有任何变更说明，最后是使用方撞上并报回来的（[#1](https://github.com/danshuyue/dsh-agent-soul/issues/1)）。

格式：`## 版本 · 日期` / 变更按「新增 / 变更 / 修复 / 破坏性」分类。

---

## 0.9.2 · 2026-11-07

### 修复

- **合并路径会把主记忆文件挪走**（P2-12，数据安全级）：`saveCardMerged` 在合并前调 `loadCard`，而它的 catch 会 `parkCorrupt` —— 一次瞬时读失败就把主卡改名 + 置只读，随后写盘往空路径写新卡。新增无副作用读 `readCardQuietly`，合并与写后回读都改用它；`loadCard` 只留给真正的加载路径。
- **鉴权链没有任何兜底**：Origin / Host / 回环 / 令牌四段校验原先裸奔在 handler 体里，任何一段将来抛错都会逃出 `webServer` → 未捕获 → **宿主进程退出**。现在整段包一层 catch，异常记日志 + 回 500 + 追踪码。
- **自定义 judge provider 静默失败**（P2-19）：`judgeProvider` 配成非 siliconflow 时会把 provider 原样交给宿主，宿主不认识就每轮判定失败、只留一行日志，表现为「她情绪一直不变」。现在第一次调用就明确告警。
- **设置页改配置会丢**（P2-25/26）：三个 Tab 原来都 POST **全量**配置，跨 Tab 保存互相覆盖；文本输入框还是逐键 POST。现在各 Tab 只发改动键（服务端本就按 key 合并），并加 300ms 防抖。
- **记忆搜索逐键重取**（P2-28）：带 query 时 300ms 防抖。
- **日记「文件存在但不完整」死循环**：`startupWork` 判定要重写，但 `askAgentToWrite` 只要看到文件存在就认为「她写好了」，于是每轮空转、日志写「日记完成」，内容永远补不回来。现在「要不要再找她写」多了时间基线（`shouldAskAgain`）。
- **兜底覆盖她迟到写出的日记**：`waitForWrite` 超时后插件兜底写盘，会盖掉她几秒后落盘的那篇。`writeDiaryFile` 增加 `skipIfNewerThan`，比她旧才写。
- **`lastTalkAtOf` 只扫末 80 行**：文件本就整份读进内存，只遍历尾部纯属遗留写法；多会话交错时最后一句会被挤出窗口，导致「半天版」被判完整。
- **固定区（pinned / initial）无上限**：固定区有独立预算（`injectMaxChars × 2`），2 倍以内宁可超出也完整保留，超过才裁并明说「还有 N 条这轮没放下」。
- **游标在 `snapshotEvents` 抛错时不推进**：现在一定推进，且整卡注入只宽限一次。
- **`mountedOffs` 强引用**：改存 `WeakRef`，会话关闭后 agent 可被回收。
- **喂给 `drives` 的素材顺序**：由「数组尾部 12 条」改为按 `lastSeenAt`（最近被想起）优先排序。
- **跨进程写卡竞态**：写后回读 `rev`，发现被别人覆盖时记日志（**只检测，不自动重写**）。

### 变更

- `lib/state/maintain.js` 新增 `pickRecentMaterials`（纯函数，可单独测）。
- `lib/memory/card-io.js` 新增 `readCardQuietly`（无副作用读卡）。
- 客户端新增 `apiPostDebounced`（按 key 防抖的 POST）。

---

## 0.9.1 · 2026-11-07

### 修复（安全）

- **反代部署下 `/api/soul/*` 全量 403**（[#1](https://github.com/danshuyue/dsh-agent-soul/issues/1)）：
  Host 判定改为**以宿主为准** —— 先问 `ctx.connection.requestRejection(req)`，
  `null` 放行、`401`（宿主侧未登录）放行到插件自己的 `x-soul-token` 校验、`403` 才拒；
  宿主不可用 / 抛错时退回插件白名单。原来插件自维护信任名单，与宿主 `--trusted-host` 两套 fence 打架。
- **任意文件读取**（`GET /state?cwd=<任意目录>` 可读该目录 `AGENT.md` 前 400 字）：
  cwd 归属校验收口，`GET /persona` 一并补上。
- **`GET /persona` 绕过 cwd 归属校验**且返回全文。
- **UNC / 设备路径**（`\\host\share`、`\\.\`、`\\?\`）：`statSync` 会发起 SMB 连接并携带 NTLM 凭据，且同步阻塞事件循环。现在字符串阶段直接拒，`statSync` 挪到归属判定之后。
- **`sec-fetch-site` 值拼错**（`'samesite'` ≠ `'same-site'`），同站防线此前从未生效。
- **错误原文回显**：`/pick`、`/persona` 保存、`/open` 三处不再把含绝对路径的 `error.message` 回给客户端，改为固定文案 + 追踪码。
- **数据边界可伪造**：`<user_data>` 换成带内容哈希 nonce 的 `<untrusted_data>`，内容拼不出真闭合标签；人格段补 `PERSONA_GUARD` 声明。
- **配置数值无上限**：新增 `NUMBER_RANGES` 覆盖 35 个数值键，越界拒绝（此前 `diaryAgentTimeoutMs = 1e12` 也能存）。
- **日记主流程无总超时**：12 分钟总预算 + 超时后 orphan 防重入。
- **`/register` 反向放行归属校验**：新增写侧唯一入口 `resolvePostCwd`。
- **PowerShell 回退链是断的**（裸名字分支直接 return，第三级永远不可达）；顺带校验 DPAPI 输出，避免存下解不开的空密文。
- **`POST /memory` 的 `edit` 分支绕过脱敏**。
- **`maintain` 无视 `projectMemoryEnabled`**。
- **记忆卡容量到顶且无可压缩项时仍 `push`**。
- **Origin/Host 端口比较**：`String(host).split(':')[1]` 对无端口的 Host 与 `[::1]:8080` 都恒不相等；改为规范化权威比较，两端同为回环时允许端口不同。

### 变更

- 新增一次性提示：接口被非本机 Host 访问时在日志里提醒（只记一次）。

### 破坏性

- **`POST /register` 不再接受任意路径**：只接受「已登记 / 宿主会话给的 / `DSH_HOME` 内」。设置页「把路径粘到输入框」这条路关闭，请改用「选择文件夹」。
- **`POST /config` 数值越界返回 400**（此前静默接受）。
- `DSH_SOUL_POWERSHELL` 指向不存在的路径时保存密钥直接失败，不再静默回退。

---

## 0.9.0 · 2026-11-06

### 变更

- **模块化重构**：`lib/` 拆成 95 个模块（`host/runtime`、`memory/`、`state/`、`diary/`、`http/`、`core/`）。
- 新增契约门禁三件套：导出快照、行为 golden、依赖图；刷基线必须写明理由并留痕。

### 破坏性

- **新增 Host 白名单**（见 `0.8.3`）：`/api/soul/*` 只接受 `localhost` / `127.0.0.1` / `[::1]` / `::1`
  以及 `DSH_SOUL_ALLOWED_HOSTS` 里的值。**反向代理 + 公网域名/IP 的部署会整页 403** ——
  这就是 `0.9.1` 修的那条（[#1](https://github.com/danshuyue/dsh-agent-soul/issues/1)）。
  当时没有写进任何变更说明，是本项目的流程失误。

---

## 0.8.3 · 2026-11-06

### 变更

- 加固（R2/R3/R4）：**Host 白名单**、`localNames` 只认纯文件名、回环门控下沉。

> **注意**：`DSH_SOUL_ALLOWED_HOSTS` 是 `DSH_` 前缀的启动期变量，**只能**通过
> `systemd Environment=` / `docker -e` / shell `export` 设置。写进 `.env` 会让 dsh 直接启动失败。

---

## 0.8.0 – 0.8.2 · 2026-11-05 / 11-06

无变更记录（本文件从 `0.9.2` 起才存在）。这几个版本没有 Host 白名单。
