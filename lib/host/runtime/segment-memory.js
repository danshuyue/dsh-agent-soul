/**
 * 宿主装配 · segment-memory.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DEFAULTS, recallQueryTerms } from '../../memory.js'
import { STICKY_TOPIC_JACCARD, name } from '../meta.js'
import { collectForDiary } from '../../diary.js'
import { currentUserText, isHumanEvent, isSubagentSession, messageContentOf, textOfContent } from '../../extract.js'
import { isDegenerateQuery, isFirstTurnOfSession, jaccardOf, memoPerStep, noteStickyReuse, stickyStateFor } from './turns.js'
import { loadConfig, renderMemoryBlockRecalled } from '../../store.js'
import { note } from '../../env.js'
import { probeHostOnce } from '../../core/host.js'
import { recallForTurn, registerToneForTurn, renderEchoSection, renderRecentSection } from './inject.js'
import { setFallbackCwd } from '../../tool.js'
import { configPath, globalMemoryPath, projectMemoryPath, shortHash } from '../../paths.js'
import { takeEcho } from '../../core/echo.js'
import { tick } from './tick.js'
import { wrapUntrusted } from '../../core/prompt-guard.js'
import { fileSignature, renderCached } from './segment-cache.js'


/** 记忆段每 7 轮至少重算一次。 */
const MEMORY_CACHE_TURNS = 7


/**
 * 记忆段的缓存指纹。
 *
 * **必须带上这一句用户消息的指纹**：召回区是按「她这句话」算出来的，
 * 只看文件 mtime 的话，换话题之后最多 7 轮还在贴旧话题的记忆 ——
 * sticky.test.js ② 钉的就是「换话题文本必须变」。
 *
 * 文件部分覆盖：全局卡 / 本项目卡（新记忆落盘后 mtime 变）、配置文件
 * （召回开关、预算上限）。回声不用进 sig：有回声时调用方直接绕开缓存。
 */
function memorySignature(cwd, query, firstTurn) {
  return [
    fileSignature(globalMemoryPath(), projectMemoryPath(cwd), configPath()),
    shortHash(String(query ?? '')),
    // 首轮注入的是「整卡 + 最近」，之后只注入相关区。把首轮标记带进 sig，
    // 免得同一个 query 在第二轮还从缓存里捞出整卡（多付一大段 token）。
    firstTurn === true ? 'first' : 'later'
  ].join('|')
}


// ---------------------------------------------------------------------------
// text() 的职责拆分（2026-11-09 KNOWN-ISSUES #28）。
// 原来一个 memoized text() 串了 8 种职责、~150 行，改一处要读全文，测试只能整体测。
// 现在按既有函数边界拆成三个私有函数（不新增导出，契约快照零变化）：
//   collectDiaryMaterial  日记素材收集（与记忆开关无关）
//   memoryBudgetPlan      回声预算 + 数据边界包装（withEcho 闭包）
//   computeRecallText     召回状态机（首轮整卡 / 粘性复用 / 退化 query / 按句召回）
//   registerToneForTurn   心情语气（仍内联一行：本身就是单职责的单行调用）
// 行为逐字节不变 —— tests/r15-segment-feature.test.js 与 sticky/echo/inject 全绿是验收线。
// ---------------------------------------------------------------------------

/** 日记素材收集（2026-11-04 修 ③/B12 的语义保持原样）。 */
function collectDiaryMaterial(agent, cwd) {
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
}

/**
 * 回声预算 + 数据边界包装。
 * 从 text() 的「回声算进预算 → baseCfg → recallMaxChars → withEcho」整段抽出，
 * 返回的三个值与拆分前逐字节同源；没有回声时 cfg 原样传下去（旧路径不变）。
 */
function memoryBudgetPlan(echoSection, cfg) {
  // 回声要算进 injectMaxChars 预算：先把它的长度（含与正文间的两个换行）
  // 从基础文本的预算里扣掉，交给原有渲染函数去裁剪。没有回声时 cfg
  // 原样传下去 —— 旧路径必须逐字节不变。
  // 下限 200 是记忆渲染本身的下限（renderRecalledBlock 的 clamp）；
  // memoryRecall:false 的整卡老路内部还有 400 的下限，那属于旧行为，不动。
  const echoChars = echoSection === '' ? 0 : echoSection.length + 2
  // 2026-11-05 S2：数据边界标签是固定开销，不扣掉的话
  // 「回执 + 召回 ≤ injectMaxChars」这条预算保证会被标签本身撑破。
  const guardChars = wrapUntrusted('记忆与最近', '').length
  const totalBudget = Math.trunc(Number(cfg.injectMaxChars) || DEFAULTS.injectMaxChars)
  const availableChars = Math.max(200, totalBudget - echoChars - guardChars)
  const baseCfg = echoSection === ''
    ? cfg
    : { ...cfg, injectMaxChars: availableChars }
  // 「想起来了」那一段自己有 260 的上限，不读 injectMaxChars；
  // 有回声时把它压到剩余预算内，保证回执 + 召回不超过总预算。
  const recallMaxChars = echoSection === '' ? undefined : Math.max(80, Math.min(260, availableChars))
  // 2026-11-05 S2 / P1-4：整段记忆正文包进数据边界后返回，
  // 让「记忆卡里的某句话」不会被模型当成新一轮指令。
  // 下游渲染有 200~260 字的下限，光在预算里扣标签开销仍可能超；
  // 这里按剩余空间做最后一次裁剪，且**先裁正文再包标签**，
  // 保证闭合的 </user_data> 永远完整（切在标签中间等于给注入留口子）。
  const withEcho = (base) => {
    const head = echoSection === '' ? '' : `${echoSection}\n\n`
    let body = String(base ?? '')
    const room = totalBudget - head.length - guardChars
    if (room > 0 && body.length > room) body = `${body.slice(0, Math.max(1, room - 1))}…`
    return head + (body === '' ? '' : wrapUntrusted('记忆与最近', body))
  }
  return { baseCfg, recallMaxChars, withEcho }
}

