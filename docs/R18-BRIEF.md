# R18 任务书（三条：文档漂移 / 废弃键 / 开关生效证据）

> 给接手的 AI。**先读 `docs/HANDOFF.md`**，那份是总纲（纪律、结构、复核清单都在里面）；
> 这一份只写本轮三件事。
>
> 基线：`v0.9.12`（提交 `19648ae`）· 交付方式：分支 + diff + 进度档案，**不要发布**（HANDOFF §8）

---

## 0. 这三条的共同点：都不是 bug，都是「说的和做的不一样」

三条都不会让插件崩，但都会让人（包括下一个维护者）**判断错**：

| # | 症状 | 后果 |
|---|---|---|
| A | `package.json` 的 description 还写着心情「不注入、无挂饰」 | 别人读完介绍就以为心情只影响提示词里的措辞，不会想到每轮都有一段动态文本进上下文 |
| B | 两个已停用 / 已废弃的配置键还在配置表里 | 有人照着配置表去改它，改了没有任何反应，还以为生效了 |
| C | 大部分功能开关**没有生效证据** | 开关是 true，但链路早就断了 —— 日志不说，测试全绿 |

C 是重点，A/B 是顺手的。

**先说明一处需求描述需要更正**（见 §2）：B 那条「仍列在配置表、建议设置页隐藏或标灰」——
**设置页早就没有这两项了**，我核过。真正的问题在别处，写清楚了。

---

## 1. 任务 A：`package.json` 的 description 已经过期

### 已确认（我核过，可直接采信）

```jsonc
// package.json
"description": "……心情跟着每轮对话自己判断、自己平复（不注入、无挂饰）。"
```

括号里那句「（不注入、无挂饰）」是**旧版**的事实，现在是错的：

- `lib/state/cache.js` 的 `DEFAULT_CONFIG` 里有 `moodToneInject: true`（2026-11-01 上线）；
- `lib/host/runtime/segment-mood.js` 注册了 `soul:mood` 注入段（`order: 230`）；
- 也就是说，心情**每轮都在往上下文里进一段文本**，而且隔几轮还会往用户消息后挂一行语气。

### 要做的事

1. 重写 description，**同时准确描述现状**：列出四类注入（人格 / 记忆 / 笔记 / 目的）+ 心情语气，
   并说明记忆会衰减、心情会自己判断。长度控制在 npm 卡片一行能看全（≤ 120 字为宜）。
2. 顺手核一遍：description 里每一句，代码里都还成立吗？**逐句对着代码找到落点**。
   我上一轮就栽在这类地方 —— `HANDOFF.md` 写过「`force` 参数恒 false」，
   实际 `regenerateDiary` 一直在传 `{ force: true }`（R15 才被外部复核方纠正）。
3. 如果 README 首屏也复述了同一句话，一起改（`grep "不注入"` 一把）。

### 验收

- `grep -rn "不注入\|无挂饰" .` 只剩历史 CHANGELOG 里的记录（那是历史，不该改）；
- description 里提到的每个能力，都能在代码里指到具体文件（在交付档案里列出来）。

---

## 2. 任务 B：两个废弃键 —— 需求描述要更正

### 先更正事实

原来的说法是「`diarySchedule` 与 `moodOwnerName` 仍列在配置表，建议设置页隐藏或标灰」。

**设置页根本没有这两项**（我核过）：

- `lib/client/diary-tab.js` 只有一段注释解释「22:00 到点触发」为什么被删，
  界面上是「自动写日记」开关 + 「兜底检查间隔」；
- `lib/client/mood-tab.js` 用的是 `ownerName`（注释说明 `moodOwnerName` 只做迁移）。

所以「隐藏 / 标灰」这件事**已经做完了**。剩下的是另一个问题：

### 真正的问题

`lib/http/middleware.js` 的 `validateConfigEntry` 有一条**硬规则**：

```js
if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return { ok: false, error: '未知配置项' }
```

于是这两个键**必须**留在 `DEFAULT_CONFIG` 里，否则老客户端/手写调用往 `/config` 发它们会直接 400。
它们现在的身份是「**兼容占位**」，不是「配置项」：

