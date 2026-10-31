/**
 * index.js —— dsh-agent-soul 插件入口。
 *
 * 它做四件事，都在同一个插件里：
 *   1. **人格**：把「项目 AGENT.md / 项目人格 / 全局人格」按小节合并后注入系统提示；
 *   2. **记忆**：把衰减记忆卡渲染成一段注入；同时每回合从会话事件里增量提炼新记忆；
 *   3. **目的**：把「心里惦记的事 + 此刻状态」注入，让她的主动行为有连续性；
 *   4. **心情**：每轮判断一次心情变化（心情值 / 七情 / 时间线），**只记账不注入**。
 *
 * ── 为什么注入用 systemPrompt.context 而不是别的钩子 ──
 *   `text` 是**函数**，每次装配提示词都会调用，并且拿到 `context.agent` ——
 *   于是「不同项目不同人格」「记忆随时间变化」「惦记的事会更新」都天然成立，
 *   不需要会话钩子，也没有缓存过期问题。
 *   DSH 只在渲染文本**变化时**才重新追加这一段，所以稳定前缀的缓存不会被打断。
 *
 * ── 心情为什么也挂在 text() 上但返回空串 ──
 *   心情是「每轮判断一次」的记账模块，不该占提示词预算（用户明确要取消每回合注入）。
 *   但 text() 恰好是每轮都会被调用、又拿得到 agent 的地方 ——
 *   在这里懒挂 turn-stopping 监听（挂一次即可），返回 '' 就等于零注入。
 *
 * ── 注入顺序（order） ──
 *   230 心情钩子（空串） → 240 目的 → 250 记忆 → 260 人格。
 *   先给「我惦记什么、我记得什么」，再给「我是谁」，读起来最自然；
 *   而且人格在最贴近用户消息的位置，压得住前面那些事实性内容。
 */
import { note, serviceOf } from './env.js'
import { composePersona } from './persona.js'
import { collectCandidates, currentUserText, ingestCandidates, isPromotable, isSubagentSession } from './extract.js'
import { refineCandidates } from './refine.js'
import { addRecord, recallQueryTerms, renderRecallOnly } from './memory.js'
import { collectForDiary, startDiaryTimer, runCatchUp, readRecentDiaries, readRecentChat, todayKey } from './diary.js'
import {
  cardsFor,
  globalCard,
  loadConfig,
  maintain,
  projectCard,
  renderMemoryBlockRecalled,
  saveGlobalCard,
  saveProjectCard,
  writeAutoMemories,
  applyMoodDelta
} from './store.js'
import { purposeState, savePurposeState } from './store.js'
import { markServed, satisfyDrives, settleServed, summarize, openGoals, renderPurpose } from './purpose.js'
import { lastAssistantTextOf, observeAgent, unobserveAll, normalizeMoodConfig } from './mood.js'
import { registerMemoryTool, registerGoalTool, setFallbackCwd } from './tool.js'
import { registerApi, registerAssets } from './api.js'

/** 插件名 = 裸包名，必须与 package.json 的 name、cordis.patch.yml 的 name、插件目录名三者一致。 */
export const name = 'dsh-agent-soul'
/** 声明式依赖：没有 inject，读 ctx.systemPrompt / ctx.tools 会直接抛。 */
export const inject = ['systemPrompt', 'tools', 'webServer']

/** 记忆维护的最小间隔（毫秒）：注入每回合都跑，但维护不必。 */
const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000

let lastMaintainAt = 0

/** 提炼链：一次只跑一批，避免两批候选同时改同一张卡。 */
let refineChain = Promise.resolve()

/**
 * 把候选交给模型提炼，再落盘（异步，不阻塞注入）。
 *
 * 为什么不 await：tick 跑在 systemPrompt.context 的 text() 里，是**同步**的、
 * 每回合都要走一遍的路。等一次 30 秒的模型调用 = 每轮对话都卡 30 秒。
 * 所以排队后台跑：这一轮注入用旧卡，下一轮就看得到新记忆。
 *
 * 提炼失败（超时 / 报错 / 格式崩）一律退回原话直存 —— 宁可记糙，不能把信息丢掉。
 */
