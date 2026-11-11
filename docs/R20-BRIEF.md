# R20 任务书（外部审查 43 条：止血 → 门禁 → 语义 → 边界 → 文档）

> 给接手的 AI。**先读 `docs/HANDOFF.md`**（纪律、结构、复核清单独在里面），这一份只写本轮要修什么。
>
> 基线：`0.9.16` 之后，`main` 已经走到 `13597bb`（比审查报告的 `47549e5` 多 5 个提交）· 交付方式：分支 + diff + 进度档案，**不要发布**（HANDOFF §8）
> 审查报告原件：`D:\workbuddy\2026-11-09-21-39-53\dsh-agent-soul-代码审查报告.md`（43 条 + 6 条无法验证，**基于 `47549e5`**）

---

## 0.5 先对齐：审查报告之后，主干又前进了 5 个提交

审查报告每一条的行号都基于 `47549e5`。你拿到这份文档时，`main` 已经多了：

| 提交 | 改了什么 |
|---|---|
| `13597bb` | **新增 `lib/host/runtime/segment-cache.js`（166 行）**，四段注入加渲染缓存；`segment-persona/memory/notes/purpose` 都改过；补「想对明天说」的入口 |
| `cdb16a8` | 日记 prompt：说清「上文里自己写的日记是字，不是事」 |
| `5562a59` | 私密日记不再把私密历史喂回去（自我喂养） |
| `0ac6e4c` | 日记历史压成每篇一行 |
| `c938c3e` | 历史日记和今天的素材划开 |

**由此三点必须注意**：

1. **行号会漂**。尤其 `lib/diary/compose.js`、`lib/diary/llm.js`、四个 `segment-*.js` —— 报告里这几处要重新定位；
2. **`segment-cache.js` 是报告没审过的新面**。缓存 + 注入的组合本身有风险（缓存陈旧、缓存与开关证据不一致、缓存无上限），**这条我没审过，你顺手看一眼**，别当它是干净的；
3. 版本号还停在 `0.9.16`，但内容已经是 `0.9.17` 的量 —— 谁发布谁定版本，你**不要**动 `package.json`。

---

## 0. 先看这一节：不要相信「清零」这个基线

上一轮（0.9.13）我在 `KNOWN-ISSUES.md` 写了「代码层面的待修项已经清零」。
**这次审查在 6 天内又找出 43 条，其中 8 条是我在那之后亲手写进去的。**

| 编号 | 我的锅 | 后果 |
|---|---|---|
| **H1** | R18 的 `legacyKeys` | 函数体用了没导入的 `readFileSync`/`CONFIG_FILE`，被 `catch` 吞掉 → 恒返回 `[]`，功能从上线那天就是死的 |
| **M4** | R19 的 `diaryToTodayMaxChars` | 新键没进 `DEFAULTS`，`clamp(undefined,…)` 返回下界 → `normalizeConfig({})` 给出 10（应为 30） |
| **M5** | R11 的保留期 | `Date.parse(key+'T00:00:00Z')` 后用本地 `dateKeyOf` 比对 → 负时区一个文件都不删 |
| **M9** | R19 的 to-today | 用户提交的文本直接进 `note()`，同文件别处却走 `sanitizeLogText` |
| **M10** | R19 的情境缓存 | 缓存命中条件没有 `Math.abs`，历史时间戳会串值 |
| **M25** | R8 的防抖 | 被合并的请求 `resolve(null)`，调用方当成成功 → 假「已保存」 |
| **H2** | R10 的限流分桶 | 桶键取未校验的候选令牌 → 随机令牌永不共享桶，Map 无上限 |
| **L1** | 文档 | 0.9.11–0.9.15 我标成 2026-11-10，实际提交全在 11-09 |

**它们全部穿过了**：`node --check`、92 个测试文件、11 条契约、双平台 CI。

所以第一条纪律是：**这轮的验收不是「测试绿」，是「毒化后必须红」。**
尤其是「接口仍返回 200，但响应体是错的」这一类 —— 当前门禁完全看不见（见批次 C）。