| 键 | 现状 | 真正的用途 |
|---|---|---|
| `diarySchedule: '22:00'` | 代码里**没人读**它做任何决策 | 只为不让旧配置报错 |
| `moodOwnerName: ''` | 只有迁移逻辑读它（`migrateOwnerName`） | 老配置迁移到 `ownerName` 用 |

**残留的坏味道**（这才是要修的）：`/config` 会把它们**照原样写回 config.json**，
于是它们在文件里永远活着，看起来像有效配置。

### 要做的事（建议方案，可提出更好方案）

1. 在 `middleware.js` 加一张 `LEGACY_CONFIG_KEYS` 表（`diarySchedule` / `moodOwnerName`）：
   - **接受**（不报 400，保持兼容）；
   - **不落盘**（`handlePostConfig` 合并前剔除）；
   - **每个进程只记一行日志**：`[config] 忽略已废弃配置键 diarySchedule（旧版遗留，当前无效果）`。
2. `DEFAULT_CONFIG` 里这两个键的注释已经在（写得挺好），**保持**，别删键。
3. 给 `/state` 或 `/attestation` 的返回加一个 `legacyKeys` 字段，说明「你的配置文件里有这些，
   现在没有效果」—— 这是**给用户看的**，比藏在代码注释里强。

### 明确不要做

- ❌ **不要**从 `DEFAULT_CONFIG` 删这两个键 —— `validateConfigEntry` 会开始报「未知配置项」，
  这是破坏性变更，老用户直接撞 400；
- ❌ 不要为了「统一」把 `moodOwnerName` 的迁移逻辑删掉 —— 还有人配置在老版本上。

### 验收

- 发一个含 `diarySchedule` 的 `/config` 请求 → 200，且 config.json 里**不出现**该键；
- 发一个含 `moodOwnerName` 的 → 200，且迁移逻辑（如果 `ownerName` 还空）仍然生效；
- 有测试覆盖上面两条；日志只打一行（不是每次请求一行）。

---

## 3. 任务 C（重点）：每个功能开关都要有「生效 / 未生效」证据

### 为什么

项目历史上出过一次：**语气链失效了三天，日志里一句错都没有，测试全绿**。
同类形状还有好几处（`lib/extract.js:179` 记的「记忆卡一次都没被创建、日志里连句报错都没有」）。

根因是同一个：**开关的值 ≠ 开关的效果**。
`moodToneInject: true` 只能说明「用户没关它」，说明不了「它这一轮真的挂了语气」——
中间任何一环断了（心情没判定成功、被判成机器来源、宿主改了事件形状），都是静默的。

现在已经有两只眼睛，但只盯住了两处：

| 已有的观测 | 盯的是什么 | 位置 |
|---|---|---|
| `[attest] 装配证词` | 注入段**有没有内容**（人格 1277 字 · 记忆 794 字 · 笔记 227 字 · 目的 166 字，4/4 到位） | `lib/attest.js` + `host/runtime/entry.js` |
| `probeHostOnce` 宿主形状自检 | 宿主事件**能不能抠出正文** | `lib/core/host.js:170` 附近 |

**这一轮要把它推广到每个开关。**

### 建议的设计（可调整，但下面三条要求别丢）

**① 静态生效性**：配置组合下这个开关是否**可能**生效。典型反例：

- `moodToneInject: true` 但 `moodEnabled: false` → 语气链 inert，原因必须是「心情关了」；
- `memoryEnabled: true` 但 `enabled: false` → 全关；
- `notesEnabled: true` 但笔记目录为空 → 不能算「生效」，要写「暂无内容」。

**② 动态证据**：它**上次真的发生**是什么时候。形式建议：

```js
// 每个开关一个计数器 + 最后发生时间（内存即可，不落盘）
switchEvidence.mark('moodTone', { note: '给她挂了「有点困」的语气' })
```

启动时打一行、每日健康行里带一句，**不要每轮打日志**（噪音会让人不再看日志）。

