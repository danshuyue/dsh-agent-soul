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
import { note, noteThrottled, serviceOf } from './env.js'
import { composePersona } from './persona.js'
import { collectCandidates, commitIngestBatch, currentUserText, failIngestBatch, ingestCandidates, isHumanEvent, isPromotable, isSubagentSession, messageContentOf, textOfContent } from './extract.js'
import { toneLevelOf, takeTone, __resetToneForTest } from './tone.js'
import { randomUUID } from 'node:crypto'
import { probeHostOnce } from './host.js'
import { refineCandidates } from './refine.js'
import { addRecord, recallQueryTerms, renderRecallOnly } from './memory.js'
import { collectForDiary, startDiaryTimer, runCatchUp, readRecentDiaries, readRecentChat, todayKey } from './diary.js'
import {
  cardsFor,
  globalCard,
  loadConfig,
  maintain,
  // 2026-11-04 补：registerToneForTurn 里要用它读当前心情。
  // 原来漏了这一行 —— 调用点抛 ReferenceError，被同一行的 catch 静默吞掉，
  // 于是「心情 → 语气」整条链从来没跑过，日志一个字都不留。
  moodState,
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
import { registerMemoryTool, registerGoalTool, registerNoteTool, setFallbackCwd } from './tool.js'
import { registerDiaryTool } from './diary-tool.js'
import { renderNotesBlock } from './notes.js'
import { registerApi, registerAssets } from './api.js'
import { recordAssembly } from './attest.js'

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
const MAINTAIN_INTERVAL_MS = 10 * 60 * 1000
/** dailyHour>0 时用来判「今天已经整理过」。（2026-11-04） */
let lastDailyMaintainDay = ''

let lastMaintainAt = 0

/** 提炼链：一次只跑一批，避免两批候选同时改同一张卡。 */
let refineChain = Promise.resolve()

/**
 * 提炼失败的日志节流（2026-11-04，B3 配套；③ 改成共用实现）。
 *
 * 为什么要分频：提炼失败有两种完全不同的成因 ——
 *   · 偶发：一次超时、一次格式异常。逐条记日志正好，能定位。
 *   · 系统性：密钥过期、模型下线、余额不足。这时每条候选都会失败，
 *     逐条记会把 soul.log 刷成噪音，真正重要的那行（第一次）反而被埋掉。
 * 所以：每小时只在第 1 次记完整原因，第 5 次补一句「这是系统性失败」，
 * 之后静默到下一个小时。日志是线索，不是流水账。
 *
 * 2026-11-04 修 ③：这套分频原来只在这里，refine.js 的两处失败日志没覆盖到，
 * 所以抽成 env.js 的 noteThrottled，三处（这里 + refine 的调用失败 + 解析失败）
 * 统一调用 —— 一处实现，口径不会再漂。
 */
function noteRefineFailure(message) {
  noteThrottled('memory', 'refine', `提炼失败：${message}`, {
    againAt: 5,
    againMessage: '提炼本小时已连续失败 5 次 —— 这不像偶发（可能是密钥/余额/模型下线），之后不再逐条记'
  })
}

/**
 * 把候选交给模型提炼，再落盘（异步）。
 *
 * 为什么不 await：tick 跑在 systemPrompt.context 的 text() 里，是**同步**的、
 * 每回合都要走一遍的路。等一次 30 秒的模型调用 = 每轮对话都卡 30 秒。
 * 所以排队后台跑：这一轮注入用旧卡，下一轮就看得到新记忆。
 * 提炼失败（超时 / 报错 / 格式崩）一律退回原话直存 —— 宁可记糙，不能把信息丢掉。
 *
 * 2026-11-04 修 ①：**落盘成功之后才推进游标**（batch 由 collectCandidates 带过来）。
 * 以前 collectCandidates 在返回前就把游标推到 to+1，这里写盘失败只记一行日志 ——
 * 那一批对话既没进卡，下一轮也不会再扫，永久消失。现在三条出口都过 settle：
 *   · 写成功 → commitIngestBatch（推进 + 清失败计数）
 *   · 写失败 → failIngestBatch（不推进，下一轮重试；连续 3 次才放弃并推进）
 *   · 没东西要写（提炼结果为空）→ 也算成功，直接推进
 *
 * @param {{key: string, to: number}|null} batch 这一批对应的扫描窗口
 */
function queueRefine(agent, cwd, candidates, config, llm, batch) {
  refineChain = refineChain
    .then(async () => {
      const settle = (ok) => {
        if (ok === true) commitIngestBatch(batch)
        else failIngestBatch(batch, '记忆没写进磁盘')
      }

      // 2026-11-04 修 B3：**抛异常也要降级**。
      //
      // 原来只有 `refined === null` 这一条路会退回 ingestRaw；如果 refineCandidates
      // 自己抛（网络断、JSON 解析崩、response 形状不对），异常会一路飞到外层 .catch，
      // 那里只记一行日志 —— 而当时 collectCandidates 早就把游标推过去了，
      // 于是这批候选永久消失：既没进卡，下一轮也不会再扫。
      //
      // 降级落卡是安全的：ingestCandidates 里还有两道闸（autoMemoryRejectReason、
      // minImportanceForKind），而且带人物属性的原话会被升成 fact（门槛 70→42），
      // 关于主人的信息反而比走提炼更容易留下。
      let refined = null
      try {
        refined = await refineCandidates(llm, agent, candidates, {
          owner: String(config.moodOwnerName || '树树'),
          provider: String(config.memoryRefineProvider || ''),
          model: String(config.memoryRefineModel || '')
        })
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error)
        noteRefineFailure(`${reason}（候选 ${candidates.length} 条，已退回原话直存）`)
        settle(ingestRaw(cwd, candidates, config))
        return
      }

      if (refined === null) {
        noteRefineFailure(`${candidates.length} 条候选退回原话直存`)
        settle(ingestRaw(cwd, candidates, config))
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
        // 这一批本来就没有要写的东西 —— 写成功，推进游标，别每轮重扫
        commitIngestBatch(batch)
        return
      }
      const report = writeAutoMemories(cwd, refined, config)
      if (report.written > 0) {
        note('memory', `提炼出 ${report.written} 条记忆（候选 ${candidates.length}）${report.promoted > 0 ? `，${report.promoted} 条进全局卡` : ''}`)
      }
      // 2026-11-04 修 ①：writeAutoMemories 现在会带 saved=false 回来。
      // 这行是主路（有模型时默认走提炼），不看它的话失败照样静默丢数据。
      if (report.written > 0 && report.saved === false) {
        failIngestBatch(batch, '提炼结果写盘失败')
        return
      }
      commitIngestBatch(batch)
    })
    .catch((error) => {
      // 走到这里说明上面的降级路径自己出了问题（比如 ingestRaw 抛了）。
      // 候选这时确实救不回来了，但至少把原因留下 —— 而且链必须接住，
      // 否则 refineChain 变成 rejected，之后所有提炼任务都会被跳过（直到重启）。
      note('memory', `提炼链异常（降级路径也没能兜住）：${error instanceof Error ? error.message : error}`)
      // 兜底也要结账：不结的话这个会话会一直挡在 inflight 状态上，
      // 直到 15 分钟后才被当作「丢了」重扫；失败计数也记不上，放弃条件永远不会触发。
      failIngestBatch(batch, '提炼链异常')
    })
}