/**
 * 召回状态机：首轮整卡 / 关召回老路 / 退化 query 沿用 / 话题粘性复用 / 按句召回。
 * 粘性状态的读写都收在这里（原来散在 text() 中段），入参之外不写全局。
 */
function computeRecallText(agent, cwd, cfg, baseCfg, query, sessionId, echoSection, recallMaxChars, withEcho) {
  // 2026-10-30：整卡只在会话第一轮注入；之后只按当前这句话召回。
  // 这条分支**不写粘性状态** —— 一旦把整卡记成「上次文本」，
  // 下一轮就会原样把它再发一遍，正好是要修的那个毛病。
  // 2026-10-31：第一轮再带上「最近」（前几天日记 + 今天流水），
  // 否则新开对话时不知道今天在别的对话里做过什么。
  if (isFirstTurnOfSession(agent)) {
    return withEcho(`${renderMemoryBlockRecalled(cwd, baseCfg, query)}${renderRecentSection(cfg)}`)
  }
  // 关掉相关区 = 整卡老路：逐字节等于改动前，也不必进粘性状态（没有相关区可粘）。
  // 2026-11-04：回声仍然要出现 —— 它是写回执，不是召回，不受 memoryRecall 开关管。
  if (cfg.memoryRecall !== true) return withEcho(renderMemoryBlockRecalled(cwd, baseCfg, query))

  const now = Date.now()
  // 取不到 id 就退回每次重算：宁可多付 token，也不能让新会话拿到别人的记忆。
  const sticky = sessionId === '' ? null : stickyStateFor(sessionId, now)

  // 退化 query（纯注入 / 装配早于事件落库 / 「嗯」「好的」）：沿用上次，
  // 绝不因为「这一轮没听懂人话」把文本重新拼一遍。
  if (isDegenerateQuery(query)) {
    if (sticky !== null && sticky.rendered === true) return withEcho(sticky.text)
    // 没有上次可沿用才走整卡。这一段本身也记进粘性状态：
    // 否则同一个会话每遇到一句「嗯」，整卡就会被重新拼一次、再追加一条快照。
    //
    // 2026-11-01 审计 B6 说这里「绕过整卡只首轮契约、会每轮回放 3200 字」。
    // 查过：确实会多注入一次整卡，但**不会每轮重复花钱** —— 宿主只在注入
    // 文本变化时才重投，同一个字符串只算一次。而这行是当年修的**防死锁**兜底：
    // 早期版本在这里返回空串，于是「窗口里只剩注入」的会话永远拿不到记忆，
    // 模型整场都当自己是第一次见人（sticky.test.js ④ 就守着这条）。
    // 所以保留，代价是一次整卡注入，收益是会话不会变成失忆。
    const whole = renderMemoryBlockRecalled(cwd, baseCfg, '')
    if (sticky !== null) {
      sticky.terms = new Set()
      sticky.text = whole
      sticky.rendered = true
    }
    return withEcho(whole)
  }

  const terms = recallQueryTerms(query)
  // 话题没变 → 直接交回上次那段文本，一个字节都不重拼（见函数头注释）。
  // 2026-11-04：有回声时**必须绕过**这条复用 —— 否则刚写的那条会被
  // 上次缓存原样盖掉。回声只拼在返回结果上，不进 sticky.text，
  // 这样下一轮没有回声时粘性仍能复用「不含回声」的那份基础文本。
  if (
    echoSection === ''
    && sticky !== null
    && sticky.rendered === true
    && jaccardOf(sticky.terms, terms) >= STICKY_TOPIC_JACCARD
  ) {
    noteStickyReuse(sessionId, sticky, now)
    // 复用路径也要过同一层边界 + 预算裁剪，不能留一条裸奔的分支。
    return withEcho(sticky.text)
  }

  const text = recallForTurn(cwd, baseCfg, query, sessionId, recallMaxChars)
  if (sticky !== null) {
    sticky.terms = terms
    sticky.text = text
    sticky.rendered = true
  }
  return withEcho(text)
}

export function registerMemorySegment(ctx, systemPrompt, llm, config) {
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
          collectDiaryMaterial(agent, cwd)

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
          const sessionId = String(agent?.session?.header?.id ?? '')

          // ---- 记忆写入回声（2026-11-04）----
          // 写入是在**上一个 step** 的工具调用里发生的；这一步装配时把它取出来，
          // 放在文本最前面。一次性：takeEcho 取过就清空，下一轮不再出现。
          // 拿不到 sessionId 时不取 —— 回声里是刚写下的私事，绝不能退化成全局 key。
          const echoSection = sessionId === '' ? '' : renderEchoSection(takeEcho(sessionId))

          const { baseCfg, recallMaxChars, withEcho } = memoryBudgetPlan(echoSection, cfg)
          const render = () => computeRecallText(agent, cwd, cfg, baseCfg, query, sessionId, echoSection, recallMaxChars, withEcho)
          // 回声是**一次性的写回执**：工具刚写完，下一轮必须看到那条。
          // 这条路径独立于缓存 —— 否则上一轮缓存的「不含回声」文本会把它盖掉，
          // 而 takeEcho 已经清空缓冲，那条回执就永远消失了。
          if (echoSection !== '') return render()
          return renderCached(agent, 'memory', render, {
            sig: memorySignature(cwd, query, isFirstTurnOfSession(agent)),
            everyTurns: MEMORY_CACHE_TURNS
          })
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
}