---

## 1. 我已核过的（可直接采信，不必重查）

读码 / 跑脚本 / 算求值，下表的机制我都独立确认过：

| 编号 | 结论 | 关键证据 |
|---|---|---|
| S2 | 成立 | `paths.js` 的 `normalizePathKey` **无 `resolve`**；`sessions.js` 的 `isOwnedCwd` 用 `startsWith(home + '/')` |
| S1 | 成立（机制） | `markOrphan` 只在链自己 settle 时解锁；`:140`/`:294` 早退无 TTL |
| H1 | 成立 | `system.js` 的 import 里无 `readFileSync`、无 `CONFIG_FILE` |
| H5 | 成立 | 闸门 `value === false` 判原始值；`validateConfigEntry` 接受 `'false'`/`'0'` |
| H6 | 成立 | `LIFE_WORDS` 尾部 `/i` 无 `g`，`text.match()` 只返回首个匹配 |
| H7 | 成立（机制） | `renderRecallOnly` 默认 `minHits=2`；`inject.js:138` 不传该参数 |
| H4 | 成立 | `cache.js:303` `LEGACY_OWNER_NAME = '树树'`，`:316` 直接 `atomicWrite` 进用户文件 |
| H8 | 成立 | `prepack = npm test`；`s2-hardening.test.js:241-252` 直接改仓库里的 `overview-tab.js`；`build-client.mjs:165` 裸 `writeFileSync` |
| H3⑤ | 成立 | `smoke.test.js:454` 先 `rmSync(sandbox)`，`:463` 才读 `soul.log` → 恒 false |
| M1 | 成立 | `server.js:212` 传了 config，`:434` 没传 |
| M4 | 成立 | 实跑 `normalizeConfig({})` → `diaryToTodayMaxChars: 10` |
| M5 | 成立 | `retention.js:66,73` |
| M9 | 成立 | `routes/diary.js:225` 未清洗 |
| M10 | 成立 | `situation.js:97` 无 `Math.abs` |
| M13 | 成立 | `server.js:233` 在 `:244` 之前 |
| M25 | 成立 | `api.js:106` `slot.resolve(null)` |
| L1 | 成立 | `git log --date=short` 全是 2026-11-09 |

## 2. 只能采信报告、我没有独立验证的

H2 的内存增长量级、M2（畸形 JSON 回 500）、M3（私密日记 TOCTOU）、M6–M8、M11、M12、M14–M19、M21–M24。
**动手前逐条自己核一遍**，报告也可能有错（它自己就声明没跑 `npm test`）。

## 3. 我改动过的严重度判断（照这个排，不照报告的原排序）

| 报告 | 我改判 | 理由 |
|---|---|---|
| S2 = P0 | **仍是 P0** | 它击穿了 R01/R02 两轮加固的目标。但注意前提：需要有效 `x-soul-token`，且接口默认只允许回环 —— **别按「公网任意读文件」写结论** |
| H2 = P1 | **降为 P2** | 真正危害是 Map 无上限（内存），不是「限流失效」；攻击者仍需先过 Host/Origin/回环 |
| 43 条并列 | **只优先处理 S1/S2 + H1–H8 这 10 条** | L1–L8 是文档/整洁，M 类按批次合批改，不要一条一提交 |

---

## 4. 批次 A · 止血（安全 + 可用性）

### A1 · S2：`?cwd=` 用 `..` 绕过归属判定（P0）

- **位置**：`lib/paths.js` 的 `normalizePathKey`；`lib/http/sessions.js` 的 `isOwnedCwd`；`lib/persona.js` 的 `localPersonaPath`
- **改法**：
  1. `normalizeCwdParam` 里先 `resolve()` 再判归属；
  2. `isOwnedCwd` 用 `path.relative(home, resolved)` 判断（`relative` 以 `..` 开头或为绝对路径 = 外部），**不要**用字符串前缀；
  3. `localPersonaPath` 也用 resolve 后的绝对路径。