/**
 * 老的直存路径：候选原话直接进卡（不提炼）。
 *
 * 只在「没有模型服务」或「配置里关了提炼」时走 —— 也是提炼失败时的兜底。
 * 自动记进**项目卡**（有 cwd 时），否则全局卡：跟随当前工作上下文，避免跨项目污染。
 *
 * @returns {boolean} 内存里算出来的东西**真的写进磁盘了**吗
 *   2026-11-04 修 ①：saveProjectCard/saveGlobalCard 的返回值现在必须看 ——
 *   以前完全不看，调用方也早就把游标推过去了，写盘失败那批对话就永久消失。
 *   false 时调用方不推进游标，下一轮从同一段重扫补上。
 */
function ingestRaw(cwd, candidates, config) {
  const useProject = String(cwd ?? '').trim() !== '' && config.projectMemoryEnabled !== false
  const card = useProject ? projectCard(cwd) : globalCard()
  const written = ingestCandidates(card, addRecord, candidates, config, Date.now())
  if (written > 0) {
    const saved = useProject ? saveProjectCard(cwd, card) : saveGlobalCard(card)
    if (saved?.ok !== true) return false
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
        const globSaved = saveGlobalCard(gcard)
        // 双写那份没落盘也算这一批没写全（项目卡那条已经在了，重试时 addRecord 会去重）
        if (globSaved?.ok !== true) return false
        note('extract', `跨工作区记下 ${promoted} 条（重要度 ≥ ${threshold} 且关于本人）`)
      }
    }
  }
  return true
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
const RECALL_SEEN_MAX = 16

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
  // 2026-11-04 修 B4：这里原来没传 cfg，cardsFor 用默认值 →
  // 关掉 projectMemoryEnabled 之后整卡路径没了项目卡，但这条「想起来了」的路
  // 每轮仍在从项目卡召回注入。同一个开关必须在两条路上都生效。
  const cards = cardsFor(cwd, cfg).map((entry) => entry.card)
  let recalled = renderRecallOnly(cards, { config: cfg, query, exclude: seen })

  // 空着，而且是被"说过了"挡空的 → 这套记忆在这个会话里已经讲完了，放开重来一次。
  // 只有 blocked > 0 才算（真的没有相关记忆时不该白跑一遍）。
  if (recalled.text === '' && (recalled.blocked ?? 0) > 0) {
    const blockedBefore = recalled.blocked
    // ⚠️ 不能 seen.clear()：清完 exclude 为空，而 renderRecallOnly 是纯函数、
    // 排序确定，重试结果就是这份 query 的历史最高分那几条 —— 多半跟上一轮
    // 刚说过的整段重合，正中"同一件事别连着刷屏"的反面。
    // 只留最近一半（最近说过的那几条），把更早的旧账放出来。
    const keep = [...seen].slice(-Math.floor(RECALL_SEEN_MAX / 2))
    seen.clear()
    for (const key of keep) seen.add(key)
    recalled = renderRecallOnly(cards, { config: cfg, query, exclude: seen })
    // 重置即记录：不管重试有没有结果都要留痕，否则去重表被悄悄削掉没人知道
    note('memory', `「想起来了」被去重挡空（挡掉 ${blockedBefore} 条），已把去重表收到 ${keep.length} 条重试`)
  }
  if (recalled.text === '') return ''

  for (const key of recalled.keys) seen.add(key)
  // 只留最近 N 条（Set 保插入顺序，最老的先出）
  while (seen.size > RECALL_SEEN_MAX) {
    const oldest = seen.values().next().value
    if (oldest === undefined) break
    seen.delete(oldest)
  }
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

