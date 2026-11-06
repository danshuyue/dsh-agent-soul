/**
 * 宿主装配 · meta.js
 * 由 lib/index.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */



/** 插件名 = 裸包名，必须与 package.json 的 name、cordis.patch.yml 的 name、插件目录名三者一致。 */
export const name = 'dsh-agent-soul'

/** 声明式依赖：没有 inject，读 ctx.systemPrompt / ctx.tools 会直接抛。 */
// 2026-11-03 加 agentPresets / sessions：
//   日记会话是**冷启动**出来的（开机时它多半没开着），而 agents.resume 不会
//   自动把 preset 挂回来 —— 不传 setup 的话，恢复出来的 agent 没有 preset，
//   工具只剩全局插件那一层（qq_* / soul_* / screen_* 都在，read/write/pwsh/glob 全没）。
//   症状是「日记会话突然不能读文件、不能跑命令」，而且一句日志都没有。
//   这两个服务拿不到时降级成「日记会话没工具」，属于核心能力丢失，所以必须声明。
export const inject = ['systemPrompt', 'tools', 'webServer', 'agentPresets', 'sessions']


/** 记忆维护的最小间隔（毫秒）：注入每回合都跑，但维护不必。 */
export const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000

/** 表上限：会话开多了不能一直涨；超了按最久未用淘汰。 */
export const STICKY_MAX_SESSIONS = 32

/** 话题重合度阈值：Jaccard ≥ 0.6 视为「还是这个话题」。 */
export const STICKY_TOPIC_JACCARD = 0.6

/** 复用日志的限频：同一会话 10 分钟内只记一次，别把日志刷成噪音。 */
export const STICKY_NOTE_INTERVAL_MS = 10 * 60 * 1000


// ---- 记忆写入回声的渲染（2026-11-04） ----
//
// 缓冲本身在 echo.js（只管存/取/过期）；这里只决定「怎么摆进提示词」。
// 为什么放在最前面而不是接在召回区后面：
//   下一轮模型最需要确认的是「我刚才写的那条到底长什么样」，这是即时上下文；
//   召回区是「跟这句话有关的旧事」，两者语义不同，不能混在一起读。

/** 回声小节本身的上限 300 字：再多就不是回执，而是把记忆卡又发了一遍。 */
export const ECHO_SECTION_MAX_CHARS = 300


/** 每条最多显示 60 字（超出截断加 …）：回执只需要确认是哪一条。 */
export const ECHO_LINE_MAX_CHARS = 60


/**
 * 「本会话已经说过」的集合最多记这么多条（2026-11-01 审计 D12）。
 *
 * 原来这个 Set 在一个会话里**只增不减**：召回过的原文永远被 exclude，
 * 而候选池只有 8 条。聊到后半段，"相关但说过"的记录一多，这一段就再也出不来 ——
 * 表现是长会话里她后半段几乎想不起任何事，而日志里什么都不说。
 *
 * 语义改成「最近说过的不再重复」而不是「这个会话说过的都不再说」：
 * 隔三十轮再提一次旧事是自然复述，不是刷屏。
 */
export const RECALL_SEEN_MAX = 16


/**
 * 人格隔多少轮补注一次（2026-10-31）。
 *
 * 树树的话：人格不该是教条，做事方式靠上下文推理就够了 —— 这点对。
 * 但「我叫糖糖」不是推理出来的，是事实。推理推不出自己的名字。
 *
 * 只在首轮注入的风险：对话长到触发上下文压缩，历史被压成摘要，
 * 人格正文就真的没了，而 `isFirstTurnOfSession` 还是恒 false，不会补。
 * 那时会变成「记得聊过什么，但不记得自己是谁」。
 *
 * 所以折中：首轮注入 + 每隔这么多轮补一次。
 * 15 轮补一次（树树定的）：注入之后它就留在上下文里了，不用每轮重发；
 * 但隔一段时间补一次，压缩之后能自己找回来。成本相对于十五轮对话可以忽略。
 */
export const PERSONA_REFRESH_TURNS = 15
