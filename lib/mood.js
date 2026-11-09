/**
 * mood.js —— 心情引擎：每轮判断一次「这轮心情怎么变了」，更新心情值 / 七情 / 时间线。
 *
 * ── 版权与来源（保留原作者署名，见 THIRD-PARTY-NOTICES.md）──
 *   本文件的判断内核派生自 dsh-feiyu-mood 0.7.6
 *   （https://github.com/Yuuyuko-uu/dsh-feiyu-mood），原作者 Yuuyuko-uu，
 *   适用《Yuuyuko-uu 插件许可 1.2》，逐字原文见 LICENSES/Yuuyuko-uu-PLUGIN-1.2.txt。
 *   五张 assets/face-*.png 同为原作者自绘，见 assets/README.md。
 *   改动清单：THIRD-PARTY-NOTICES.md §3.1。
 *
 * ── 从 dsh-feiyu-mood 0.7.6 移植，砍掉两样、改造一样 ──
 *   · **右下角挂饰**（widget.js / index-inject 那套）—— 不要；
 *   · **多份绑定**（slots / 会话模式 / 工作区模式）—— 一份心情跟着一份人格走，按 cwd 的 slug 记；
 *   · **注入**—— 原版每回合把心情写进提示词（和挂饰绑在一起）。我们**留注入、去挂饰**：
 *     2026-11-01 起有自己的 `soul:mood` 段（order 230），文案与它的 widget 无关。
 *     这行原来写的是「本插件只记账不注入」，2026-11-10 R18 文档对齐漏改，发布前复核补正。
 * 留下的是判断内核：一次很短的模型调用产出 moodDelta + 七情变化 + 理由 + 可信度，
 * 心情值慢动（只吃 1/3）、七情即时动、时间衰减回稳、时间线存档。
 *
 * ── 判断口径（三种，按「谁在说话」分） ──
 *   ''     对方在说话         → 正常判
 *   'work' 定时任务叫去干活    → 判自己这轮在忙什么（bili-duty-scan 等外部触发）
 *   'talk' 自己主动搭话       → 判自己开口那股劲儿（speak-up）
 *
 * ── 为什么判断 prompt 移植而不是重写 ──
 *   那 11 条规则是真踩坑踩出来的（「宝宝视频」被当成名词、reason 写成现在时跟下轮打架、
 *   模型把闹钟当情绪理由……）。重写等于把坑再踩一遍。只把称呼参数化（self / owner / aliases）。
 *
 * ── 为什么用 systemPrompt.context 的 text() 当每轮钩子 ──
 *   text() 每次装配提示词都会被调用、拿到 context.agent —— 在这里懒挂 agent 的
 *   turn-stopping 监听（挂一次就够），不需要 agents 枚举服务和定时轮询。
 */

/**
 * 公共 API 门面：实现已迁到 lib/mood/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { DIMS, DIM_FULL, MOOD_STEP_DIVISOR, TIMELINE_CAP, applyDelta, blankMoodState, decayMood, dimPercent, dimWord, displayDimPercents, displayDims, moodFace, moodLabel, normMoodState, normReason, normalizeMoodConfig, parseDelta, topDims } from './mood/core.js'
export { EXTERNAL_TRIGGER, INJECTED_CONTEXT, SELF_SPEAK, buildJudgeSystem } from './mood/prompt.js'
export { fullTextOf, isMachineSource, lastAssistantTextOf, lastUserTurnOf, sessionModelOf, stripBridgePrefix, textOfMessage } from './mood/session.js'
export { judgeMood } from './mood/judge.js'
export { observeAgent, observedCount, unobserveAll } from './mood/hooks.js'
export { clockOf, moodDigest, renderMoodDigest } from './mood/digest.js'