// ---- 心情语气：挂在用户消息上（2026-11-01） ----

/**
 * 哪些 agent 已经打过「追加一条注入消息」的补丁。
 *
 * ⚠️ 这里必须诚实：DSH 的公开接口只能**往系统提示里加文本**，没有
 * 「改写当前这条用户消息」的钩子。所以"挂在消息上"是用 `agent/inbox/inserted`
 * 事件在**消息已经落库之后**再投一条 user 消息来实现的 —— 效果上是
 * 「树树那句话后面跟了一条心情」，但严格说它是**第二条消息**，不是改写。
 *
 * 为什么仍然这么做（而不是退回系统提示末尾）：
 *   · 系统提示一个字不动 → 长缓存不受影响
 *   · 心情是「那一刻」的状态，跟着消息走才对；放在系统提示里会一直过时
 */

/**
 * 算「这是第几轮」—— 用**最后一条 assistant 消息的 seq**当轮次标识。
 *
 * 为什么不直接用 session.seq：宿主在 preStep 的 assemble 和 step 里的 refreshContext
 * 之间会写一条 `step/start` 事件（agent-loop.js:970 `this.session.append("step/start")`），
 * seq 必变。所以 (sessionId, seq) 这个键永远命不中第二次 —— 缓存形同虚设，
 * 副作用照样每步跑两遍，every=1 和 every=2 的行为完全一样（2026-11-04 三次修）。
 *
 * 而「她最后说了一句话」才是真正的轮次边界：
 *   · 同一个 turn 内，assistant 消息没变 → 键不变 → 只算一次；
 *   · 她回了话 → 新 seq → 下一轮重新算。
 * step/start、tool/result 这些事件都不会动这个键。
 *
 * 代价是每次要扫一遍事件找最后一条 assistant/message。`lastAssistantTextOf` 早就
 * 是这么干的（而且每轮都调），所以这个成本本来就在付。
 *
 * @returns {string} 拿不到 id 时返回空串（调用方据此决定不加缓存）
 */