function queueRefine(agent, cwd, candidates, config, llm) {
  refineChain = refineChain
    .then(async () => {
      const refined = await refineCandidates(llm, agent, candidates, {
        note,
        owner: String(config.moodOwnerName || '树树'),
        provider: String(config.memoryRefineProvider || ''),
        model: String(config.memoryRefineModel || '')
      })
      if (refined === null) {
        note('memory', `提炼失败，${candidates.length} 条候选退回原话直存`)
        ingestRaw(cwd, candidates, config)
        return
      }
      if (refined.length === 0) {
        // 2026-10-31：原来只记「候选 N 条，没提炼出值得记的」—— 数字有了，
        // **内容没了**。她永远不知道自己哪句话被当成废话丢掉了。
        // 现在把每条候选的开头记下来，至少能回头看「当时被丢掉的是什么」。
        // 这不是要推翻提炼的判断，是让「被丢弃」这件事本身留下证据。
        const preview = candidates
          .slice(0, 5)
          .map((c) => {
            const text = String(c?.text ?? c?.content ?? c ?? '').replace(/\s+/g, ' ').trim()
            return text === '' ? '（空）' : text.slice(0, 40) + (text.length > 40 ? '…' : '')
          })
          .join(' ｜ ')
        note('memory', `候选 ${candidates.length} 条，没提炼出值得记的（寒暄/废话）。被丢弃的内容：${preview || '（空）'}`)
        return
      }
      const report = writeAutoMemories(cwd, refined, config)
      if (report.written > 0) {
        note('memory', `提炼出 ${report.written} 条记忆（候选 ${candidates.length}）${report.promoted > 0 ? `，${report.promoted} 条进全局卡` : ''}`)
      }
    })
    .catch((error) => {
      note('memory', `提炼链失败：${error instanceof Error ? error.message : error}`)
    })
}

/**
 * 老的直存路径：候选原话直接进卡（不提炼）。
 *
 * 只在「没有模型服务」或「配置里关了提炼」时走 —— 也是提炼失败时的兜底。
 * 自动记进**项目卡**（有 cwd 时），否则全局卡：跟随当前工作上下文，避免跨项目污染。
 */
function ingestRaw(cwd, candidates, config) {
  const useProject = String(cwd ?? '').trim() !== '' && config.projectMemoryEnabled !== false
  const card = useProject ? projectCard(cwd) : globalCard()
  const written = ingestCandidates(card, addRecord, candidates, config, Date.now())
  if (written > 0) {
    if (useProject) saveProjectCard(cwd, card)
    else saveGlobalCard(card)
  }

  // ---- 跨工作区双写（2026-10-29） ----
  // addRecord 按文本去重，重复写只是刷新召回次数，不会堆条目。
  if (useProject) {
    const threshold = config.globalPromoteImportance ?? 62
    const promo = candidates.filter((candidate) => isPromotable(candidate, threshold))
    if (promo.length > 0) {
      const gcard = globalCard()
      const promoted = ingestCandidates(gcard, addRecord, promo, config, Date.now())
      if (promoted > 0) {
        saveGlobalCard(gcard)
        note('extract', `跨工作区记下 ${promoted} 条（重要度 ≥ ${threshold} 且关于本人）`)
      }
    }
  }
}

/** 每个会话已经「想起来过」的记忆（原文），避免同一件事连着好几轮刷屏。 */
const recallSeenBySession = new Map()

