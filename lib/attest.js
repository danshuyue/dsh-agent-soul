/**
 * attest.js —— 装配证词（2026-11-02）。
 *
 * ── 为什么要这个东西 ──
 *   soul 的四段（人格 / 记忆 / 笔记 / 目的）都是 systemPrompt.context 的 `text()` 函数。
 *   `text()` 返回什么，插件自己看得见；但「这段文本有没有真的进最终系统提示词」，
 *   它**一个字都看不见**。
 *
 *   这跟 2026-10-31 那个日记 bug 是同一类病：程序没崩，就当成了送到了。
 *   那天是一行「已发送」的日志骗了人；今天是「我返回了文本」这件事，
 *   被当成了「模型收到了文本」。这两件事之间隔着装配、过滤、覆盖三道闸门。
 *
 * ── 怎么拿到硬证据 ──
 *   在 `system-prompt/assemble` 的 waterfall 最外层（prepend）等 `next()` 返回，
 *   然后直接读 `assembly.contexts` —— 那就是这一次装配**真实携带**的上下文清单。
 *
 *   为什么这样读是安全的：
 *     · `contexts` 在进入 waterfall 之前就已经 resolve 成 `{ name, text }`，
 *       也就是说 `text()` 已经跑完了。我们在 `next()` 之后只做 find + 测长度，
 *       **不会**再调用任何 `text()`，所以不会重复触发提取、心情、提炼这些副作用。
 *     · 只读不写，不碰 sections、不改进出，装配结果逐字节不变。
 *
 * ── 为什么记的是 contexts 而不是 sections ──
 *   DSH 的 `assemble()` 在 waterfall 之后还有一手：如果有段声明了 `complete: true`，
 *   所有 sections 会被压成 `[那一段]`。但 contexts 只按 `required` 过滤，
 *   不受 complete 影响。soul 四段都声明了 `required: true`，所以哪怕在
 *   `minimal` 这类 preset 下也能活下来。这条差别正好说明：
 *   **拿 sections 当证据会误报，拿 contexts 才是对的。**
 *   （顺带把「sections 被压成单段」这个事实记下来，免得有人看到总览只有一段，
 *    以为 soul 没生效。）
 *
 * ── 为什么只在内存里，不落盘 ──
 *   这是运行时诊断，不是持久数据。重启后第一次装配就会重建，落盘只会多一个
 *   可能写坏的地方。要回查历史，`note()` 的日志里已经留了转折点那几行。
 */
import { note } from './env.js'
import { shortHash } from './paths.js'
import { mark } from './evidence.js'

/** 要盯的四段：名字必须与 index.js 里注册的完全一致。 */
const WATCHED = [
  ['soul:persona', '人格'],
  ['soul:memory', '记忆'],
  // 2026-11-04 补：笔记段是 11-04 新加的第四段，这里漏了的话
  // 「装配证词」永远不会提它 —— 观测器白跑一场，而它存在的意义正是
  // 「哪一段真的进了装配」。段名必须和 index.js 的 registerApi 里注册的一致。
  ['soul:notes', '笔记'],
  ['soul:purpose', '目的']
]

/** 历史环形上限。够看清「哪一轮开始掉的」，又不至于吃内存。 */
const HISTORY_CAP = 20

let last = null
let history = []
let lastLogged = null

/** 把四段拼成一句人话，日志和接口共用。 */
function describe(snapshot) {
  const parts = snapshot.items.map((item) => {
    if (item.state === 'present') return `${item.label} ${item.chars} 字`
    if (item.state === 'blank') return `${item.label} 空串`
    return `${item.label} 缺席`
  })
  const carried = snapshot.items.filter((item) => item.state === 'present').length
  return `${parts.join(' · ')}（${carried}/${snapshot.items.length} 到位）`
}

/**
 * 记录一次装配的结果。
 *
 * 由 index.js 的 `system-prompt/assemble` 监听器在 `next()` 之后调用。
 * 任何异常都不该冒出去 —— 诊断把自己搞崩，比没有诊断更糟。
 *
 * @param {object} assembly waterfall 返回的装配结果（含 sections / contexts）
 * @param {object} context 装配上下文（含 agent）
 * @returns {object|null} 本次快照；入参不可读时返回 null
 */