function turnKeyOf(agent) {
  const sid = String(agent?.session?.header?.id ?? '')
  if (sid === '') return ''
  const session = agent.session
  // 读不到事件列表时**不缓存**（返回空串），而不是拿一个常量键糊过去。
  // 原来这里 return `${sid}:-1`：那个键在整个会话生命周期里都不变，
  // 于是 memoPerStep 一辈子命中同一条 —— 副作用（语气计数、目的结算）只跑一次，
  // 之后全部静默失效。这是「出错时变得更省」的反向降级：
  // 读不到状态时应该退回「每次重算」，而不是退回「永远不重算」。
  if (typeof session?.snapshotEvents !== 'function') return ''
  let lastSeq = -1
  try {
    const events = session.snapshotEvents() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      if ((event && (event.type || event.kind)) !== 'assistant/message') continue
      lastSeq = Number(event.seq) || 0
      break
    }
  } catch {
    // 抛错同样退回「不缓存」：宁可多算，也不能让整会话的副作用停摆
    return ''
  }
  return `${sid}:${lastSeq}`
}

/**
 * 同**一轮**内只算一次（2026-11-04 修 B1，第二版）。
 *
 * 宿主在一个 step 里会把每个 context 的 text() 调至少两次：
 *   · preStep 里 systemPrompt.assemble() 一次；
 *   · step 里每个 attempt 又 refreshContext() 一次（重试还要 ×N）。
 * 按「每轮一次」写的副作用因此全部翻倍 —— 语气计数器涨两次、
 * purpose.json 每步写两遍、首轮判定第二次就变成「不是首轮」。
 *
 * 缓存的是**返回值**，不只是副作用：同一个 turn 的多次装配必须拿到逐字节相同的
 * 段落，否则宿主会认为快照变了、把整段重新投递。
 *
 * @param {string} name 段名（各段各一份缓存，互不影响）
 * @param {(context: any) => string} compute
 */
function memoPerStep(name, compute) {
  // 每个会话只留**当前这一轮**：key 里含轮次标识，如果按 key 存会一轮一条、
  // 越攒越多。这里用 sessionId 当槽位，存 { round, value }，新一轮来了就顶掉旧的。
  const cache = new Map()
  const MAX = 200
  return (context) => {
    const agent = context?.agent
    const round = turnKeyOf(agent)
    // 拿不到会话 id 时不缓存 —— 宁可多算一次，也不能让不同会话串味
    if (round === '') return compute(context)
    const slot = `${name}:${round.split(':')[0]}`
    const hit = cache.get(slot)
    if (hit !== undefined && hit.round === round) return hit.value
    const value = compute(context)
    if (cache.size > MAX) cache.clear()
    cache.set(slot, { round, value })
    return value
  }
}