// ---- 粘性召回（2026-10-30） ----
//
// 问题：DSH 只在**整段运行时快照文本变化时**才重新追加一条 user/message
// （RuntimeContextProjection.project 里 `if (this.retained?.text === snapshot) return`）。
// 记忆段的相关区是拿「当前这句话」算出来的，句句不同 → 快照每轮都变 →
// 每轮都追加一条，历史里越堆越多，等于每轮重付一遍。
//
// 做法：话题没变就**不重算**，直接返回上次那段文本（必须逐字节一致，
// 不能重新拼串 —— 拼接顺序、时间戳、标点差一个字节都不算「没变」）。
// 只有用户明显换了话题才重算相关区。
//
// 为什么 key 必须用 session id：这张表里存的是别人会话的记忆原文，
// 串一次就是把 A 的私事塞进 B 的提示词。取不到 id 就一律不粘（见 text() 里）。
const stickyRecallBySession = new Map()
/** 表上限：会话开多了不能一直涨；超了按最久未用淘汰。 */
const STICKY_MAX_SESSIONS = 32
/** 话题重合度阈值：Jaccard ≥ 0.6 视为「还是这个话题」。 */
const STICKY_TOPIC_JACCARD = 0.6
/** 复用日志的限频：同一会话 10 分钟内只记一次，别把日志刷成噪音。 */
const STICKY_NOTE_INTERVAL_MS = 10 * 60 * 1000

/**
 * 两个词集合的 Jaccard 相似度 = |A∩B| / |A∪B|。
 *
 * 选 Jaccard 而不是「命中数 / 上次词数」：后者对「这次句子特别长」不敏感 ——
 * 只要把上次的词全说一遍，再堆一堆新词进去也还是 1.0，话题其实早换了。
 * 分母用并集，新词多就自然掉下来。
 *
 * @param {Set<string>} a 上次召回用的词集合
 * @param {Set<string>} b 这次召回用的词集合
 */
function jaccardOf(a, b) {
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const term of a) if (b.has(term)) intersection += 1
  return intersection / (a.size + b.size - intersection)
}

/**
 * 取（或建）一个会话的粘性状态，顺手做 LRU 淘汰。
 *
 * 状态字段：
 *   · terms    —— 上次用于召回的词集合，下次算 Jaccard 用；
 *   · text     —— 上次注入的完整文本，命中时**原样返回**；
 *   · rendered —— 有没有「上次」可沿用。空串也是一次有效渲染，
 *                 不能拿 text === '' 当「没渲染过」，否则没召回出东西的会话
 *                 每轮都会退整卡。
 *   · lastUsedAt / lastNoteAt —— 淘汰顺序与日志限频。
 */
function stickyStateFor(sessionId, now) {
  const existed = stickyRecallBySession.get(sessionId)
  if (existed !== undefined) {
    existed.lastUsedAt = now
    return existed
  }
  const state = { terms: new Set(), text: '', rendered: false, lastUsedAt: now, lastNoteAt: 0 }
  stickyRecallBySession.set(sessionId, state)
  if (stickyRecallBySession.size > STICKY_MAX_SESSIONS) {
    let oldestId = ''
    let oldestAt = Infinity
    for (const [id, item] of stickyRecallBySession) {
      if (id === sessionId) continue
      if (item.lastUsedAt < oldestAt) {
        oldestAt = item.lastUsedAt
        oldestId = id
      }
    }
    if (oldestId !== '') stickyRecallBySession.delete(oldestId)
  }
  return state
}

/**
 * 「因话题未变而复用上次注入」记一次日志（限频）。
 *
 * 这条是判断粘性到底有没有生效的唯一依据：日志里出现了，说明某一轮真的没重算；
 * 一直不出现，要么话题一直在跳，要么判定逻辑根本没跑到。
 */
function noteStickyReuse(sessionId, state, now) {
  if (now - state.lastNoteAt < STICKY_NOTE_INTERVAL_MS) return
  state.lastNoteAt = now
  note('memory', `话题未变，复用上次记忆注入（会话 ${sessionId.slice(0, 8)}，${state.text.length} 字）`)
}

/**
 * 短于 4 字的 query 当退化情况处理（「嗯」「好的」「继续」这类）。
 *
 * 它们切不出有意义的词集合，Jaccard 恒为 0 —— 拿去重算只会让文本在
 * 「空串 ↔ 某条记忆」之间来回抖，等于每轮都追加一条快照。
 */
function isDegenerateQuery(query) {
  return String(query ?? '').trim().length < 4
}

