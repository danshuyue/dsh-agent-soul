/**
 * extract.js —— 从会话事件里自动提炼记忆（回合后增量扫描）。
 *
 * ── 为什么需要它 ──
 * 只靠工具让 agent「主动记」是不够的：提示词说一百遍「记得记下重要的事」，
 * 她该不记还是不会记（模型对「元指令」的服从度远低于具体任务）。
 * 所以留一条自动通道：回合结束后扫一遍新事件，按规则挑出值得记的写入记忆卡。
 *
 * ── 怎么挑（全是规则，不调模型） ──
 *   ① 只看 user/message（主人说的话才是记忆素材；她自己的回复不记，否则会自我强化）
 *   ② 长度 8~600 字，跳过纯代码块 / 纯命令 / 纯符号
 *   ③ 打分过线才记（memory.scoreRecord 的 importance ≥ 阈值）
 *   ④ 单回合最多记 maxPerTick 条，按分数取前几名
 *
 * ── 增量扫描 ──
 * 按 sessionId 记「上次扫到哪个 seq」。DSH 的 session.seq 是单调的，
 * 用 firstLiveSeq 排除继承来的历史事件（冷启动/重连时的快照里含历史）。
 */
import { note } from './env.js'
import { normalizeConfig, normalizeKind, scoreRecord } from './memory.js'

/** sessionId → 上次扫到的 seq。进程内即可：重启后从「当前 seq」重新开始，不会重复记。 */
const cursors = new Map()

/** 游标表软上限：本地单机 DSH 很少同时活跃超过这么多个会话，超过就整体清空重来。
 *  清空是安全的（下一次只初始化「从当前 seq 开始」，且 addRecord 按文本去重）。 */
const CURSOR_MAX = 200

/** 自动提取的最低重要度（低于这个只算闲聊，不值得占记忆位）。 */
const MIN_IMPORTANCE = 42
/** 太短的不记（「嗯」「好的」「1」）。 */
const MIN_CHARS = 8
/** 太长的不记（多半是粘贴的代码或日志）。 */
const MAX_CHARS = 600