/**
 * 本 turn 里有没有「真人说的话」（2026-11-04）。
 *
 * 语气是以一条 **user 消息**的身份进上下文的。如果这一轮压根没有人说话
 * （定时注入、重试、子任务回执撞上空轮），那条消息就变成「一条只有心情的空消息」——
 * 模型看到的是一个 user 说了句心情注解，可能还会顺着它回话。
 *
 * 判据不能用 `currentUserText`：它有 lookback 窗口，本轮没有新消息时会返回**上一轮**
 * 的文本，等于永远判「有」。
 *
 * 也不能只看「最后一条 user 消息是不是人话」：空轮时最后一条可能是 runtime-context
 * 或 schedule 注入，那确实该跳过；但更准确的做法是**以 turn 为界**——
 * 从后往前扫，碰到 `assistant/message` 就停（那是上一轮的结束）：
 *   · 这之间没有 human user 消息 → 本轮没人说话 → 不投
 *   · 有 → 正常投
 *
 * @returns {boolean}
 */
function hasHumanInputThisTurn(agent) {
  try {
    const session = agent?.session
    if (typeof session?.snapshotEvents !== 'function') return false
    const events = session.snapshotEvents() ?? []
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i]
      const type = event?.type ?? event?.kind
      // 上一轮的回复 = 本 turn 的起点。走到这里还没遇到人话，就是空轮
      if (type === 'assistant/message') return false
      if (type !== 'user/message') continue
      const holder = event?.payload !== undefined ? event.payload : event?.data
      const kind = String(holder?.source?.kind ?? '')
      // 自己投的语气消息不算「有人在说话」
      if (kind === 'soul-tone') continue
      return isHumanEvent(event)
    }
  } catch {
    /* 读不到就当没人在说话：宁可这一轮不投，也别投一条空心情 */
  }
  return false
}

/**
 * 每轮算一次心情档位（计数器语义见 tone.js），该发的时候在当前消息后追加一条。
 *
 * 只在 `soul:memory` 的 text() 里调用，那是每轮必经之路。
 */