- **可直接抄的范例**：`lib/notes.js` 的 `safePath` 已经是「join 之后 `resolve()` + `startsWith(root + sep)`」的正确写法。
- **验收（毒化必须红）**：`?cwd=<DSH_HOME>/..`、`?cwd=<DSH_HOME>/../..`、Windows 反斜杠变体、大小写变体，四种都必须 `rejected-unowned`；再构造一个真实存在的父目录写 `AGENT.md`，断言 `/state` 与 `/persona?kind=project` **都读不到**。

### A2 · H5：字符串 `"false"` 把设置页永久锁死（P0）

- **位置**：`lib/http/routes/system.js:210`
- **改法**：闸门判断**归一化之后**的值（先 `validateConfigEntry` 拿到 `check.value`，再判 `=== false`），或直接拒绝该键的字符串形式。
- **顺带**：`shouldAllowApiRequest` 在「未获授权放宽」时应**回落到回环判定**，而不是一刀切拒绝 —— 现在一旦落盘 `false`，连本机也 403，用户连 UI 都打不开。
- **验收**：`{"apiLoopbackOnly":"false"}` 与 `{"apiLoopbackOnly":"0"}` 都返回 400；并把「落盘为 false 且无环境变量时，回环请求仍放行」写进测试（这条现在没有）。

### A3 · S1：孤儿链让日记永久停摆（P0）

- **位置**：`lib/diary/scheduler.js`（`markOrphan` / `orphanChains` / `withDeadline`）
- **改法**：
  1. orphan 记录加**独立强制 TTL**（建议 `budget × 1.5`），到期强制删除 + 一条显眼的 `note('diary', …)`；
  2. `agents.resume` / `presets.resolve` / `presets.mount` 补真实超时（能拿到 `AbortSignal` 就传，拿不到至少用 `Promise.race` + 明确日志）；
  3. 文件里 `:239-240` 那段自述「一次挂起 = 锁永远不放」的注释，要跟着改。
- **验收（毒化）**：注入一条**永不 settle** 的假链 → 断言 TTL 后 `orphanChains` 被清空、`runStartupFlow` 能再次进入。这是报告点名的测试缺口。

### A4 · H1：`legacyKeys` 恒空（P1，我的假交付）

- **位置**：`lib/http/routes/system.js`
- **改法**：补 `readFileSync`（`node:fs`）与 `CONFIG_FILE`（`lib/store.js`）导入；把无差别 `catch { return [] }` 收窄成「文件不存在 / JSON 坏 → 返回 [] 并留一行日志」。
- **验收（毒化）**：配置文件里写入 `diarySchedule` / `moodOwnerName` → `GET /state` 的 `legacyKeys` **必须含这两个键**。这条断言现在全仓都没有（`r18-evidence.test.js` 导入了 `handleGetState` 却从没调用）。

### A5 · H2：限流分桶可被随机令牌绕过（P2）

- **位置**：`lib/core/api-token.js` 的 `bucketKeyOf` / `allow`
- **改法**：
  1. **只有校验通过**的令牌才按令牌摘要分桶；无效/未带令牌一律按 `peerOf(req)`；
  2. `buckets` 设**硬上限**并按 LRU 淘汰（直接复用 `lib/core/lru.js` 的 `trimMap`），不要只在 `size > 1024` 且「60 秒空闲」时清。
- **验收**：N 个随机令牌连续请求 `/session`，第 N 次必须 429；桶表大小有上界。

### A6 · H8：发布链写源码树 + 生成物非原子（P1）

- **位置**：`package.json` 的 `prepack`；`tests/s2-hardening.test.js:241-252`；`tools/build-client.mjs:165`
- **改法**：
  1. 测试改为**在临时副本目录**里改片段再构建，不碰仓库源码树；`finally` 还原不够，因为 `run-tests.mjs` 的超时用 `SIGKILL`，`finally` 不会执行；
  2. `build-client.mjs` 改 tmp + rename（`tools/sync.mjs` 的 `atomicCopy` 已经有正确写法，照抄）；
  3. `prepack` 只跑**只读**检查（lint + 测试），会写盘的构建放到显式命令；或在 `prepack` 前后各加一次 `git status --porcelain` 校验。
