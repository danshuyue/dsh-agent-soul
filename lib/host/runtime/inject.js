/**
 * 宿主装配 · inject.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { ECHO_LINE_MAX_CHARS, ECHO_SECTION_MAX_CHARS, RECALL_SEEN_MAX } from '../meta.js'
import { cardsFor, loadConfig, moodState } from '../../store.js'
import { digestDiaries, readRecentChat, readRecentDiaries, todayKey } from '../../diary.js'
import { hasHumanInputThisTurn } from './turns.js'
import { isSubagentSession } from '../../extract.js'
import { note } from '../../env.js'
import { randomUUID } from 'node:crypto'
import { recallSeenBySession } from './state.js'
import { renderRecallOnly } from '../../memory.js'
import { takeTone, toneLevelOf } from '../../tone.js'
import { wrapUntrusted } from '../../core/prompt-guard.js'



/**
 * 把缓冲里的条目渲染成一个小节；没有条目时返回空串。
 *
 * @param {Array<{ text: string }>} items takeEcho 的返回值
 * @returns {string}
 */
export function renderEchoSection(items) {
  if (!Array.isArray(items) || items.length === 0) return ''
  const lines = []
  for (const item of items) {
    // 换行折成空格：一条记忆里就算带了换行，回执也必须是一行，否则列表结构会断。
    const text = String(item?.text ?? '').replace(/\s+/g, ' ').trim()
    if (text === '') continue
    const shown = text.length > ECHO_LINE_MAX_CHARS ? `${text.slice(0, ECHO_LINE_MAX_CHARS)}…` : text
    lines.push(`- ${shown}`)
  }
  if (lines.length === 0) return ''
  // 回执是刚写下的用户原话，同样按不可信数据包裹（S2 / P1-4）。
  const section = `## 刚记下的\n${wrapUntrusted('刚记下的记忆', lines.join('\n'))}`
  // 兜底截断：正常 3 条 × 61 字远小于 300，但缓冲上限是 600，不能假设调用方一定守规矩。
  return section.length > ECHO_SECTION_MAX_CHARS
    ? `${section.slice(0, ECHO_SECTION_MAX_CHARS - 1)}…`
    : section
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
export function renderRecentSection(cfg) {
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
        // 2026-11-05：整篇 → 每篇一行摘要。两篇日记约 3000 字，占开场最大的一块，
        // 而它的用处只是「接得上昨天」。摘要里带日期和全文字数，要细看再按日期读文件。
        const digest = digestDiaries(body, 300)
        if (digest !== '') parts.push(`### 前几天的日记（每篇一段摘要，全文在 agents/diary/public/<日期>.md）\n\n${digest}`)
      }
    }

    if (Number.isFinite(chatChars) && chatChars > 0) {
      // 2026-11-04：流水里主人怎么标也跟着配置走（空 = 中性的「对方」）
      const chat = readRecentChat(today, Math.min(Math.trunc(chatChars), 12000), cfg.ownerName)
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
export function recallForTurn(cwd, cfg, query, sessionId, maxChars) {
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
  // 2026-11-04 回声：maxChars 只在有回声、预算被回执占掉时才传 ——
  // 不传时行为跟以前逐字节一致（renderRecallOnly 自己用默认 260）。
  const recallOptions = { config: cfg, query, exclude: seen }
  if (Number.isFinite(maxChars) && maxChars > 0) recallOptions.maxChars = maxChars
  const cards = cardsFor(cwd, cfg).map((entry) => entry.card)
  let recalled = renderRecallOnly(cards, recallOptions)

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
    recalled = renderRecallOnly(cards, recallOptions)
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
 * 每轮算一次心情档位（计数器语义见 tone.js），该发的时候在当前消息后追加一条。
 *
 * 只在 `soul:memory` 的 text() 里调用，那是每轮必经之路。
 */
export function registerToneForTurn(agent, llm) {
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