/**
 * 新会话第一轮额外注入的「最近」（2026-10-31）。
 *
 * 补的是这条断层：树树不会在一个对话里做完所有事 —— 修插件、QQ 聊天、
 * 闲聊是分开的会话。记忆卡给的是零碎事实（「树树大二」「不喜欢机械」），
 * 日记又只写到「昨天」。所以新开一个对话时，她不知道今天早些时候
 * 在别的对话里做过什么，也不知道昨天具体是怎么过的。
 *
 * 这里并两块：
 *   ① 前几天的日记（叙事，接得上「昨天我们干了什么」）
 *   ② 今天到目前为止的流水（conversations/<今天>.jsonl 是所有会话汇总的）
 *
 * 只在第一轮注入，不每轮重复。私密日记默认不进（见配置项）。
 *
 * @returns {string} 空串 = 没有可注入的内容
 */
function renderRecentSection(cfg) {
  try {
    const days = Number(cfg.memoryRecentDiaryDays)
    const chatChars = Number(cfg.memoryRecentChatChars)
    const today = todayKey(Date.now())
    const parts = []

    if (Number.isFinite(days) && days > 0) {
      const recent = readRecentDiaries(today, Math.min(Math.trunc(days), 7))
      const raw = cfg.memoryRecentDiaryIncludePrivate === true ? recent.all : recent.public
      const body = typeof raw === 'string' ? raw.trim() : ''
      if (body !== '') {
        // 日记正序拼接（旧在前），尾部才是最近的 —— 超长时留尾部。
        // 上限 6000 字：两三篇日记正常够用，异常长的也不会把开场撑爆。
        const capped = body.length > 6000 ? `（更早的部分已省略）\n\n${body.slice(-6000)}` : body
        parts.push(`### 前几天的日记\n\n${capped}`)
      }
    }

    if (Number.isFinite(chatChars) && chatChars > 0) {
      const chat = readRecentChat(today, Math.min(Math.trunc(chatChars), 12000))
      if (typeof chat === 'string' && chat.trim() !== '') {
        parts.push(`### 今天到目前为止（可能来自别的对话）\n\n${chat.trim()}`)
      }
    }

    if (parts.length === 0) return ''
    return `\n\n## 最近\n\n${parts.join('\n\n')}`
  } catch (error) {
    note('memory', `注入「最近」失败：${error instanceof Error ? error.message : error}`)
    return ''
  }
}

/** 第一轮之后的「想起来了」：按当前这句话召回，并排除本会话已经说过的。 */
function recallForTurn(cwd, cfg, query, sessionId) {
  let seen = recallSeenBySession.get(sessionId)
  if (seen === undefined) {
    if (recallSeenBySession.size > 200) recallSeenBySession.clear()
    seen = new Set()
    recallSeenBySession.set(sessionId, seen)
  }
  // cardsFor 返回的是 { scope, card } 包一层的外壳，renderRecallOnly 要的是裸卡数组。
  // 2026-10-30 修：以前直接把外壳传进去，被它的 Array.isArray(card.records) 过滤掉，
  // 这条「第一轮之后唯一的记忆通路」一直是空跑 —— 日志不报错，只是永远想不起来。
  const cards = cardsFor(cwd).map((entry) => entry.card)
  const recalled = renderRecallOnly(cards, { config: cfg, query, exclude: seen })
  if (recalled.text === '') return ''
  for (const key of recalled.keys) seen.add(key)
  return recalled.text
}

/**
 * 每个会话的扫描游标（2026-10-31）。
 *
 * 只扫「上次之后新增的事件」，不每次从头数 —— text() 是同步的装配路径，
 * 长会话全量重扫等于每一步都白跑几千条事件。
 * 表要有上限：会话开多了不能一直涨。
 */
const turnCursorBySession = new Map()

/**
 * 这个会话是不是还停在「第一轮对话」里（2026-10-30，2026-10-31 改增量）。
 *
 * 判据是「会话里出现过几条真人 user/message」：
 *   ① 同一轮内会装配多次（重试 / 标题生成），用调用计数会被提前消耗掉；
 *   ② 冷启动恢复的会话仍有历史，天然不会再注入整卡；
 *   ③ 游标按 seq 单调推进，压缩/裁剪造成的断档不会让判断倒退。
 * 读不到事件时返回 true（宁可多注入一次，也不让新会话失忆）。
 */