- **验收**：`npm pack --dry-run` 之后工作树必须干净；构建中断（人为 kill）不会留下半截 `lib/client.js`。

---

## 5. 批次 B · 语义（静默出错，用户能感觉到）

| 编号 | 位置 | 改法 | 毒化验收 |
|---|---|---|---|
| **H6** | `lib/core/diary-pick.js:27` | `LIFE_WORDS` 补 `g` | 一句含多个生活词 → 加分 > 6 |
| **H7** | `lib/memory/render.js:501,527` + `inject.js:138` | 阈值按 `wholeHits` / `gramHits` 分开判（`wholeHits >= 1` 放行），或 `inject.js` 显式传 `minHits: 1` | `recall(card, 'STM32')` 能命中；中文查询行为不变 |
| **H4** | `lib/state/cache.js:303,316` | `LEGACY_OWNER_NAME` 改成 `''`；`moodOwnerName` 的真实迁移保留 | 老配置（无 `ownerName` 键）→ 文件里**不出现** `ownerName: "树树"` |
| **M4** | `lib/memory/config.js`、`lib/memory/constants.js` | 新键补进 `DEFAULTS`；`DEFAULTS` 与 `DEFAULT_CONFIG` 做一次键集合一致性门禁；`memoryRecallTopK` 两处区间统一 | `normalizeConfig({})` 的每个键 = `DEFAULT_CONFIG` 的同名值 |
| **M5** | `lib/retention.js:66,73` | 日期键加减与校验统一走纯日历运算（或全程 `Date.UTC`） | `TZ=America/New_York` 下 `planConversationPrune` 能正常删 |
| **M13** | `lib/http/server.js:233,244` | 限流检查提到**所有**路由分支之前（含 `/session`、`/session/rotate`）；轮换只清当前令牌的桶 | 持有效令牌狂打 `/session/rotate` 会 429 |
| **M14** | `lib/attest.js:117-122` | `scrub` 同时把 `cwd` 摘要成短哈希或只回 basename | `/attestation` 响应里不含绝对路径 |
| **M20** | `lib/memory/scoring.js:51-53` | 缺 `createdAt` 时用 `updatedAt` / 文件 mtime 兜底，或标 `clarity: 'trace'` + 告警 | 无 `createdAt` 的记录会正常衰减 |
| **M25** | `lib/client/api.js:106` + 四个 tab | 被合并时 `resolve({ merged: true })`；调用方只在真实成功时置「已保存」并 `reload()` | 连续两次输入 → 只发一次 `/state`、只在最后一次成功时提示 |

---

## 6. 批次 C · 门禁（**必须在批次 D 之前做**）

这一批不做，D 批还会漏。报告列了七处盲区，按性价比排：

1. **`tools/lint.mjs` 加「用了但没导入」检查**，并修多行 `import` 的误判（`usedElsewhere` 只跳到首个换行）。H1 就是被这条漏掉的。
2. **`tests/smoke.test.js` 的读取顺序**：先读 `soul.log` 再 `rmSync`。**这道网存在的意义就是防 H1**，现在永远绿。
3. **契约测试加响应体断言**：`/state` 不能只验 200，要验 `legacyKeys` 是数组、`switches` 有 17 条、`persona.preview` 不含外部路径。
4. **`prepack` 接 lint**（现在只有 CI 单独的 step）。
5. **`test:contracts` 前置 `build-client.mjs`**，否则「改了片段忘了构建」在这条命令下查不出。
6. **清掉两处恒真断言**：`r18-evidence.test.js:146`（`A && B === false || true`）、`r07-remaining.test.js:150`（`… || true`）。lint 要能识别 `|| true` 型，不只字面量 `ok(true,…)`。
7. **探针覆盖服务端模块**：`dep-graph.test.js` / `probe-secrets.test.js` 现在只读 `lib/client/*.js`。
8. **构建/同步脚本自身的守卫补测试**：`build-client.mjs` 的「未登记片段即失败」、`DECL_RE`、`tools/sync-preview.mjs`（0.9.16 加的，至今没有任何测试调用它 —— `preview-css.test.js` 自己重写了一份替换逻辑，所以同步脚本坏了门禁仍绿）。