/** 明显不该进记忆的内容：整段代码、命令行、纯符号、报错堆栈、拖进来的文件路径。 */
const NOISE_PATTERNS = [
  /^```/,
  /^\s*[\$>]\s/,
  /^(?:cd|ls|dir|git|npm|node|python|pip|curl)\s/,
  /^[\s\p{P}\p{S}]*$/u,
  /^\s*(?:at\s+\S+\s+\(|Error:|TypeError:|SyntaxError:)/,
  /^\s*[{[][\s\S]*[}\]]\s*$/,
  // 拖文件进对话框时，正文就是路径（实测：「@C:\Users\…\plugins\dsh」被当成一句话记下来了）
  /^@?(?:[A-Za-z]:[\\/]|~[\\/]|\/(?:Users|home|tmp|var)\/)/
]

/**
 * 宿主自己注入的上下文来源 —— 这些 user/message **不是人在说话**，一条都不该进记忆。
 *
 * 2026-10-29 实测（解压 ~/.dsh/sessions 里两个活跃会话，共 124 条 user/message）：
 *   runtime-context 33 条、time-context 12 条、skill-catalog 3 条、
 *   user-approval 1 条、compact-checkpoint 1 条 —— 加起来比真人说的话还多。
 * 不过滤的话，记忆卡会被「当前时间是几月几号」「可用技能清单」这类垃圾塞满。
 */
const INJECTED_SOURCES = new Set([
  'runtime-context', 'time-context', 'time-sampled', 'system-reminder', 'system',
  'skill-catalog', 'user-approval', 'compact-checkpoint', 'tool-registry', 'model', 'plugin'
])

/** 人在说话的来源：真人直接说的，或桥接进来的人话（QQ 桥等）。 */
const HUMAN_SOURCES = new Set(['user', 'qq', 'qq-bridge', 'fishbuddy', 'speak-up'])

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || min))

/**
 * 这条用户消息是不是「主人本人」说的。
 *
 * 本地 DSH 会话里 user/message 默认都是用户 → true。
 * 但经由 QQ 桥接进来的群消息会带前缀（如「（QQ群 123·群友「小明」…）」），
 * 那种不是主人，重要度和标签都不一样 —— 认错了会把群友的闲聊当成主人的偏好记一辈子。
 */
export function isOwnerMessage(text) {
  const body = String(text ?? '')
  if (/群友「/.test(body)) return false
  if (/·QQ \d+）/.test(body) && !/用户本人/.test(body)) return false
  return true
}

/** 从消息内容里取纯文本（DSH 的 content 可能是块数组）。 */
export function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => (block?.type === 'text' ? String(block.text ?? '') : ''))
    .join('')
    .trim()
}

/**
 * 取消息正文 —— **这里 2026-10-29 修过一个致命 bug**。
 *
 * 原来写的是 `event?.data?.message?.content`，但 DSH 的真实事件是
 *
 *   {"type":"user/message","seq":16,"data":{"content":[{"type":"text","text":"…"}],
 *    "source":{"kind":"user"},"role":"user","id":"…"},"surfaceOp":"append"}
 *
 * 正文在 **`data.content`**，`data.message` 根本不存在。
 * 可选链一路吃到 undefined，`textOfContent(undefined)` 返回空串，
 * 于是每一条都 `continue` 掉 —— 表现是：扫描在跑（scanned 有数）、候选永远是 0、
 * 记忆卡一次都没被创建、日志里连句报错都没有。纯静默失效，看文件是查不出来的。
 *
 * 三条路都留着：现在（data.content）、老格式（data.message.content）、
 * 以及另一种宿主写法（payload 而不是 data，mood.js 就是这么兼容的）。
 */
export function messageContentOf(event) {
  const holder = event?.payload !== undefined ? event.payload : event?.data
  if (holder === undefined || holder === null) return undefined
  return holder.content ?? holder.message?.content
}

/** 这条 user/message 的来源标记（拿不到就是空串）。 */
export function sourceKindOf(event) {
  const holder = event?.payload !== undefined ? event.payload : event?.data
  return String(holder?.source?.kind ?? '')
}

/**
 * 这是「人在说话」吗。
 *
 * 不认识的来源一律不记 —— 记忆比心情贵得多（心情每轮覆盖，记忆会留几个月），
 * 宁可漏记一条，也不能让新出现的机器来源悄悄污染记忆卡。
 */
export function isHumanEvent(event) {
  const kind = sourceKindOf(event)
  if (kind === '') return true
  if (INJECTED_SOURCES.has(kind)) return false
  if (HUMAN_SOURCES.has(kind)) return true
  if (/^(subagent|goal|tool-|system-|schedule)/.test(kind)) return false
  return false
}

/**
 * 桥接层的「信封」—— 正文前面那截括号说明。
 *
 * 2026-10-30 解压 QQ 对话会话（930 条事件）拿到的事实：
 *   （QQ 私聊·用户本人 QQ 3472302240）起了起了                 ← 剥掉信封就是正文
 *   （主动搭话：距上次说话已经 6 小时 3 分钟。…就 qq_pass…）    ← 整条都不是人话
 * 两种信封都以英文/中文括号开头，长度很短、不含换行。
 *
 * ⚠️ 剥信封为什么不只是"好看"：括号说明有 20 多字，会把「起了起了」这种
 * 4 个字的短句凑过 8 字门槛 —— 长度过滤直接失效，短句全部混进记忆卡。
 */
const ENVELOPE_RE = /^\s*[（(]([^（）()\n]{0,80})[）)]\s*/

/** 触发模板的特征词：命中就不是人在说话。 */
const TRIGGER_HINTS = /主动搭话|定时任务|距上次说话|qq_pass|系统提示|请判断|这一轮不是/

/**
 * 剥掉桥接信封；是触发模板就整条丢掉。
 *
 * @returns {{ text: string, drop: boolean, reason?: string }}
 */
export function unwrapBridgeText(raw) {
  const body = String(raw ?? '').trim()
  if (body === '') return { text: '', drop: true, reason: '空' }

  const matched = body.match(ENVELOPE_RE)
  if (matched !== null) {
    if (TRIGGER_HINTS.test(matched[1])) return { text: '', drop: true, reason: '主动搭话/定时任务的触发模板' }
    return { text: body.slice(matched[0].length).trim(), drop: false }
  }
  // 有的桥不加括号，直接把模板当正文：整条前 120 字里有特征词就当模板
  if (TRIGGER_HINTS.test(body.slice(0, 120))) return { text: '', drop: true, reason: '触发模板（无信封）' }
  return { text: body, drop: false }
}

/**
 * 取「当前这条用户消息」的正文（2026-10-30，给记忆相关区当 query）。
 *
 * 为什么让 extract.js 出这个函数：这里已经有一套「什么算人话」的判据
 * （source.kind / isHumanEvent / unwrapBridgeText）。注入路径再写一遍，
 * 迟早两套口径漂移 —— 提取时挡掉的注入块，召回时又被当成 query 用。
 *
 * 只认 source.kind === 'user'：本地真人和 QQ 桥接进来的人话都是这个来源；
 * runtime-context / time-context / tool 结果一律不碰。取不到就返回空串，
 * 调用方（index.js）据此退回整卡渲染，绝不注入空段。
 *
 * ⚠️ 时间点：text() 在装配提示词时调用，用户消息此时已经进会话事件。
 * 如果宿主某次装配得比事件落库早，这里会返回空串 → 退整卡，属于安全降级。
 */
export function currentUserText(agent, { lookback = 200 } = {}) {
  const session = agent?.session
  if (session === undefined || session === null) return ''
  let events = []
  try {
    if (typeof session.snapshotEvents === 'function' && typeof session.seq === 'number') {
      const to = session.seq + 1
      const first = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : 0
      const from = Math.max(first, session.seq - Math.max(1, Number(lookback) || 200))
      events = session.snapshotEvents(from, to)
    } else if (Array.isArray(session.events)) {
      events = session.events.slice(-Math.max(1, Number(lookback) || 200))
    }
  } catch {
    /* 读不到事件就当没有，退回整卡 */
    return ''
  }
  if (!Array.isArray(events) || events.length === 0) return ''

  // 2026-10-30：先收窗口内她说过的话，用来识别「桥把她的回复回显成 user/message」。
  // 取法照抄 collectCandidates（:339-347）：两处必须用同一把尺子，
  // 否则提取时挡掉的自言自语，召回时又会被当成 query 用。
  const assistantTexts = []
  for (const event of events) {
    if ((event?.type ?? event?.kind) !== 'assistant/message') continue
    const said = textOfContent(messageContentOf(event))
    if (said !== '') assistantTexts.push(said)
  }

  // 从最新往回找：装配时最后一条 user/message 就是这次要回答的那句
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if ((event?.type ?? event?.kind) !== 'user/message') continue
    if (sourceKindOf(event) !== 'user') continue
    if (!isHumanEvent(event)) continue
    const raw = textOfContent(messageContentOf(event))
    if (raw === '') continue
    const unwrapped = unwrapBridgeText(raw)
    if (unwrapped.drop) continue
    // 2026-10-30：回显挡掉就返回空串（退整卡），不往前翻上一条 ——
    // 那是上一回合的话，拿来当 query 只会召回更不相关的东西。
    if (isEchoOfAssistant(unwrapped.text, assistantTexts)) return ''
    // 2026-10-30：退化保护。去掉空白后不到 4 个字（「嗯」「好的」「1」），
    // bigram 召回几乎必然瞎命中，不如返回空串让注入退回整卡。
    if (unwrapped.text.replace(/\s+/g, '').length < 4) return ''
    if (unwrapped.text !== '') return unwrapped.text
  }
  return ''
}

/** 去掉所有空白与标点的「骨架」，用来判断两句话是不是同一句。 */
const skeletonOf = (s) => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '')

/**
 * 这条 user/message 是不是**她自己刚说过的话被桥回显**。
 *
 * 2026-10-30 实测：她回复「唔…早上好喵~」之后，桥把这句话当成一条 user/message
 * 又投回会话一次（seq 900，source.kind 也是 user，跟真人的消息长得一模一样）。
 * 不挡的话，她的每一句自言自语都会变成"记忆"—— 自我强化的死循环。
 *
 * 判据用骨架比对（剥掉标点空白）：完全相等，或一方包含另一方（桥偶尔会加「（语音）」）。
 * 代价是"主人复述她刚说过的话"会被误判成回显 —— 少见，且丢一条远好过自我强化。
 */
export function isEchoOfAssistant(text, assistantTexts = []) {
  const a = skeletonOf(text)
  if (a.length < 4) return false
  for (const other of assistantTexts) {
    const b = skeletonOf(other)
    if (b.length === 0) continue
    if (a === b) return true
    if (a.length >= 6 && b.length >= 6 && (b.includes(a) || a.includes(b))) return true
  }
  return false
}

/** 值得记吗？返回 { ok, reason }。 */
export function worthRemembering(text, { isOwner = true } = {}) {
  const body = String(text ?? '').trim()
  if (body.length < MIN_CHARS) return { ok: false, reason: '太短' }
  if (body.length > MAX_CHARS) return { ok: false, reason: '太长（可能是粘贴的代码/日志）' }
  for (const pattern of NOISE_PATTERNS) {
    if (pattern.test(body)) return { ok: false, reason: '代码/命令/符号' }
  }
  const scored = scoreRecord({ text: body, isOwner, isPrivate: true })
  if (scored.importance < MIN_IMPORTANCE) {
    return { ok: false, reason: `重要度 ${scored.importance} 低于 ${MIN_IMPORTANCE}` }
  }
  return { ok: true, scored }
}

/**
 * 取「上次扫过之后」的新事件。
 *
 * 边界处理照抄实践出来的结论：
 *   · from 不能早于 firstLiveSeq（否则会把继承的历史事件当成新事件重扫一遍）；
 *   · 上界用 seq + 1 —— DSH 的签名是 toSeqExclusive（开区间），
 *     少取一个正好可能漏掉 turn/end 或最后一条消息。
 */
export function eventsSince(agent, fromSeq) {
  try {
    const session = agent?.session
    if (session === undefined || session === null) return []
    if (typeof session.snapshotEvents === 'function') {
      const first = typeof session.firstLiveSeq === 'number' ? session.firstLiveSeq : 0
      const from = Math.max(Number(fromSeq) || 0, first)
      const to = typeof session.seq === 'number' ? session.seq + 1 : undefined
      const list = to !== undefined ? session.snapshotEvents(from, to) : session.snapshotEvents(from)
      return Array.isArray(list) ? list : []
    }
    if (Array.isArray(session.events)) {
      return session.events.filter((event) => Number(event?.seq) > Number(fromSeq))
    }
  } catch {
    /* 读不到就算了，下一回合再试 */
  }
  return []
}

/** 当前会话最大的 seq（用于初始化游标）。 */
export function maxSeqOf(agent) {
  try {
    const session = agent?.session
    if (session !== undefined && session !== null && typeof session.seq === 'number') return session.seq
  } catch {
    /* 忽略 */
  }
  const events = eventsSince(agent, -1)
  return events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
}

/**
 * 扫一个会话，返回这一轮新提取到的候选记忆。
 *
 * @returns {{ candidates: {text, isOwner, scored}[], scanned: number, from: number, to: number }}
 */
export function collectCandidates(agent, { limit = 12 } = {}) {
  // 游标表防泄漏：长期进程里会话会越攒越多，先回收再继续
  if (cursors.size > CURSOR_MAX) cursors.clear()

  const sessionId = String(agent?.session?.header?.id ?? agent?.session?.id ?? '')
  const key = sessionId !== '' ? sessionId : 'default'
  let from = cursors.get(key)
  if (from === undefined) {
    // 第一次见这个会话：把游标推到当前位置，只往后看。
    // 为什么不回扫历史：会话可能有几千条旧事件，一上来全扫一遍会把卡灌满。
    from = maxSeqOf(agent)
    cursors.set(key, from)
    return { candidates: [], scanned: 0, from, to: from }
  }

  const events = eventsSince(agent, from)
  if (events.length === 0) return { candidates: [], scanned: 0, from, to: from }

  const to = events.reduce((max, event) => Math.max(max, Number(event?.seq) || 0), 0)
  // 游标记「下一个还没扫的 seq」，不是「最后一个扫过的」。
  // eventsSince → snapshotEvents(from, to) 是闭区间（e.seq >= from），
  // 存 to 的话下一轮 from = to 会把最后那条再扫一遍：同一条消息进两次候选，
  // recallCount 被莫名 +1，留存和「被提及次数」全都虚高。
  cursors.set(key, to + 1)

  // 先收一遍这一轮里她说的话：用来识别「桥把她的回复回显成 user/message」。
  // 只在本窗口内比对 —— 窗口是按 seq 连续切的，一个完整回合的 assistant 消息基本都在里面。
  const assistantTexts = []
  for (const event of events) {
    if ((event?.type ?? event?.kind) !== 'assistant/message') continue
    const said = textOfContent(messageContentOf(event))
    if (said !== '') assistantTexts.push(said)
  }

  const candidates = []
  for (const event of events) {
    // 字段名兼容 type / kind：mood.js 就是这么写的，说明两种都见过
    if ((event?.type ?? event?.kind) !== 'user/message') continue
    if (!isHumanEvent(event)) continue
    const raw = textOfContent(messageContentOf(event))
    if (raw === '') continue
    // 剥掉桥接信封（剥完的正文才是记忆素材）、丢掉触发模板
    const unwrapped = unwrapBridgeText(raw)
    if (unwrapped.drop) continue
    const text = unwrapped.text
    // 她自己刚说过的话被桥回显成 user/message —— 那不算记忆，算自我强化
    if (isEchoOfAssistant(text, assistantTexts)) continue
    // 认人要用原文：「群友「小明」」这类判断信息在信封里，剥掉就没了
    const isOwner = isOwnerMessage(raw)
    const verdict = worthRemembering(text, { isOwner })
    if (!verdict.ok) continue
    candidates.push({ text, isOwner, scored: verdict.scored, seq: Number(event?.seq) || 0 })
  }

  // 按分数取前 N 条；同一轮里长的往往信息更多，同分时优先长的
  candidates.sort((a, b) => b.scored.importance - a.scored.importance || b.text.length - a.text.length)
  return { candidates: candidates.slice(0, clamp(limit, 1, 30)), scanned: events.length, from, to }
}

/** 清空游标（测试用 / 会话切换时）。 */
export function resetCursor(sessionId) {
  if (sessionId === undefined) cursors.clear()
  else cursors.delete(String(sessionId))
}

/**
 * 这条记忆该不该**同时**进全局卡。
 *
 * 原因（2026-10-29 发现的缺口）：自动提取只按「cwd 是否为空」决定写哪张卡，
 * 而实际使用里每个对话都有工作区 → 全局卡一个字都进不去。
 * 后果是换个工作区就完全失忆，「树树是烟台大学机器人工程大二」这种跟项目无关的事，
 * 会在每个项目卡里各记一遍，彼此不知道对方存在。
 *
 * 判据：
 *   · tags 含 fact（长期事实：目标 / 专业 / 习惯 / 身份）→ 无条件合格。
 *     这类换到任何工作区都该认得你，不该受分数门槛限制。
 *   · 其余要同时满足：tags 含 self（关于你自己的偏好或情况，跟项目无关）
 *     + 重要度过线（闲聊级的不值得占全局预算）。
 * 调用方还会再查一眼：只有当前写的是项目卡时才需要双写。
 */
export function isPromotable(candidate, importance = 62) {
  const tags = Array.isArray(candidate?.scored?.tags) ? candidate.scored.tags : []
  if (tags.includes('fact')) return true
  if (!tags.includes('self')) return false
  return (Number(candidate?.scored?.importance) || 0) >= (Number(importance) || 62)
}

/**
 * 当前 agent 是不是子会话（subagent 派出去的那次执行）。
 *
 * 2026-10-30：字段名核实过，不是猜的 —— DSH 的 session header 校验里写着
 * `record.origin !== undefined && record.origin !== 'subagent'` 直接抛错
 * （dsh-session/lib/types/index.js 的 validateSessionHeader），也就是说
 * origin 只有 'subagent' 这一个合法值。dsh-persona 里也有同名的
 * includeRuntimeContext 开关，但那跟这里无关。
 *
 * 为什么要在入口处挡：子会话是一次性任务上下文，不是「她」在跟主人聊天。
 * 让它注入整张记忆卡 = 白烧它的任务预算；让它跑提取 = 把子任务的中间对话
 * 记成长期记忆；让它跑心情判定 = 把子任务的情绪记到主会话头上。
 */
export function isSubagentSession(agent) {
  return agent?.session?.header?.origin === 'subagent'
}

// ---------------------------------------------------------------------------
// 落库前的硬过滤（2026-10-30）
//
// 提示词（refine.js）已经写清了「只记换一天还成立的」，但提示词是软约束：
// 模型会照抄任务，或者把「帮我改插件」换个说法留下来。这里用规则兜底 ——
// 命中就整条丢弃，不进卡。**判据全部来自用户当场抓到的那三条垃圾记忆**：
//   ① 祈使句：帮我 / 请你 / 麻烦你 / 给我 / 你帮我
//   ② 代码目标的改动动作：插件|代码|文件|仓库 + 修改|检测|重构|提交|推送|修一下…
//      —— 整条带人物属性（喜欢/习惯/目标/专业…）时放行：那是在说人，不是在下任务
//   ③ 「对…进行…」开头的动作句
//   ④ 工作进度 / 时间锚点：最近在排查 X、下一步要做 Y、今天 / 刚才 / 这一轮
//
// 为什么口径偏「宁可误杀」：记忆卡是有预算的长期资产。
// 丢一条真记忆只是少记一件事；收一条任务垃圾会长期占位，还会顶着标签进注入。
const IMPERATIVE_RE = /^(?:请|麻烦|帮我|给我|你帮我|帮忙)|(?:帮我|请你|麻烦你|麻烦帮|请帮|给我|你帮我)/
const CODE_TARGET_RE = /插件|代码|脚本|文件|仓库|源码/
const CODE_ACTION_RE = /修改|检测|重构|提交|推送|修复|修一下|改一下|调试|部署|合并|回滚|跑一下|测一下|实现|写一个|改个/
const DO_ACTION_RE = /^对[^，。；！？\n]{1,40}?(?:进行|做)(?:一下|一次|个|最后一回)?/
const WORK_STATE_RE = /最近在(?:排查|弄|搞|做|改|调|忙|写)|正在(?:排查|弄|搞|改|调|写|查)|还在(?:弄|搞|排查|改)|下一步|接下来要|待会儿|等会儿|这一轮|刚才|刚刚|今天|今晚/
/** 「这条在说人」的人物属性 —— 命中就不当任务句丢（人比任务值钱）。 */
const PERSONAL_RE = /喜欢|讨厌|习惯|目标|专业|大学|学院|年级|生日|怕|不敢|爱吃|过敏|打算|计划|理想|梦想|作息|熬夜|朋友|家人|室友|导师/

/**
 * 这条候选该不该被硬过滤掉。
 *
 * @returns {string|null} 丢弃原因；null = 放行
 */
export function autoMemoryRejectReason(text) {
  const body = String(text ?? '').trim()
  if (body === '') return '空'
  if (IMPERATIVE_RE.test(body)) return '祈使句（用户让我干活，不是关于他的信息）'
  if (DO_ACTION_RE.test(body)) return '「对…进行…」动作句'
  if (CODE_TARGET_RE.test(body) && CODE_ACTION_RE.test(body) && !PERSONAL_RE.test(body)) {
    return '代码/插件的改动进度'
  }
  if (WORK_STATE_RE.test(body)) return '当次工作状态 / 时间锚点'
  return null
}

/**
 * 自动记忆的最低重要度，按 kind 分档。
 *
 * 阈值只在 memory.js 的 DEFAULTS 里定义一次（autoImportanceEvent / autoImportanceDefault），
 * 这里只负责挑哪一档 —— 不许在调用方散写 42 / 70 这种魔数。
 */
export function minImportanceForKind(kind, config = {}) {
  const cfg = normalizeConfig(config)
  return normalizeKind(kind) === 'event' ? cfg.autoImportanceEvent : cfg.autoImportanceDefault
}

/** 把候选写进卡里，返回写入条数。调用方负责存盘。 */
export function ingestCandidates(card, addRecord, candidates, config, now = Date.now()) {
  const cfg = normalizeConfig(config)
  let written = 0
  let dropped = 0
  for (const candidate of candidates) {
    // 2026-10-30：任务 / 进度 / 时间锚点一律不进卡（见上面 autoMemoryRejectReason）
    if (autoMemoryRejectReason(candidate?.text) !== null) {
      dropped += 1
      continue
    }
    // 这条路不提炼，候选本来就没有 kind（undefined）→ 归一成 'event'，
    // 于是按 event 的门槛（默认 70）卡，比原来的 42 严得多。
    const kind = normalizeKind(candidate?.kind)
    const importance = Number(candidate?.scored?.importance) ||
      scoreRecord({ text: String(candidate?.text ?? ''), isOwner: candidate?.isOwner === true, isPrivate: true }).importance
    if (importance < minImportanceForKind(kind, cfg)) {
      dropped += 1
      continue
    }
    const result = addRecord(card, {
      text: candidate.text,
      isOwner: candidate.isOwner,
      isPrivate: true,
      source: 'auto',
      kind: candidate.kind
    }, config, now)
    if (result?.ok === true) written += 1
  }
  if (written > 0) note('extract', `自动记下 ${written} 条（扫描 ${candidates.length} 个候选）`)
  if (dropped > 0) note('extract', `过滤掉 ${dropped} 条任务/进度类候选（宁可少记）`)
  return written
}
