# 第三方许可与来源声明

> 本文件随 `dsh-agent-soul` 的源码仓库、npm 包与 DSH 宿主安装副本一同分发。
> 若本文件的转述与 `LICENSES/` 下的许可原文有出入，**以 `LICENSES/` 下的原文为准**。
> 核对日期：2026-11-08，依据各仓库 GitHub 默认分支的 `LICENSE` 与 `README`。

---

## 一、本项目是派生作品，不声称原创

**dsh-agent-soul 不是从零写的原创作品。** 心情引擎、五张表情图、部分设置页布局、
记忆机制、目的机制等实质性部分派生或借鉴自下列项目。按《Yuuyuko-uu 插件许可 1.2》
第 5(b)、5(c)、7、8 条，在此明示来源、原作者、许可与改动；本项目不将上述部分
称为「自研」「原创」，也不隐藏任何原作者署名。

| 原项目 | 原作者 / 版权人 | 适用许可 | 本项目中的性质 |
|---|---|---|---|
| [Yuuyuko-uu/dsh-feiyu-mood](https://github.com/Yuuyuko-uu/dsh-feiyu-mood) | **Yuuyuko-uu** | [Yuuyuko-uu 插件许可 1.2](./LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt) | **实质性移植**：心情判断内核 + 判断 prompt + 五张表情图 + 界面布局 |
| [Yuuyuko-uu/dsh-fish-memory](https://github.com/Yuuyuko-uu/dsh-fish-memory) | **Yuuyuko-uu** | [Yuuyuko-uu 插件许可 1.2](./LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt) | 记忆机制的设计借鉴：会淡忘的长期记忆、召回去重、注入预算 |
| [Mieksido/surfcore](https://github.com/Mieksido/surfcore) | Derpyu520 and qq-bridge / QSH contributors | MIT | 目的机制的设计与逻辑精简移植 |

上表两个 Yuuyuko-uu 仓库的 `LICENSE` 是**同一份《Yuuyuko-uu 插件许可 1.2》逐字全文**，
故共用 `LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt` 这一份原文副本。
SurfCore 的版权声明与完整 MIT 许可文本见
[LICENSES/MIT-THIRD-PARTY.txt](./LICENSES/MIT-THIRD-PARTY.txt)。

---

## 二、整体许可结构

- 本项目包含来自 `dsh-feiyu-mood` 与 `dsh-fish-memory` 的派生部分。按《Yuuyuko-uu 插件许可 1.2》
  **第 6 条**「公开的衍生作品必须继续使用本许可（或更严格的许可），不得改用更宽松的许可」，
  **本项目作为公开衍生作品整体以该许可 1.2 为准**；再分发时不得把本项目整体标成纯 MIT。
- 根 [`LICENSE`](./LICENSE) 中的 MIT 文本保留不动，**仅覆盖本项目可与上述派生部分分离的
  自有代码**，不构成对本项目整体的 MIT 授权。`package.json` 的 `license` 字段写
  `SEE LICENSE IN LICENSE`，即指向此处说明。
- 上表的 SurfCore 仍由其版权人按 MIT 授权；本声明**不削弱**你从原作者处
  直接取得的任何权利，也不替第三方组件授予额外权利。

完整原文：

- `LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt` —— 1.2 逐字全文（满足第 5(a) 条「完整保留本文件，不删、不改、不缩略」；同时对应两个原仓库）
- `LICENSES/MIT-THIRD-PARTY.txt` —— SurfCore 的版权行 + 完整 MIT 许可文本
- `LICENSE` —— 本项目自有可分离代码的 MIT 文本

---

## 三、逐项来源与改动清单（第 5(c) 条）

### 3.1 dsh-feiyu-mood 0.7.6 —— 心情引擎（原作者 Yuuyuko-uu）

**取用了什么**

| 内容 | 本仓库位置 |
|---|---|
| 心情判断内核：心情值、七情、时间线、双半衰期衰减、只吃 1/3 的慢动 | `lib/mood.js`、`lib/mood/core.js`、`lib/state/mood-state.js` |
| 判断 prompt 的 11 条规则与三种判断口径（对方说话 / 定时任务 / 自己搭话） | `lib/mood/prompt.js` |
| 消息抽取的宿主事件形状容错、消息来源口径 | `lib/mood/session.js` |
| 五档表情阈值（80 / 62 / 42 / 25）与兜底规则 | `lib/mood/core.js` |
| **五张表情图**（`face-great/good/ok/worry/sad.png`，作者自绘） | `assets/face-*.png` |
| 设置页布局：大数字 hero + 七情 + 时间线 + 判断配置 | `lib/client/mood-tab.js`、`lib/client/styles.js` |
| 静态资源路径前缀的老习惯 | `lib/http/constants.js` |

**改了哪些部分**

- 砍掉三样：每回合 `systemPrompt.context` 注入、右下角挂饰（widget）、多份绑定（slots / 会话模式 / 工作区模式）；改为按 `cwd` 的 slug 记一份全局心情。
- 判断 prompt 把称呼参数化成 `self / owner / aliases`，并从 2878 字压缩到约 1250 字（不改判据）。
- 判断调用改为可走硅基流动 OpenAI 兼容接口或宿主 `llm.stream`；不 import `@deepseek-ai/dsh-llm`。
- **不迁移 feiyu-mood 的历史心情数据**，从空白起步。
- 2026-11-06 模块化重构：拆成 `lib/mood/`、`lib/state/`、`lib/client/` 等目录，
  前端片段由 `tools/build-client.mjs` 拼成单 bundle；函数体保持原语义。

### 3.2 SurfCore —— 目的机制（MIT）

**取用了什么**：四维驱动值（好奇 / 在乎 / 想分享 / 想搞懂）随时间半衰回基线、
被素材反复刺激而上涨、从记忆里提炼「没闭合的事」作目标、`satisfyDrives`
（说出去了驱动才真的降 ×0.45）。落在 `lib/purpose.js`、`lib/state/maintain.js`、
`lib/host/runtime/segment-purpose.js`、`lib/client/purpose-tab.js`。

**改了哪些部分**：

- 删掉原版为 QQ 群聊写的排程、静默时段、投递 / 回执逻辑 —— 本地 DSH 没有推送渠道，
  「主动」从「主动发消息」改成「主动想起」，由模型自己决定要不要提。
- `purpose.js` 收敛为纯逻辑、零 I/O；`maintain` 负责落盘并做了写盘节流（P2-8）。
- 新增 `settleServed` / `markServed` 用「上一轮回复指纹」判定是否真的说出口，
  取代原先的 60 秒墙钟猜测（P1-5）。

### 3.3 dsh-fish-memory —— 记忆机制（原作者 Yuuyuko-uu，许可 1.2）

原项目定位（据其 README）：「给 DSH 里的会话一份**会淡忘的长期记忆** —— 每条都带时间」；
记忆有鲜活度、越久越淡但**不删除**，按「命中的词够不够特别」召回，命中才注入、
有每日与单次配额，并做召回去重。

**取用了什么（设计层面）**

| 设计 | 本仓库对应位置 |
|---|---|
| 记忆会淡忘而非直接删除，淡到「说不清」而不是抹掉 | `lib/memory/constants.js` 的清晰度分级、`lib/memory/mutation.js`、`lib/state/maintain.js` |
| 每条记忆带时间，重要的记得更久、最初的事不丢 | `lib/memory/card.js`、`lib/memory/render.js` |
| 按证据召回、命中才注入、注入有预算上限 | `lib/memory/recall.js`、`lib/memory/render.js` |
| 自动挑重点（不是每句话都记）、单轮配额 | `lib/extract.js`、`lib/memory/config.js` |
| 召回去重、遗忘可查回（档案 append-only） | `lib/memory/recall.js`、`lib/memory/card-io.js` 的 `archive.jsonl` |

**改了哪些部分**

- 淡忘改为**多级清晰度**（清晰 → 清楚 → 模糊 → 只剩印象 → 遗忘）与每日 `maintain` 衰减，
  不是单一「鲜活度」数值；遗忘写进 `archive.jsonl`，另支持按体积分片。
- 记忆卡分**全局 / 项目两层**，再叠加按 `kind` 的分类、`pinned` 锚点、重要度与私密标记。
- 新增自动提取（`extract.js` 按规则打分、过滤宿主注入的上下文）、LLM 提炼与归属路由、
  跨进程写卡 rev 检测、原子写与写失败回滚。
- 新增配套能力：日记（公开 / 私密双篇）、笔记（永不衰减）、心情与目的机制的牵引。
- 2026-11-06 模块化重构：拆成 `lib/memory/`、`lib/state/`、`lib/http/routes/` 等目录。

> 说明：本仓库源码注释此前**没有**点名该来源，2026-11-08 按最高标准补记。
> 原项目 README 另注明其分词词表来自 jieba（MIT）；**本仓库不含该词表**
> （检索确认只有中文分词的规则讨论，没有词表文件与 jieba 依赖），故不涉及该第三方素材。

---

## 四、署名保留位置（第 8 条）

以下原有 / 补充的源码注释均**保留、不删、不替换、不隐藏**；再分发时请一并保留：

- `lib/mood.js`、`lib/mood/prompt.js`、`lib/mood/session.js`、`lib/mood/core.js`、
  `lib/http/constants.js`、`lib/client/styles.js`、`lib/client/mood-tab.js`、
  `tests/mood.test.js` —— 点名 dsh-feiyu-mood / 原作者 Yuuyuko-uu。
- `lib/store.js`、`lib/memory/render.js` —— 点名 dsh-fish-memory / 原作者 Yuuyuko-uu。
- `lib/purpose.js` —— 点名 SurfCore 与其 MIT 版权人。
- `assets/README.md` —— 五张表情图的作者与来源。
- 本文件、README 第一屏、根 `LICENSE`、`package.json` 的 `license` 字段。

---

## 五、不属于第三方版权来源的引用（边界）

以下名字出现在注释或配置里，但**不是被复制的第三方代码**，无需按再分发条款署名：

- **明确「不 import」的对象**：`@deepseek-ai/dsh-tools`（`lib/tool.js:8`）、
  `@deepseek-ai/dsh-llm`（`lib/mood/judge.js:143`）—— 注释写的是刻意避开。
- **宿主内部模块 / 官方包**：`@deepseek-ai/cordis`（peerDependency）、
  `@deepseek-ai/dsh` 及 `@deepseek-ai/*`、`dsh-session/lib/types/index.js` 的
  `validateSessionHeader`、`dsh-persona` 的同名开关 —— 仅用于核实字段名与接口，运行时依赖。
- **文档知识**：「DSH 问题库 Q07 / Q14 / Q20 / Q37 / Q39」是踩坑记录，不是代码。
- **第三方服务 / 运行时**：硅基流动 API、DeepSeek API、宿主提供的 React —— 属服务条款与运行时依赖。

---

## 六、许可原文

### 6.1 Yuuyuko-uu 插件许可 1.2（逐字全文；独立副本见 `LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt`）

```
Yuuyuko-uu 插件许可 1.2

版权所有 (c) 2026 Yuuyuko-uu

──────────────────────────────────────────────────────────────

【为什么不用 MIT】

2026 年 10 月，有人把我这几个插件（代码、README，还有我做的图）
改名、去掉署名，在视频里说成「自研」发布。

他没有违反 MIT —— MIT 只要求保留版权声明，不管「这是谁做的」。

所以换成了这份许可。它只多要求一件事：
你拿走的时候，说一声这是谁做的。

安装、修改、商用，全都允许 —— 和 MIT 一样宽。

──────────────────────────────────────────────────────────────

一、允许，不需要另外问我

 1. 安装到自己的机器上使用，长期用，商用也行。
 2. 读源码、改源码、改成自己需要的版本（改给自己用，不必公开）。
 3. 把你的改动发给我（issue / PR）；我采纳后，按仓库惯例记你的贡献。
 4. 在文章、视频、教程里介绍、演示、截图、引用本项目 —— 请附上原仓库地址。

二、允许，但必须做到

 5. 再分发时（把代码或其实质性部分放进你自己的仓库、整合包、安装包，
    或者换一个包名发布），必须同时做到：
    a) 完整保留本文件，不删、不改、不缩略；
    b) 在 README 的第一屏写明：本项目派生自 <原仓库地址>，原作者 Yuuyuko-uu；
    c) 说明你改了哪些部分。
 6. 公开的衍生作品必须继续使用本许可（或更严格的许可），不得改用更宽松的许可。

三、禁止

 7. 不得把本项目的全部或实质性部分声称为你自己原创 ——
    包括在 README、发布说明、视频、插件市场条目里，
    把它写成「自研」「原创」「我写的」。
 8. 不得删除、替换、隐藏本项目的作者署名，
    包括 LICENSE、NOTICE、README、package.json 和源码注释里的。

四、其他

 9. 本项目按「现状」提供，不附带任何明示或默示的担保。
10. 违反第二、三条中任何一条，本许可立即终止；你还应当删除已发布的衍生作品。
    从违约那一刻起，你就不再拥有使用、复制、分发本项目的任何授权。
11. 上面没写的情况想用，直接来问我，一般都会答应。
```

### 6.2 MIT License（SurfCore；版权行与副本见 `LICENSES/MIT-THIRD-PARTY.txt`）

```
MIT License

Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 七、版本时间线说明（据实陈述）

`lib/mood.js` 注释写的是「从 dsh-feiyu-mood **0.7.6** 移植」。该 tag（commit `4e21024`，
2026-10-26）当时的 `LICENSE` 与 `package.json` 均为 **MIT**；上游在 **2026-10-30**
连改三次，把许可换成 1.0 → 1.1 → 1.2。按许可不追溯的通常理解，本可只按 MIT 保留
版权声明。两个原仓库的 README「许可」章节至今仍写「Yuuyuko-uu 插件许可 1.0」，
而 `LICENSE` 文件已是 1.2 —— 属上游自身的版本号不同步，本项目**以 LICENSE 原文为准**。

**本项目主动放弃援引这一时间差，按现行的《Yuuyuko-uu 插件许可 1.2》最高标准履约**：
完整保留许可原文、README 第一屏声明派生与作者、列出改动、不声称原创、保留全部署名、
并接受第 6 条对整体许可的约束。理由是原作者换许可的诉求只是「说一声这是谁做的」，
而本项目的注释与五张图都是明确移植，按高标准署名成本极低、也最不容易产生争议。

> 本文件是工程层面的来源与许可说明，不构成法律意见。