**验收**：把 H1 的导入删掉 → lint 必须红；把 `mark('moodTone')` 删掉 → 必须红；把 `?cwd=` 的归属判定改回字符串前缀 → 必须红。

---

## 7. 批次 D · 边界（合批改，别一条一提交）

M1（静态路由传 config）、M2（畸形 JSON 回 400）、M3（私密日记 TOCTOU）、M6（`projectMemoryEnabled` 没贯穿素材与健康）、M7（`saveConfig` 读改写无并发保护）、M8（密钥三处不一致：env 折叠 / env 优先于缓存 / 路径回显）、M9（`note()` 统一清洗 + to-today 拒绝控制字符 + `parseToToday` 改「最后一个非空行 startsWith」）、M10（缓存键带日期）、M11（单调时钟 + 跨端口放宽写进 README）、M12（`close` 事件、熔断漏分支）、M15（中和规则去长度上限、控制字符与 `/config` 共用常量）、M16（digest 按目标日过滤）、M17（游标口径统一）、M18（入库门槛读 cfg）、M19（LLM 结构校验）、M21（重要性收敛成一份）、M22（归档召回与缓存上限）、M23（`sync.mjs` 的 `--to` 缺值、无回滚、根目录残留临时文件）。

---

## 8. 批次 E · 文档（半小时，但影响下一个人对基线的判断）

- **L1**：按 `git log --format=%ad --date=short` 校正 CHANGELOG 日期；顺带同步 `docs/HANDOFF.md`（它还停在 0.9.14、写着 84 个测试）与 `KNOWN-ISSUES` 的轮次标注。
- **L2**：`lib/index.js` 两处、`lib/http/server.js:137`（还写「没有任何鉴权」）的注释与实现对齐。
- **L8**：把「代码层面的待修项已经清零」改成「**本轮清单已清空，新发现见 R20**」。这不是文字游戏 —— 它就是这次 43 条被漏掉的原因。

---

## 9. 我替你定的两件事（别再问）

1. **S2 按 P0 处理，理由是**：设置页接口默认只允许回环，所以真实威胁是「本机进程 / 同源页面」，不是公网 —— 但这正好是 R01/R02 两轮加固想挡的那类，而且读到的是**人格文件全文**。定级不降，但结论里要写清前提。
2. **H4 直接把 `LEGACY_OWNER_NAME` 改成空串，理由是**：把作者昵称写进陌生用户的提示词、还静默改他的配置文件，这在公开发布的包里是硬伤；`moodOwnerName` 的真实迁移不受影响。

---

## 10. 交付与复核

照 `HANDOFF.md` §8：只交付不发布。本轮复核会额外看：

1. **每条修复的毒化证据**（改前红、恢复绿），不接受「改完绿了」；
2. **响应体断言**：S2/H1/H5 三条我会亲自重放（`?cwd=<HOME>/..`、配置含废弃键、字符串 `"false"`）；
3. **`npm pack --dry-run` 之后工作树是否干净**（H8）；
4. **lint 是否真的能抓「用了但没导入」** —— 我会删一条导入现场试；
5. 有没有顺手改无关代码（本轮只做 A–E，别重构）。

> 这一轮最该记住的一句话：
> **上一轮我说「清零」，六天后被找出 43 条，其中 8 条是我自己在「清零」之后写的。**
> 所以别再写「清零」，写「本轮清单已清空」。