**③ 一条命令能看见全部**：`[attest]` 或 `/state` 里给一张表：

```
[attest] 开关生效：总开关✓ 记忆✓(89 条) 笔记✓(12 篇) 目的✓ 心情✓(判定 14 次/失败 0) 语气✓(近 7 轮挂 2 次) 日记✓(昨天已写)
                  未生效：心动✗(功能未实现) 提炼✗(没配模型)
```

### 要做的事（按这个顺序，别一次全上）

1. **先盘清单**：把 `DEFAULT_CONFIG` 里所有布尔开关列出来（我数到 17 个：`enabled` /
   `apiLoopbackOnly` / `includeGlobal` / `projectPersonaEnabled` / `memoryEnabled` /
   `projectMemoryEnabled` / `memoryRefine` / `memoryRecentDiaryIncludePrivate` / `purposeEnabled` /
   `notesEnabled` / `moodEnabled` / `moodToneInject` / `diaryEnabled` / `diaryCatchUp` /
   `diaryOverwrite` / `diaryAgentWrite` / `diaryManualNote`），
   逐个标注：**谁在用它 / 断了会怎么表现 / 现在有没有观测**。写进交付档案，这就是本轮的资产。
2. **先做最贵的那三个**：`moodToneInject`（出事过）、`memoryEnabled`（出事过）、`memoryRefine`
   （静默降级到原话直存的路径）。剩下的按「断了会不会完全没痕迹」排序。
3. **抽出 `lib/evidence.js`**（或复用 `attest.js`），提供 `mark(key, detail)` / `report()`；
   把 `[attest]` 那一行和 `/state` 接上。
4. **给 inert 的每种组合写测试**（这是最容易漏的）：
   `moodToneInject=true + moodEnabled=false` → report 里必须是「未生效：心情关了」，
   而不是「生效」也不算「未知」。

### 要求（别做成假旋钮的反面）

- ❌ 不要用「配置是 true」冒充「生效」—— 那就是这轮要消灭的东西；
- ❌ 不要每轮往日志里灌；一行启动 + 一行每日健康，够了；
- ✅ inert 的**原因**必须写人话（「心情关了」而不是 `moodEnabled=false`）；
- ✅ 「从未发生」和「发生了 N 次」要能分开（`0 次` ≠ `N/A`）。

### 验收

- 至少 3 个开关有完整证据（静态 + 动态 + inert 原因），其余开关有清单和明确优先级；
- inert 组合有测试，且**毒化后必须红**（照 HANDOFF §6 的纪律：毒化不红先怀疑毒化写错）；
- 交付档案里那张「开关清单」表本身，就是这一轮的主要产出之一。

---

## 4. 明确不做（免得白费力气）

| 不做 | 为什么 |
|---|---|
| 给设置页加回这两项（或标灰） | UI 早就没有，加了反而是倒退 |
| 从 `DEFAULT_CONFIG` 删废弃键 | 会让 `validateConfigEntry` 开始报「未知配置项」，破坏性变更 |
| 把开关证据做成落盘的历史统计 | 内存够用；写盘会带来「统计本身就是新的失败面」 |
| 改 `#23`（渲染期白屏） | 等宿主暴露 `React.Component`，见 HANDOFF §6 |

---

## 5. 交付与复核

照 `HANDOFF.md` §8 做，只交付不发布。本轮复核会额外看：

1. **description 的每一句都能在代码里找到落点**（我会逐句核，和 R15 那次 `force` 一样）；
2. **废弃键的兼容性**：老配置文件（含 `diarySchedule` / `moodOwnerName`）加载后行为不变，
   且新写入不再带上它们；
3. **开关证据不是假绿**：我会挑一个 inert 组合，把配置改成那个组合，看报告是否真的说「未生效：原因」；
4. **噪音**：跑一次完整会话，看日志里开关证据是不是只有启动那一行（多了就是错）。

> 这一轮要做对，靠的不是多写代码，而是**先承认「我不知道这个开关现在有没有在工作」**，
> 然后为这句话补上眼睛。
