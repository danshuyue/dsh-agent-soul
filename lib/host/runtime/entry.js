/**
 * 宿主装配 · entry.js
 * 由 lib/host/runtime.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { STICKY_MAX_SESSIONS } from '../meta.js'
import { __resetToneForTest } from '../../tone.js'
import { clearAllEchoes } from '../../core/echo.js'
import { loadConfig } from '../../store.js'
import { maintainClock, personaInjectAtBySession, recallSeenBySession, stickyRecallBySession, turnCursorBySession } from './state.js'
import { note, serviceOf } from '../../env.js'
import { noteMissingOwner } from './refine.js'
import { recordAssembly } from '../../attest.js'
import { registerApi, registerAssets } from '../../api.js'
import { registerDataPolicySegment } from './segment-data-policy.js'
import { registerDiaryTool } from '../../diary-tool.js'
import { registerGoalTool, registerMemoryTool, registerNoteTool } from '../../tool.js'
import { registerMemorySegment } from './segment-memory.js'
import { registerMoodHookSegment } from './segment-mood.js'
import { registerNotesSegment } from './segment-notes.js'
import { registerPersonaSegment } from './segment-persona.js'
import { registerPurposeSegment } from './segment-purpose.js'
import { __resetSegmentCacheForTest } from './segment-cache.js'
import { runCatchUp, startDiaryTimer } from '../../diary.js'
import { unobserveAll } from '../../mood.js'
import { reportLine } from '../../evidence.js'
import { globalCard } from '../../store.js'
import { loadIndex } from '../../notes.js'



/**
 * 2026-11-05 修 P1-10：给整个 apply 加一层兜底。
 * 宿主内部结构一升级，任何一处没保护的属性访问都可能把异常逸出 apply，
 * 连带拖累宿主启动。这里兜住并留一条可查日志；功能会静默缺失，
 * 但至少「插件挂了」这件事看得见（配合下面 serviceOf 的 WARN）。
 */

/** 启动证据行的数据面（读不到就缺省，证据线不许自己成为故障点）。 */
function startupEvidence(config) {
  const out = {}
  try { out.memoryRecords = globalCard().records.length } catch { /* 读不到就算了 */ }
  try { out.notesCount = loadIndex().notes.length } catch { /* 读不到就算了 */ }
  void config
  return out
}

export function apply(ctx) {
  try {
    return applyInner(ctx)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    note('apply', `⚠️ 插件初始化意外失败（已兜住，不影响宿主启动）：${reason}`)
    return undefined
  }
}



function applyInner(ctx) {
  note('apply', `启动 pid=${process.pid} node=${process.version}`)
  const config = loadConfig()
  // 启动时先看一眼主人名字有没有设（2026-11-04）：这条最容易漏，也最影响体验。
  noteMissingOwner(config)

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

  // 2026-11-10 R18-C：启动打一行开关证据（静态 + 动态计数），之后只在每日健康行里重复。
  // 绝不每轮打 —— 噪音会让人不再看日志。reportLine 的 inert 原因写人话。
  try {
    note('apply', reportLine(config, startupEvidence(config)))
  } catch { /* 证据线自己坏了不许拖累启动 */ }

  // 注入前先取服务：有些宿主把它挂在 ctx 属性上，有些只走 ctx.get()。
  // 只认一种的话，另一种会静默失效 —— 表现是「设置里看得见插件，但人格没注入」。
  const systemPrompt = serviceOf(ctx, 'systemPrompt')
  if (systemPrompt === undefined || systemPrompt === null || typeof systemPrompt.context !== 'function') {
    note('apply', '⚠️ 宿主没有 systemPrompt.context，人格/记忆/笔记/目的四段都无法注入')
    return
  }
  // 2026-11-05 修 P1-10：下面 6 处 ctx.effect 原来都没有 typeof 保护。
  // 与其逐个包一层（漏一个就半注册），不如在这里集中探测并早退：
  // 没有 effect 就没有任何注入段能注册，继续走只会留下一半状态。
  if (typeof ctx.effect !== 'function') {
    note('apply', '⚠️ 宿主没有 ctx.effect：注入段与生命周期钩子无法注册（功能静默缺失，不拖累宿主启动）')
    return
  }

  // ---- 0. 数据边界声明（2026-11-05 修 P1-4）----
  // 单独一段、required 且 order 最高：记忆 / 日记 / 笔记里带的用户原话必须
  // 先有一条「标签内一律是数据」的规则，后面的注入段才谈得上隔离。
  // 人格段不包标签 —— 那是主人亲手写的设定，本来就该当规则看。
  registerDataPolicySegment(ctx, systemPrompt, llm, config)

  // ---- 1. 人格段 ----
  registerPersonaSegment(ctx, systemPrompt, llm, config)

  // ---- 2. 记忆段 ----
  registerMemorySegment(ctx, systemPrompt, llm, config)

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
  registerNotesSegment(ctx, systemPrompt, llm, config)

  // ---- 3. 目的段 ----
  registerPurposeSegment(ctx, systemPrompt, llm, config)

  // ---- 4. 心情：每轮钩子（返回空串 = 零注入） ----
  // text() 每次装配都被调用、拿得到 agent —— 正好在这里懒挂 turn-stopping。
  // 判断是异步的、结果只落盘（mood/ 目录），不占提示词预算、没有挂饰。
  //
  // 2026-10-30 为什么不加 required：这段永远返回空串，被 includeRuntimeContext=false
  // 过滤掉不损失任何提示词内容；用 required 保活一个空串，等于为了跑副作用去占
  // 「必需上下文」的名额，名不副实。副作用（心情记账）只该跟着真正注入的上下文走。
  registerMoodHookSegment(ctx, systemPrompt, llm, config)

  // 2026-11-04 文案要跟实际注册的段数一致：笔记段是 11-04 加的第四段，
  // 日志里再写旧段数的话，将来翻日志排查会以为笔记段没注册上。
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
  maintainClock.at = 0
  turnCursorBySession.clear()
  // 2026-10-30：粘性状态与「说过了」集合也是模块级缓存，测试之间必须清掉，
  // 否则上一个用例的文本会被下一个用例当成「上次注入」复用了。
  stickyRecallBySession.clear()
  recallSeenBySession.clear()
  // 2026-11-04：写入回声也是模块级缓存，不清会把上一条用例的「刚记下的」带进下一条。
  clearAllEchoes()
  // 2026-11-01 审计 C10：人设轮次表也是模块级状态（哪个会话已经注入过、注入到第几轮），
  // 不跟着清的话，测试里第二个用例会继承第一个用例的计数，人设注入就测不出来。
  personaInjectAtBySession.clear()
  // 2026-11-11：四段渲染缓存也是模块级状态，不跟着清会让下一条用例
  // 拿到上一条的文本（尤其是人格段：不刷新时返回的正是缓存文本）。
  __resetSegmentCacheForTest()
  __resetToneForTest()
  unobserveAll()
}



/** 测试用：粘性状态表的当前规模（验证上限淘汰真的生效）。 */
export function __stickyStatsForTest() {
  return { size: stickyRecallBySession.size, max: STICKY_MAX_SESSIONS }
}