function registerToneForTurn(agent, llm) {
  const cfg = loadConfig()
  if (cfg.enabled === false || cfg.moodEnabled === false) return
  if (agent === null || agent === undefined) return
  if (isSubagentSession(agent)) return

  const session = agent.session
  const id = String(session?.header?.id ?? '')
  if (id === '') return

  // 心情状态按 cwd 读（跟主注入同源），档位是纯查表，很便宜
  const cwd = session?.header?.cwd ?? ''
  let state = null
  try {
    state = moodState(cwd)
  } catch (error) {
    // 2026-11-04：原来是裸 `catch { return }`。正因为什么都不留，
    // 「moodState 没导入」这个错误整整藏了一个多月 —— 每轮都抛 ReferenceError，
    // 每轮都被这里吞掉，三个语气配置项全是摆设而日志一片干净。
    // 静默兜底和静默失效只差一行日志，这行必须有。
    note('mood', `读心情失败，这轮不注入语气：${error instanceof Error ? error.message : error}`)
    return
  }
  const level = toneLevelOf(state, cfg)
  if (level === 'low' || level === 'high') {
    // 只有真要挂的时候才检查 —— 中档本来就不投，不必扫事件。
    // 空轮不投，而且**不计入节流计数**（takeTone 根本不会被调用），
    // 否则「定时任务撞了几次空轮」会把本该隔 3 轮的语气提前触发。
    if (hasHumanInputThisTurn(agent) === false) return
  }
  const { emit, text } = takeTone(id, level, cfg)
  if (emit === false || text === '') return

  // 投一条 user 消息（不是 assistant）—— 它是「当时的心情」，属于对话的一部分。
  //
  // ── 字段名是 role，不是 type（2026-11-04 三次修，这次是线上事故）──
  // 宿主序列化发给模型的 messages 时要求 `role` 字段。我前两版写的是
  // `type: 'user'` —— 那是**事件**（session.append）的字段名，消息体用的是 role。
  // 后果不是静默失败，而是整轮对话直接 500：
  //   Failed to deserialize the JSON body: messages[202]: missing field `role`
  // 而且这条坏消息已经进了会话历史，之后每一轮都会带着它一起失败。
  //
  // 教训：拼消息体不要靠猜。优先走 llm.createUserMessage（宿主自己补全字段），
  // 兜底手拼时字段名照抄 dsh-onebot-channel/deliver.js:80 ——
  // 那是唯一一处已经被线上验证过的写法。
  try {
    const inbox = agent.inbox
    if (inbox === null || inbox === undefined || typeof inbox.append !== 'function') return
    const blocks = [{ type: 'text', text }]
    let message
    if (llm !== null && llm !== undefined && typeof llm.createUserMessage === 'function') {
      message = llm.createUserMessage({ content: blocks, source: { kind: 'soul-tone' } })
      if (message !== null && typeof message === 'object' && typeof message.id !== 'string') {
        message = { ...message, id: randomUUID() }
      }
    } else {
      message = {
        id: randomUUID(),
        role: 'user',
        content: blocks,
        source: { kind: 'soul-tone', plugin: 'dsh-agent-soul' }
      }
    }
    inbox.append('next-step', message)
    note('mood', `语气注入：${level}`)
  } catch (error) {
    note('mood', `语气注入失败：${error instanceof Error ? error.message : error}`)
  }
}

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
  // 维护时段（2026-11-04 接上 dailyHour）：
  //   dailyHour = 0 → 不限制，还是「每 10 分钟」那套（默认，保持原行为）
  //   dailyHour > 0 → 当天过了这个点才跑，且**一天只跑一次**
  const dailyHour = Math.max(0, Math.min(23, Math.trunc(Number(config.dailyHour) || 0)))
  let maintainAllowed = allowMaintain && now - lastMaintainAt > MAINTAIN_INTERVAL_MS
  if (maintainAllowed && dailyHour > 0) {
    const d = new Date(now)
    const dayKey = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
    if (d.getHours() < dailyHour || lastDailyMaintainDay === dayKey) maintainAllowed = false
    else lastDailyMaintainDay = dayKey
  }
  if (maintainAllowed) {
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
  let batch = null
  try {
    const collected = collectCandidates(agent, { limit: config.maxPerTick ?? 12 })
    batch = collected.batch
    const candidates = collected.candidates
    if (candidates.length === 0) return
    // 有模型就走「提炼成记忆」；没有模型 / 关掉了就退回原话直存（老路径，不丢信息）
    if (llm !== null && llm !== undefined && config.memoryRefine !== false) {
      // 游标由 queueRefine 在落盘之后结账（异步；这一轮不 await）
      queueRefine(agent, cwd, candidates, config, llm, batch)
    } else {
      // 2026-11-04 修 ①：落盘成功才推进游标；失败就不推，下一轮重试。
      if (ingestRaw(cwd, candidates, config) === true) commitIngestBatch(batch)
      else failIngestBatch(batch, '原话直存写盘失败')
    }
  } catch (error) {
    note('extract', `提取失败：${error instanceof Error ? error.message : error}`)
    // 已经拿到 batch 却在中途抛了：必须结账，否则这个会话会一直挡在 inflight 上
    // （最多挡 15 分钟），期间提取等于停摆。按失败记，下一轮重试。
    if (batch !== null) failIngestBatch(batch, '提取中途异常')
  }

  // 2026-11-04：collectForDiary 已经从 tick 里挪到 soul:memory 的 text() 里了。
  // 留在这里的话它会跟着记忆开关一起被挡住（见那边的注释）。
  // 挪出去之后 tick 只做「记忆自己的事」：维护 + 提取。
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
  registerNoteTool(ctx)
  registerDiaryTool(ctx)

  // ---- 0. 装配证词：把「我到底进没进去」变成可观测的（2026-11-02） ----
  //
  // 放在 enabled 判断**之前**：插件被关掉时也要能看见「关掉之后确实不在装配里」。
  // 否则「关了没生效」和「关了但还在注入」长得一模一样。
  //
  // 只读不改：等 next() 返回后读 assembly.contexts，不碰 sections、不重跑 text()。
  // 为什么是 prepend：最外层进、最外层出，next() 拿到的才是别的监听器都改完的结果。
  if (typeof ctx.on !== 'function') {
    note('attest', '宿主 ctx.on 不可用，装配证词无法注册（不影响注入，只是少了一双眼睛）')
  } else {
    try {
      // ctx.on 自己就是挂在插件 fiber 上的 effect（cordis 的 register 内部走
      // ctx.fiber.effect），所以不需要再套一层 ctx.effect —— 少一层嵌套少一个出错面。
      // prepend 在 cordis 里是 unshift：进最前、最先被调用，于是 next() 拿到的是
      // 下游所有监听器都改完之后的结果，也就是真正要渲染的那一份。
      ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
        const assembly = await next()
        // 证词失败绝不能拖垮装配：recordAssembly 内部已兜住一切异常
        recordAssembly(assembly, context)
        return assembly
      }, { prepend: true })
    } catch (error) {
      note('attest', `装配证词注册失败：${error instanceof Error ? error.message : error}`)
    }
  }

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
        text: memoPerStep('memory', (context) => {
          // 心情语气：挂在**当前这句用户消息**后面（2026-11-01）。
          // 必须在任何 early return 之前算 —— 计数器是「每轮一次」，跳过去就不准了。
          // 系统提示一个字不动，所以长缓存不受影响。
          registerToneForTurn(context?.agent, llm)

          const cfg = loadConfig()
          // 2026-11-04 修 ③：只有「整个插件关掉」才彻底不做。
          // 原来这里写作 `enabled === false || memoryEnabled === false` 直接 return，
          // 连带把下面的 collectForDiary 也挡住了 —— 关掉记忆之后
          // conversations/*.jsonl 不再增长，那天日记只能写成「今天没有对话」。
          if (cfg.enabled === false) return ''

          const agent = context?.agent
          const cwd = agent?.session?.header?.cwd ?? ''

          // ---- 日记素材：跟「记忆开关」无关 ----
          // 这两件事本来就不该绑在一起：
          //   记忆     = 她记不记得（注入、提取、衰减）
          //   日记素材 = 今天到底发生过什么（只追加到 JSONL）
          // 关掉前者不该让后者停摆。子会话挡板跟 tick 里那条同源，判据抄一处。
          if (isSubagentSession(agent) === false) {
            // 2026-11-04 修 B12：兜底 cwd 只从主会话取。
            // 它原来是无条件写的，子会话的临时 cwd 会把主会话的值盖掉 ——
            // 工具调用没带 context 时（cdoOf 的兜底分支）就会把记忆写到错的项目卡里。
            if (typeof cwd === 'string' && cwd !== '') setFallbackCwd(cwd)
            try {
              collectForDiary(agent)
            } catch (error) {
              note('diary', `对话记录失败：${error instanceof Error ? error.message : error}`)
            }
          }

          // 关掉记忆之后：不注入、不提取、不维护 —— 但素材已经记下了
          if (cfg.memoryEnabled === false) return ''

          // 顺手做增量提取与例行维护：不阻塞注入。
          // 提取本身很快（扫事件+过滤），真正调模型的"提炼"是排队后台跑的。
          // 子会话的挡板在 tick 里（唯一收敛点），这里只负责不注入整卡。
          tick(agent, cwd, cfg, { llm })
          // 宿主形状自检：每个会话第一轮跑一次（2026-11-01 审计 C7）。
          // 放在 tick 之后：提取已经读过事件了，这时候检查"到底抠不抠得出正文"最准。
          // 传的抽取函数必须是**提取真正在用的那套**（messageContentOf + textOfContent），
          // 不是 host.js 里那份容错版 —— 两边分叉的话自检会绿、提取照样空。
          probeHostOnce(agent, {
            extractText: (event) => textOfContent(messageContentOf(event)),
            // 注入事件本身也是 user/message 且带正文。只查"能不能抠出字"的话，
            // 真人那条链路改名后自检照样全绿、候选恒 0 —— 所以要再问一句
            // "这条真人消息，提取链认得出来吗"。
            classify: (event) => isHumanEvent(event) && textOfContent(messageContentOf(event)) !== ''
          })
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
            //
            // 2026-11-01 审计 B6 说这里「绕过整卡只首轮契约、会每轮回放 3200 字」。
            // 查过：确实会多注入一次整卡，但**不会每轮重复花钱** —— 宿主只在注入
            // 文本变化时才重投，同一个字符串只算一次。而这行是当年修的**防死锁**兜底：
            // 早期版本在这里返回空串，于是「窗口里只剩注入」的会话永远拿不到记忆，
            // 模型整场都当自己是第一次见人（sticky.test.js ④ 就守着这条）。
            // 所以保留，代价是一次整卡注入，收益是会话不会变成失忆。
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
        })
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:memory 已注册，跳过重复注册')
        return () => {}
      }
      throw error
    }
  }, 'dsh-agent-soul: memory context')

  // ---- 2b. 笔记索引（2026-11-04）----
  //
  // 为什么单独开一段，而不是拼在记忆段的返回值里：
  //   记忆段有一套「粘性」机制 —— 话题没变就直接交回上次那段文本，一个字节都不重拼。
  //   笔记要是拼在里面，她新建/改完一篇之后会出现「索引已经变了但注入还是旧的」，
  //   而且极难查：她不知道有这篇、翻日志也看不出哪一层把它挡住了。
  //   独立成段之后，笔记变了只有这一段变，宿主按文本变化重投，语义干净。
  //
  // order 245：人格 260 → 记忆 250 → **笔记 245** → 目的 240。紧挨着记忆，
  // 因为两者是同一类东西（她脑子里留着的），只是粒度和寿命不同。
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:notes',
        order: 245,
        // required：笔记是她自己写的，精简上下文时也不该整个消失 ——
        // 否则「我写过东西」这件事在部分 agent 上会变成空白。
        required: true,
        text: () => {
          const cfg = loadConfig()
          if (cfg.enabled === false || cfg.notesEnabled === false) return ''
          try {
            return renderNotesBlock({ maxChars: cfg.notesInjectMaxChars })
          } catch (error) {
            // 笔记索引挂了不该连累人格和记忆：返回空串，这一轮就是没有这一段
            note('notes', `索引渲染失败：${error instanceof Error ? error.message : error}`)
            return ''
          }
        }
      })
    } catch (error) {
      if (error instanceof Error && error.message.includes('already registered')) {
        note('apply', 'soul:notes 已注册，跳过重复注册')
        return () => {}
      }
      note('notes', `索引注入注册失败：${error instanceof Error ? error.message : error}`)
      return () => {}
    }
  }, 'dsh-agent-soul: notes context')

  // ---- 3. 目的段 ----
  ctx.effect(() => {
    try {
      return systemPrompt.context({
        name: 'soul:purpose',
        order: 240,
        // required：惦记的事是她主动性的来源，精简上下文时也不该被砍掉。
        required: true,
        text: memoPerStep('purpose', (context) => {
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
        })
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

  // 文案要跟实际注册的段数一致：笔记段是 11-04 加的第五段，
  // 这里还写「三段」的话，将来翻日志排查会以为笔记段没注册上。
  note('apply', `注入已就绪：人格/记忆/笔记/目的四段 + 心情记账，模式=${loadConfig().mode}`)

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
  // 2026-11-01 审计 C10：人设轮次表也是模块级状态（哪个会话已经注入过、注入到第几轮），
  // 不跟着清的话，测试里第二个用例会继承第一个用例的计数，人设注入就测不出来。
  personaInjectAtBySession.clear()
  __resetToneForTest()
  unobserveAll()
}

/** 测试用：粘性状态表的当前规模（验证上限淘汰真的生效）。 */
export function __stickyStatsForTest() {
  return { size: stickyRecallBySession.size, max: STICKY_MAX_SESSIONS }
}

export { cardsFor, summarize, openGoals, satisfyDrives, savePurposeState, applyMoodDelta, isFirstTurnOfSession }