export function recordAssembly(assembly, context) {
  try {
    if (assembly === null || typeof assembly !== 'object') return null
    const contexts = Array.isArray(assembly.contexts) ? assembly.contexts : []
    const sections = Array.isArray(assembly.sections) ? assembly.sections : []

    const items = WATCHED.map(([name, label]) => {
      const entry = contexts.find((item) => item !== null && typeof item === 'object' && item.name === name)
      if (entry === undefined) return { name, label, state: 'missing', chars: 0 }
      const text = typeof entry.text === 'string' ? entry.text : ''
      return { name, label, state: text.length === 0 ? 'blank' : 'present', chars: text.length }
    })

    const carried = items.filter((item) => item.state === 'present').length
    const verdict = carried === 0 ? 'absent' : carried === items.length ? 'full' : 'partial'

    // preset 声明了 complete:true → 内置段被压成单段。
    // 只用来「解释现象」，不参与 soul 自己有没有进去的判断。
    //
    // 这是个**启发式**，不是硬证据：判据是「sections 只剩一段、且那一段不是 soul:*」。
    // 理论上一个只注册了单一 section、又没声明 complete 的 preset 会误报。
    // 但 DSH 正常装配（standard 等）都是多段，单段基本只可能来自 complete 覆盖，
    // 而且 collapsed 只影响日志里那句解释，不改变 verdict —— 误报的代价是话说重了，
    // 不是结论错了。要更硬的判据得读 section.complete，那个字段在装配输出里不保留。
    const collapsed = sections.length === 1
      && sections[0] !== null
      && typeof sections[0] === 'object'
      && !WATCHED.some(([name]) => sections[0].name === name)

    // last / history 都是**进程级单例**，不按会话分桶。
    // 也就是说：多个会话交替装配时，`last` 指的是「全进程最近一次装配」，
    // 不一定是当前这个会话的 —— 要区分就看快照里的 sessionId。
    // 为什么不按会话分桶：装配本来就该被每个会话各跑一遍，分桶会让「最近一次」
    // 变得含糊，而且内存要按会话数涨。现在的取舍是「全局最近一次 + 带 sessionId」，
    // 够定位，也够便宜。
    const snapshot = {
      at: Date.now(),
      sessionId: String(context?.agent?.session?.header?.id ?? ''),
      cwd: String(context?.agent?.session?.header?.cwd ?? ''),
      verdict,
      collapsed,
      items,
      totalChars: items.reduce((sum, item) => sum + item.chars, 0)
    }

    last = snapshot
    // 2026-11-10 R18-C：四段进了装配 = 各自开关的最硬动态证据
    // （「我返回了文本」不算，「模型收到了」才算 —— 本模块存在的意义）。
    for (const item of items) {
      if (item.state === 'present') mark(item.name, `${item.chars} 字`)
    }
    history.push(snapshot)
    if (history.length > HISTORY_CAP) history.splice(0, history.length - HISTORY_CAP)

    // 只在「值得抬头看」的时刻留一行日志：
    //   · 第一次有记录；
    //   · 掉成 absent（四段全没了）；
    //   · 从 absent 回来；
    //   · complete 冻结状态翻转。
    //
    // full ↔ partial 之间**不算**转折：人格本来就是首轮注入、之后每
    // PERSONA_REFRESH_TURNS 轮补一次，记忆在子会话里也会返回空串 ——
    // 这些都在设计内。每轮都写等于把日志灌满，真正要看的「哪一轮全掉了」
    // 反而被淹掉。
    const first = lastLogged === null
    const degraded = lastLogged !== null && verdict === 'absent' && lastLogged.verdict !== 'absent'
    const recovered = lastLogged !== null && lastLogged.verdict === 'absent' && verdict !== 'absent'
    const flipped = lastLogged !== null && collapsed !== lastLogged.collapsed
    if (first || degraded || recovered || flipped) {
      const suffix = collapsed ? '；该会话 preset 声明了 complete，内置段已被压成单段（soul 走 contexts，不受影响）' : ''
      note('attest', `装配证词：${describe(snapshot)}${suffix}`)
    }
    lastLogged = snapshot
    return snapshot
  } catch (error) {
    note('attest', `装配证词记录失败：${error instanceof Error ? error.message : error}`)
    return null
  }
}

/**
 * 读最近一次证词 + 历史。
 *
 * `last === null` 有确切的含义：**一次装配都没观测到**。
 * 这不是「没注入」，是「连观测器都没跑起来」—— 看门狗自己死了，
 * 和它报警是两件事，接口必须把它们分开报。
 */
export function attestationState({ includeHistory = false } = {}) {
  // 2026-11-06 审计 P2-14：这个接口原来把 sessionId 和 cwd 原样吐给客户端。
  // 会话 id 是宿主内部标识，设置页只需要「哪一轮掉了」—— 摘要成短哈希，
  // 仍可区分不同会话，但不再是可用 id。历史默认不回，要看时显式开。
  // 2026-11-10 R20-B（审查 M14）：cwd 也一并摘要 —— sessionId 之外它同样含
  // 绝对路径（目录结构 + 用户名片段），server.js「错误不回显路径」的加固理由
  // 在这里一字不差地成立。
  const scrub = (entry) => {
    if (entry === null || typeof entry !== 'object') return entry
    const { sessionId, cwd, ...rest } = entry
    if (sessionId === undefined) return rest
    return { ...rest, sessionRef: shortHash(String(sessionId)).slice(0, 8), cwdRef: shortHash(String(cwd)).slice(0, 8) }
  }
  return {
    watched: WATCHED.map(([name, label]) => ({ name, label })),
    last: scrub(last),
    history: includeHistory ? history.map(scrub) : [],
    observed: last !== null
  }
}

/** 测试用：清空所有状态。 */
export function __resetAttestationForTest() {
  last = null
  history = []
  lastLogged = null
}