function isFirstTurnOfSession(agent) {
  const session = agent?.session
  if (session === undefined || session === null) return true
  const seq = Number(session.seq)
  if (!Number.isFinite(seq)) return true
  const id = String(session.header?.id ?? '')
  if (id === '') return true

  let state = turnCursorBySession.get(id)
  if (state === undefined) {
    if (turnCursorBySession.size > 200) turnCursorBySession.clear()
    // cursor = -1：第一次见到这个会话，从最早开始扫一次，把真实条数拿到
    state = { cursor: -1, human: 0 }
    turnCursorBySession.set(id, state)
  }

  let events = []
  try {
    if (typeof session.snapshotEvents === 'function') {
      // snapshotEvents(from, to) 是半开区间，和 extract.js 的 currentUserText 同款用法
      events = session.snapshotEvents(Math.max(0, state.cursor + 1), seq + 1) || []
    } else if (Array.isArray(session.events)) {
      events = session.events.filter((event) => {
        const at = Number(event?.seq)
        return Number.isFinite(at) ? at > state.cursor : true
      })
    } else {
      return true
    }
  } catch {
    return true
  }

  if (!Array.isArray(events)) return true
  for (const event of events) {
    const kind = event?.type ?? event?.kind
    if (kind !== 'user/message') continue
    const sourceKind = event?.source?.kind ?? event?.payload?.source?.kind ?? event?.data?.source?.kind
    // 没有 source 信息的老事件也算一轮：判宽一点，别把第二轮当成第一轮
    if (sourceKind === undefined || sourceKind === 'user') state.human += 1
  }
  state.cursor = Math.max(state.cursor, seq)
  return state.human <= 1
}

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
const PERSONA_REFRESH_TURNS = 15
const personaInjectAtBySession = new Map()

/**
 * 这次该不该注入人格段。
 *
 * @returns {boolean} true = 注入（并记下这次的位置）
 */
function shouldInjectPersona(agent) {
  // 先跑一次 isFirstTurnOfSession：它会把 human 计数推进到最新
  const first = isFirstTurnOfSession(agent)
  const id = String(agent?.session?.header?.id ?? '')
  if (id === '') return true

  const human = turnCursorBySession.get(id)?.human ?? 0
  const last = personaInjectAtBySession.get(id)

  // 同一轮内会装配多次（重试 / 标题生成）。已经为这个 human 计数注入过，
  // 就不要再注入一遍 —— 否则「省消耗」反而变成一轮发好几份人格。
  if (last !== undefined && human === last) return false

  // 首轮、或从来没记过注入点（重启后 Map 是空的，补一次）、或隔得够远了
  if (first || last === undefined || human - last >= PERSONA_REFRESH_TURNS) {
    if (personaInjectAtBySession.size > 200) personaInjectAtBySession.clear()
    personaInjectAtBySession.set(id, human)
    return true
  }
  return false
}

/** 注入时的轻量维护：衰减/压缩按自己的节奏，提取每回合都做（增量，很便宜）。 */
function tick(agent, cwd, config, { allowMaintain = true, llm = null } = {}) {
  // 子会话整段跳过：不维护、不提取、不写日记。
  // 这是「会不会产生写入」的唯一收敛点 —— 判断只写在这里，别在调用方散写。
  if (isSubagentSession(agent)) return
  const now = Date.now()
  if (allowMaintain && now - lastMaintainAt > MAINTAIN_INTERVAL_MS) {
    lastMaintainAt = now
    try {
      const report = maintain(cwd, config)
      if (report.decayed.length > 0 || report.compacted.length > 0) {
        note('tick', `维护完成：衰减 ${report.decayed.join('/') || '无'}，压缩 ${report.compacted.length} 处`)
      }
    } catch (error) {
      note('tick', `维护失败：${error instanceof Error ? error.message : error}`)
    }
  }

  if (agent === undefined || agent === null) return
  try {
    const { candidates } = collectCandidates(agent, { limit: config.maxPerTick ?? 12 })
    if (candidates.length === 0) return
    // 有模型就走「提炼成记忆」；没有模型 / 关掉了就退回原话直存（老路径，不丢信息）
    if (llm !== null && llm !== undefined && config.memoryRefine !== false) {
      queueRefine(agent, cwd, candidates, config, llm)
    } else {
      ingestRaw(cwd, candidates, config)
    }
  } catch (error) {
    note('extract', `提取失败：${error instanceof Error ? error.message : error}`)
  }

  // ---- 日记：顺手把新对话追加到当天 JSONL ----
  // 游标独立于 extract.js，不干扰记忆提取。收 user/message + assistant/message，
  // 过滤口径与 extract.js 一致（跳过 runtime-context / schedule 等注入消息）。
  try {
    collectForDiary(agent)
  } catch (error) {
    note('diary', `对话记录失败：${error instanceof Error ? error.message : error}`)
  }
}

export function apply(ctx) {
  note('apply', `启动 pid=${process.pid} node=${process.version}`)
  const config = loadConfig()

  try {
    registerApi(ctx)
  } catch (error) {
    // API 注册失败不该连累注入
    note('api', `注册失败：${error instanceof Error ? error.message : error}`)
  }

  try {
    registerAssets(ctx)
  } catch (error) {
    // 表情图挂了也只是设置页缺图，不影响心情记账
    note('api', `表情图注册失败：${error instanceof Error ? error.message : error}`)
  }

  registerMemoryTool(ctx)
  registerGoalTool(ctx)

  if (config.enabled === false) {
    note('apply', '配置里 enabled=false，只注册 API 与工具，不注入')
    return
  }

  // llm 服务提前取：心情判断要用（异步），记忆提炼也要用（异步）。
  // 拿不到不影响人格/记忆注入 —— 只是那两条路退回"不调模型"的老做法。
  const llm = serviceOf(ctx, 'llm')
  if (llm === undefined || llm === null) {
    note('apply', '宿主没有 llm 服务：心情判断不跑，记忆只在过滤后原话直存（不提炼）')
  }

  // 注入前先取服务：有些宿主把它挂在 ctx 属性上，有些只走 ctx.get()。
  // 只认一种的话，另一种会静默失效 —— 表现是「设置里看得见插件，但人格没注入」。
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') {
    note('apply', '宿主没有 systemPrompt.context，人格/记忆/目的三段都无法注入')
    return
  }

  // ---- 1. 人格段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:persona',
        order: 260,
        // required：人格是「她是谁」，不能因为是精简上下文（includeRuntimeContext=false）
        // 就整个丢掉 —— 那种模式下 agent 会变得没有身份。
        required: true,
        text: (context) => {
          if (loadConfig().enabled === false) return ''
          // 2026-10-31：人格只在会话首轮注入，之后每隔 PERSONA_REFRESH_TURNS 轮补一次。
          // 不每轮重发（树树说的：不想让用不到的东西持续做无用消耗），
          // 也不注入一次就再也不管（上下文压缩之后会把自己是谁也压掉）。
          if (!shouldInjectPersona(context?.agent)) return ''
          const cwd = context?.agent?.session?.header?.cwd ?? ''
          const composed = composePersona({ cwd, config: loadConfig() })
          if (composed.truncated) note('persona', '人格正文超过上限，已截断')
          return composed.text
        }
      })
    } catch (error) {
      // 幂等保护：loader 偶尔会在无 scope 的 ctx 上装配两次，同名重复注册会抛
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:persona 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: persona context')

  // ---- 2. 记忆段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:memory',
        order: 250,
        // required：includeRuntimeContext=false 的 agent 也要拿到记忆卡，
        // 否则「她是谁 / 她记得什么」在这类 agent 上直接失忆（见 DSH 的
        // assemble：contexts.filter(entry => !suppressed || entry.required === true)）。
        required: true,
        text: (context) => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.memoryEnabled === false) return ''
          const agent = context?.agent
          const cwd = agent?.session?.header?.cwd ?? ''
          if (typeof cwd === 'string' && cwd !== '') setFallbackCwd(cwd)
          // 顺手做增量提取与例行维护：不阻塞注入。
          // 提取本身很快（扫事件+过滤），真正调模型的"提炼"是排队后台跑的。
          // 子会话的挡板在 tick 里（唯一收敛点），这里只负责不注入整卡。
          tick(agent, cwd, cfg, { llm })
          if (isSubagentSession(agent)) return ''
          const query = currentUserText(agent)
          // 2026-10-30：整卡只在会话第一轮注入；之后只按当前这句话召回。
          // 这条分支**不写粘性状态** —— 一旦把整卡记成「上次文本」，
          // 下一轮就会原样把它再发一遍，正好是要修的那个毛病。
          // 2026-10-31：第一轮再带上「最近」（前几天日记 + 今天流水），
          // 否则新开对话时不知道今天在别的对话里做过什么。
          if (isFirstTurnOfSession(agent)) {
            return `${renderMemoryBlockRecalled(cwd, cfg, query)}${renderRecentSection(cfg)}`
          }
          // 关掉相关区 = 整卡老路：逐字节等于改动前，也不必进粘性状态（没有相关区可粘）。
          if (cfg.memoryRecall !== true) return renderMemoryBlockRecalled(cwd, cfg, query)

          const now = Date.now()
          const sessionId = String(agent?.session?.header?.id ?? '')
          // 取不到 id 就退回每次重算：宁可多付 token，也不能让新会话拿到别人的记忆。
          const sticky = sessionId === '' ? null : stickyStateFor(sessionId, now)

          // 退化 query（纯注入 / 装配早于事件落库 / 「嗯」「好的」）：沿用上次，
          // 绝不因为「这一轮没听懂人话」把文本重新拼一遍。
          if (isDegenerateQuery(query)) {
            if (sticky !== null && sticky.rendered === true) return sticky.text
            // 没有上次可沿用才走整卡。这一段本身也记进粘性状态：
            // 否则同一个会话每遇到一句「嗯」，整卡就会被重新拼一次、再追加一条快照。
            const whole = renderMemoryBlockRecalled(cwd, cfg, '')
            if (sticky !== null) {
              sticky.terms = new Set()
              sticky.text = whole
              sticky.rendered = true
            }
            return whole
          }

          const terms = recallQueryTerms(query)
          // 话题没变 → 直接交回上次那段文本，一个字节都不重拼（见函数头注释）。
          if (sticky !== null && sticky.rendered === true && jaccardOf(sticky.terms, terms) >= STICKY_TOPIC_JACCARD) {
            noteStickyReuse(sessionId, sticky, now)
            return sticky.text
          }

          const text = recallForTurn(cwd, cfg, query, sessionId)
          if (sticky !== null) {
            sticky.terms = terms
            sticky.text = text
            sticky.rendered = true
          }
          return text
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:memory 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: memory context')

  // ---- 3. 目的段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:purpose',
        order: 240,
        // required：惦记的事是她主动性的来源，精简上下文时也不该被砍掉。
        required: true,
        text: (context) => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.purposeEnabled === false) return ''
          try {
            const state = purposeState()
            // 先消化上一轮：渲染出去的目标，她有没有真的说出口。
            // satisfyDrives 只在这里被调用 —— 在此之前它是一段没人接的死代码。
            const settled = settleServed(state, {
              assistantText: lastAssistantTextOf(context?.agent?.session)
            })
            if (settled.sent.length > 0) {
              note('purpose', `惦记的事说出口了 ${settled.sent.length} 条，驱动回落`)
            }
            const text = renderPurpose(state, { maxGoals: 3 })
            // 记下这一轮渲染出去的目标，下一轮才有得可查
            const marked = markServed(state, openGoals(state, { limit: 3 }))
            if (settled.sent.length > 0 || settled.skipped.length > 0 || marked) savePurposeState(state)
            return text
          } catch (error) {
            note('purpose', `渲染失败：${error instanceof Error ? error.message : error}`)
            return ''
          }
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:purpose 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: purpose context')

  // ---- 4. 心情：每轮钩子（返回空串 = 零注入） ----
  // text() 每次装配都被调用、拿得到 agent —— 正好在这里懒挂 turn-stopping。
  // 判断是异步的、结果只落盘（mood/ 目录），不占提示词预算、没有挂饰。
  //
  // 2026-10-30 为什么不加 required：这段永远返回空串，被 includeRuntimeContext=false
  // 过滤掉不损失任何提示词内容；用 required 保活一个空串，等于为了跑副作用去占
  // 「必需上下文」的名额，名不副实。副作用（心情记账）只该跟着真正注入的上下文走。
  ctx.effect(() => {
    const dispose = (() => {
      try {
        return systemPrompt.context({
          name: 'soul:mood',
          order: 230,
          text: (context) => {
            const cfg = loadConfig()
            if (cfg.enabled === false || cfg.moodEnabled === false) return ''
            const agent = context?.agent
            // 子会话不判心情：它是一次性任务上下文，判断结果会按 cwd 记进主会话的账上。
            if (isSubagentSession(agent)) return ''
            if (agent !== undefined && agent !== null && llm !== undefined && llm !== null) {
              // 幂等：observeAgent 内部按 agent 去重，挂一次就够
              observeAgent(agent, {
                llm,
                note,
                config: () => {
                  const cur = normalizeMoodConfig(loadConfig())
                  // cwd 在判定落下那一刻才读：同一 agent 会话中途改工作区也能对上号
                  const cwd = agent?.session?.header?.cwd ?? ''
                  return {
                    ...cur,
                    applyMoodDelta: (delta, opts) => applyMoodDelta(cwd, delta, opts)
                  }
                }
              })
            }
            return ''
          }
        })
      } catch (error) {
        if (error instanceof Error && error.message.includes('already registered')) {
          note('apply', 'soul:mood 已注册，跳过重复注册')
          return () => {}
        }
        throw error
      }
    })()
    return () => {
      unobserveAll()
      if (typeof dispose === 'function') dispose()
    }
  }, 'dsh-agent-soul: mood hook')

  note('apply', `注入已就绪：人格/记忆/目的三段 + 心情记账，模式=${loadConfig().mode}`)

  // ---- 5. 日记：定时器 + 启动补写 ----
  // 定时器独立于注入开关（enabled=false 时 tick 不跑 → 无对话可记 → 日记自然写"今天没有对话"），
  // 但日记自己的开关 diaryEnabled=false 时完全不启动。
  if (loadConfig().diaryEnabled !== false) {
    try {
      const stopDiary = startDiaryTimer(ctx)
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => stopDiary, 'dsh-agent-soul: diary timer')
      }
      note('apply', '日记定时器已启动')
    } catch (error) {
      note('diary', `定时器启动失败：${error instanceof Error ? error.message : error}`)
    }

    // 启动补写：找最近缺失日，只补那一天
    if (loadConfig().diaryCatchUp !== false) {
      try {
        void runCatchUp(ctx)
      } catch (error) {
        note('diary', `补写失败：${error instanceof Error ? error.message : error}`)
      }
    }
  }
}

/** 测试用：重置内部计时器与心情钩子。 */
export function __resetForTest() {
  lastMaintainAt = 0
  turnCursorBySession.clear()
  // 2026-10-30：粘性状态与「说过了」集合也是模块级缓存，测试之间必须清掉，
  // 否则上一个用例的文本会被下一个用例当成「上次注入」复用了。
  stickyRecallBySession.clear()
  recallSeenBySession.clear()
  unobserveAll()
}

/** 测试用：粘性状态表的当前规模（验证上限淘汰真的生效）。 */
export function __stickyStatsForTest() {
  return { size: stickyRecallBySession.size, max: STICKY_MAX_SESSIONS }
}

export { cardsFor, summarize, openGoals, satisfyDrives, savePurposeState, applyMoodDelta, isFirstTurnOfSession }
