/**
 * 日记 · scheduler.js
 * 由 lib/diary.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { buildMoodBlocks, composeDiarySetup, composeDiaryText, composePrivateMessage, composePublicMessage, readRecentDiaries } from './compose.js'
import { closeMentioned, expireThreads, extractThreads, loadThreads, openThread, renderThreadSection, saveThreads } from '../threads.js'
import { diaryIsCompleteFor, todayKey, yesterdayKey } from '../diary/completion.js'
import { diaryPrivatePath, diaryPublicPath, exists, readText } from '../paths.js'
import { findMissingDay, waitForWrite, writeDiaryFile } from './files.js'
import { join } from 'node:path'
import { loadConfig } from '../store.js'
import { note, serviceOf } from '../env.js'
import { pickConversation } from '../core/diary-pick.js'
import { readConversationRows, readDiaryConversations } from './feed.js'
import { statSync } from 'node:fs'


export async function diaryAgent(ctx) {
  const config = loadConfig()
  const sessionId = String(config.diarySessionId ?? '').trim()

  if (sessionId === '') {
    // 没有绑定就是没有绑定。以前这里会去捞「最近活跃会话」，等于把日记写进
    // 用户正在聊的那个会话 —— 语义错了，私密内容还可能摆到不该看的人面前。
    note('diary', '没有绑定日记会话（diarySessionId 为空），跳过本次投递。去设置页「日记」里点「把当前会话指定为日记会话」')
    return undefined
  }

  const agents = serviceOf(ctx, 'agents')
  if (agents === undefined || agents === null || typeof agents.get !== 'function') {
    note('diary', `绑定的日记会话不可用：宿主没有 agents 服务（${sessionId}）`)
    return undefined
  }

  const reasons = []

  // ① 活着的
  try {
    const live = agents.get(sessionId)
    if (live !== undefined && live !== null) {
      note('diary', `绑定的日记会话已在运行：${sessionId}`)
      return live
    }
    reasons.push('当前不活跃')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    note('diary', `取活会话 ${sessionId} 失败：${message}`)
    reasons.push(`get 失败：${message}`)
  }

  // ② 冷启动
  if (typeof agents.resume !== 'function') {
    reasons.push('agents 服务没有 resume 方法')
  } else {
    try {
      // 必须带上 setup：resume 只恢复会话，不恢复 preset。
      // 不带的话日记会话会「活着但没有工具」，而且不报错（2026-11-03 事故）。
      const setup = await composeDiarySetup(ctx, sessionId)

      // 2026-11-05 修：还必须有 agentOptions.model。
      //
      // 文档原话：「agents[].provider / agents[].model —— 模型路由；分发前两者都必须存在」。
      // resume 一个持久化会话时，模型**不会**从会话里恢复（session 头里根本没这个字段），
      // 不显式传就得到一个没有模型的 agent。后果不是「模型选错了」，而是装配直接抛：
      //   prompt variable "{{model}}" has no value (section "deployment:persona-prefix")
      // 每一轮都抛，日记一个字也写不出来 —— 而且界面只显示「本轮运行失败」，很难联想到模型。
      //
      // 路由取日记专用配置；没配就退回 diarySummarize*（也是给日记用的），
      // 两个都没有时明确记一行，不要静默传空。
      const provider = String(config.diaryAgentProvider ?? '').trim() || String(config.diarySummarizeProvider ?? '').trim()
      const model = String(config.diaryAgentModel ?? '').trim() || String(config.diarySummarizeModel ?? '').trim()
      let agentOptions
      if (provider !== '' && model !== '') {
        agentOptions = { provider, model }
      } else {
        note('diary', '没配 diaryAgentProvider/Model 也没配 diarySummarize*：冷启动的日记会话将没有模型，装配会失败')
      }

      const handle = await agents.resume({
        resumeSessionId: sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
        ...(setup === undefined ? {} : { setup })
      })
      const agent = handle?.agent
      if (agent !== undefined && agent !== null) {
        note('diary', `冷启动绑定的日记会话成功：${sessionId}`)
        return agent
      }
      reasons.push('resume 没有返回 agent')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      note('diary', `冷启动绑定的日记会话 ${sessionId} 失败：${message}`)
      reasons.push(`resume 失败：${message}`)
    }
  }

  note('diary', `绑定的日记会话不可用：${reasons.join('；') || '未知原因'}（${sessionId}）`)
  return undefined
}



// --------------------------------------------------------------------------
// 启动时写（2026-10-31 改造：去掉 22:00 闹钟）
// --------------------------------------------------------------------------

/**
 * 每次 DSH 启动时跑一遍日记流程。返回停止函数（保留接口形状，便于 ctx.effect 挂载）。
 *
 * 【为什么去掉定时器】
 *
 * 原先用 setTimeout 自调度，每天 22:00 叫醒写日记。可真实的机器不会 24 小时开着 ——
 * 22:00 那个点，电脑多半是关的。闹钟定得再准，人不在家，它响给谁听？
 * 而 setTimeout 本身还有个隐藏短板：DSH 不在线时它不跑，那天的日记就静默丢了。
 *
 * 现在的规则：
 *   人醒着才记得今天做过什么 —— 日记也一样。
 *   **开机第一次就写**：DSH 一起来，把该写的日子补上，然后随它去。
 *
 * 一天内多次重启不会重复写：runDiaryOnce 会先看 diaryPrivatePath(dateStr)
 * 是否已存在（config.diaryOverwrite === false 时跳过）。
 * 默认 diaryOverwrite = true，同一天重开会覆盖 —— 覆盖比丢了好。
 */
export function startDiaryTimer(ctx, { budgetMs = DIARY_TOTAL_BUDGET_MS } = {}) {
  let stopped = false
  // 2026-11-06 审计 P2-7：前置流程也要有在途保护。
  // 原来只有内层 runDiaryOnce 有 diaryInFlight，而看门狗每 30 分钟无条件再跑一次
  // runStartupFlow —— 前置的读 JSONL / 冷启动 resume / 解压 zstd 可以叠加，
  // 慢机器上会同时有几条流程在读同一天的文件。
  let startupInFlight = false
  const budget = Math.min(MAX_DIARY_BUDGET_MS,
    Math.max(MIN_DIARY_BUDGET_MS, Math.trunc(Number(budgetMs) || DIARY_TOTAL_BUDGET_MS)))

  /** 真正的活。外层只负责限时与放锁，这里不碰锁。 */
  const startupWork = async () => {
    const config = loadConfig()
    if (config.diaryEnabled === false) {
      note('diary', '日记功能已关闭，跳过启动写')
      return
    }
    // 2026-10-31（树树定）：**写昨天，不写今天。**
    //
    // 日记本来就是回头看。当天刚聊完就写，只写得到半天；
    // 第二天再写，昨天的窗口 00:00–24:00 已经完整闭合，一天都在里面。
    // 而且这样一来「开机补」和「一直不关机」用的是同一条逻辑 —— 都是补昨天，
    // 不再需要区分机器什么时候开、什么时候关。
    const dateStr = yesterdayKey(Date.now())

    // 开机写不重复烧钱：昨天已经完整写过就跳过。
    //
    // 2026-11-01 修：原来只判断「两个文件在不在」，不看是什么时候写的。
    // 结果下午手动补的那一篇（窗口还没闭合，只写到半天）把第二天真正的
    // 补写挡掉了 —— 下午到晚上整段丢失。现在用 diaryIsCompleteFor 判完整性。
    if (diaryIsCompleteFor(dateStr)) {
      note('diary', `${dateStr} 两篇都已写完，跳过`)
      return
    }
    // 2026-11-07 R05 / P1-D3：这里一旦判定「有旧版、要重写」，就必须同时记下
    // 本轮开始的时间，并一路传到 askAgentToWrite —— 否则那边的 `exists(file)`
    // 会把这份旧文件当成「她刚写的」，直接记完成，于是永远重写不出来。
    // 只有这一条分支传 since；其它调用方（追补、手动重写）保持老行为，
    // 避免把刚写好的文件误判成旧文件再找她写一遍。
    let since = 0
    if (exists(diaryPublicPath(dateStr)) || exists(diaryPrivatePath(dateStr))) {
      since = Date.now()
      note('diary', `${dateStr} 有旧版但写于窗口闭合前（只写了半天），重写`)
    }

    // 2026-11-07 R11 / P2-23：整条启动流程共用**一份**总预算。
    // 原来两次 runDiaryOnce 各自吃满 budget（外层 12 分钟装两次），追补最长能拖到 ~24 分钟。
    // 现在记下起点，第二次只用剩下的。
    const flowStartedAt = Date.now()
    const remainingBudget = () => Math.max(MIN_DIARY_BUDGET_MS, budget - (Date.now() - flowStartedAt))

    note('diary', `开始写 ${dateStr}（昨天）`)
    const ok = await runDiaryOnce(ctx, dateStr, undefined, { budgetMs: remainingBudget(), since })
    // 写完再顺手看看更早的日子有没有漏的（一次只补最近的一天，避免流水账）
    if (ok) {
      try {
        const older = findMissingDay(todayKey(Date.now()), Number(config.diaryBackfillDays) || 4)
        if (older !== null && older !== dateStr) {
          note('diary', `发现更早的缺失日 ${older}，接着补（剩余预算 ${Math.round(remainingBudget() / 1000)}s）`)
          await runDiaryOnce(ctx, older, undefined, { budgetMs: remainingBudget() })
        }
      } catch (error) {
        note('diary', `往前追补失败：${error instanceof Error ? error.message : error}`)
      }
    }
    note('diary', ok ? `写完成：${dateStr}` : `写未完成：${dateStr}`)
  }

  const runStartupFlow = async () => {
    if (stopped) return
    if (startupInFlight) return
    // 上一轮超时后那条链还在跑：不重入，避免两个写手同时改同一天的文件
    if (orphanChains.has('startup')) {
      note('diary', '上一轮超时的那条启动链还没结束，这次不重入')
      return
    }
    startupInFlight = true
    const chain = startupWork()
    try {
      await withDeadline(chain, budget, '启动写流程')
    } catch (error) {
      // 2026-11-06 第二份审查 H-2：一次挂起以前会让看门狗永久堵死，
      // 现在至少调用方能回来，并且明确写进日志（原来只有「开始写」没有下文）。
      note('diary', `启动写失败：${error instanceof Error ? error.message : error}`)
      if (String(error instanceof Error ? error.message : error).includes('超过总预算')) {
        markOrphan('startup', chain)
      }
    } finally {
      // 无论成败都要放锁，否则一次抛错就把整条看门狗永久堵死
      startupInFlight = false
    }
  }

  // 不阻塞启动：DSH 起来的同时在后台写，写完落盘。
  // 稍等一会儿再跑 —— 让宿主服务（llm / agents）都装好，别抢跑。
  const delayMs = 5000
  const startupTimer = setTimeout(() => { void runStartupFlow() }, delayMs)
  if (startupTimer !== null && typeof startupTimer.unref === 'function') startupTimer.unref()
  note('diary', `启动写已排队（${delayMs / 1000} 秒后执行）`)

  // ── 看门狗（2026-10-31 补）─────────────────────────────────────────
  //
  // 电脑也可能一直不关机 —— 那样「开机写」一天都轮不到一次，日记照样空着。
  // 所以再加一条：活着的时候定时看一眼，发现今天还没写就补上。
  //
  // 它不是定点闹钟：不绑 22:00，只要「今天缺了」就补，所以不在乎机器几点开、几点关。
  // 检查本身只是两次文件存在性判断，几乎不花钱；真正烧钱的生成一天最多一次。
  //
  // 2026-11-07 R11 / P2-22：间隔原来是**启动时读一次配置就固定下来**的，
  // 用户把 diaryWatchdogMinutes 从 30 改成 180 之后要重启才生效（而且没有任何提示）。
  // 现在定时器按 1 分钟滴答，每次现读配置、自己算够没够间隔。
  const WATCHDOG_TICK_MS = 60 * 1000
  let lastWatchdogAt = 0
  const watchdogTimer = setInterval(() => {
    const minutes = Number(loadConfig().diaryWatchdogMinutes || 30)
    const intervalMs = Math.max(minutes * 60 * 1000, 60 * 1000)
    const nowMs = Date.now()
    if (lastWatchdogAt > 0 && nowMs - lastWatchdogAt < intervalMs) return
    lastWatchdogAt = nowMs
    // 2026-11-06 审计 P2-7：原来 `.catch(() => {})` 把整条流程的异常吞成空函数，
    // 看门狗死了也看不出来。至少留一行日志。
    void runStartupFlow().catch((error) => {
      note('diary', `看门狗执行失败：${error instanceof Error ? error.message : error}`)
    })
  }, WATCHDOG_TICK_MS)
  if (watchdogTimer !== null && typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
  note('diary', `看门狗已启动（每 ${Math.max(Number(loadConfig().diaryWatchdogMinutes || 30), 1)} 分钟检查一次今天缺不缺；改配置立即生效）`)

  return () => {
    stopped = true
    if (startupTimer !== null) clearTimeout(startupTimer)
    if (watchdogTimer !== null) clearInterval(watchdogTimer)
  }
}


// --------------------------------------------------------------------------
// 主流程
// --------------------------------------------------------------------------

/**
 * 执行一次完整的日记生成流程。
 *
 * 1. 读当天对话 JSONL（按 schedule 分界裁剪）
 * 2. 取专属日记会话的 agent
 * 3. LLM 摘要（失败用原始对话兜底）
 * 4. 读最近 N 天日记
 * 5. 投第一条：公开（只带公开日记历史）
 * 6. 等公开那篇落盘（超时也继续）
 * 7. 投第二条：私密（这时候才给全部历史）
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} [manualNote] 手动触发时的备注（追加到对话内容之后）
 * @returns {Promise<boolean>} 是否成功投递
 */
/**
 * 投一条消息给绑定会话，让她自己写日记，然后等文件出现（2026-11-04）。
 *
 * ── 回执为什么用「文件出现」而不是 followup 的返回值 ──
 *   2026-10-31 就是栽在这儿：`agent.followup()` **同步返回 void**，旧判据
 *   「没抛异常就算发送成功」对 void 函数恒为真 —— 日志天天报「已发送」，
 *   取证的时候 335 个事件里 `source.kind='schedule'` 零命中，一个 turn 都没进。
 *
 *   官方 schedule 插件靠 `await sessions.flush(agent.session)` 拿回执，但那是从
 *   打包好的 exe 里逆出来的接口，我在这边没法验证它一定存在。而 flush 也只能证明
 *   「消息进了 turn」，证明不了「她把文章写完了」。
 *
 *   所以判据直接取最终事实：**目标文件在不在**。文件在就是写成了，别的一律不算。
 *
 * ── source.kind 为什么是 'schedule' ──
 *   extract.js 会跳过这个来源（不进记忆），mood.js 也跳过（不影响心情），
 *   日记扫描自己也跳过（不进 JSONL）—— 否则「叫她写日记」这件事本身会被
 *   记成一条对话，越滚越多。
 *
 * @returns {{ asked: boolean, wrote: boolean, reason: string }}
 */
/**
 * 文件的 mtime（毫秒）。读不到就返回 0 —— 调用方据此当成「比任何 since 都旧」，
 * 也就是宁可重写一次，也不要把旧文件当成她的新产出。
 */
function mtimeMsOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 决定「还要不要再找她写一次」。
 *
 * 2026-11-07 R05 / P1-D3：抽成纯函数，一是给测试一个确定的入口，
 * 二是把这条判断从 followup 的一大段代码里拎出来单独说清楚。
 *
 * - force（手动重写）→ 一定重新写
 * - 文件不存在 → 要写
 * - 文件存在 + since=0（没有时间基线，老调用方）→ 当她已经写过（保持老行为）
 * - 文件存在 + since>0 → 只有比 since 新才算「她这轮写的」，否则是旧文件，重写
 *
 * @param {string} file
 * @param {{ force?: boolean, since?: number }} [options]
 * @returns {boolean} true = 要问她/重写
 */
export function shouldAskAgain(file, { force = false, since = 0 } = {}) {
  if (force === true) return true
  if (!exists(file)) return true
  if (!(since > 0)) return false
  const mtime = mtimeMsOf(file)
  // mtime 读不到（被删/权限）时按「更旧」处理：宁可重写一次，也不要把旧文件当成新产出
  return mtime < since
}

async function askAgentToWrite(ctx, agent, text, file, timeoutMs, { force = false, since = 0 } = {}) {
  // 已经写过了就别再投 —— 投了也只能等来一个「已存在」的文件，白打扰她一次。
  //
  // 这条必须排在 agent 检查**之前**：否则没绑定会话的时候，哪怕她早就写好了，
  // 也会一路掉进兜底生成，把她写的日记整篇覆盖掉。
  // force（手动重写某一天）时跳过这个判断 —— 那种场景就是要重新写。
  //
  // ── 2026-11-07 R05 / P1-D3：光看「文件在不在」会把旧文件当成她刚写的 ──
  //
  // 事故链：某天有一篇「写于当天最后一句话之前」的半成品（下午手动补的），
  // startupWork 判它不完整 → 决定重写 → 走到这里看到文件存在 → 认为"她写好了"
  // → 记「日记完成」返回 true → 文件没变 → 下一轮仍不完整 → 再走一遍……
  // 结果是**看门狗每 30 分钟空转一次**，而日志里写的是「日记完成」，看起来一切正常，
  // 那段内容永远补不回来。
  //
  // 现在多一个时间判据：`since` = 这一轮开始重写的时间。文件比它旧，就说明是上一轮
  // 留下的旧文件，不能算「她这次写的」。`since` 为 0 时保持老行为（其它调用方不受影响）。
  if (!shouldAskAgain(file, { force, since })) {
    return { asked: false, wrote: true, reason: '' }
  }
  if (exists(file) && force !== true) {
    // 走到这里 = 文件在、但比 since 旧 → 是上一轮留下的旧文件，这次重新问她
    note('diary', `${file} 是旧文件（写于本轮之前），这次重新找她写`)
  }

  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    return { asked: false, wrote: false, reason: '没有可投递的会话（followup 不可用）' }
  }

  let message
  try {
    const blocks = [{ type: 'text', text }]
    const llm = serviceOf(ctx, 'llm')
    message = llm !== undefined && llm !== null && typeof llm.createUserMessage === 'function'
      ? llm.createUserMessage({ content: blocks, source: { kind: 'schedule' } })
      : {
          id: `soul-diary-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'user',
          content: blocks,
          source: { kind: 'schedule' }
        }
  } catch (error) {
    return { asked: false, wrote: false, reason: `构造消息失败：${error instanceof Error ? error.message : error}` }
  }

  // 记下投递前的 mtime，用来判断「是不是这次写出来的」。
  // followup 有可能是**同步**写盘的（插件内部的工具调用可以在同一个 tick 里跑完），
  // 所以投完要立刻看一眼 —— 不能直接交给 waitForWrite：
  // waitForWrite 的语义是「等 mtime 变化」，它进去时会把当前 mtime 当成基线，
  // 文件要是已经写好了，基线就等于完成后的值，于是永远等不到「变化」。
  const mtimeBefore = (() => {
    try {
      return exists(file) ? statSync(file).mtimeMs : 0
    } catch {
      return 0
    }
  })()

  try {
    agent.followup(message)
  } catch (error) {
    return { asked: false, wrote: false, reason: `投递抛异常：${error instanceof Error ? error.message : error}` }
  }

  // 同步就写完的情况：这里直接认，别再去等一个永远不会来的 mtime 变化
  try {
    if (exists(file) && statSync(file).mtimeMs > mtimeBefore) return { asked: true, wrote: true, reason: '' }
  } catch {
    /* 读不到就往下走，交给异步等待 */
  }

  const wrote = await waitForWrite(file, timeoutMs)
  return {
    asked: true,
    wrote,
    reason: wrote ? '' : `等了 ${Math.round(timeoutMs / 1000)} 秒没见她写出文件`
  }
}


/**
 * 同一天同时只允许一条写日记的流程在跑（2026-11-04 修 ④）。
 *
 * 起因：启动时有两处会触发写日记 —— startDiaryTimer 里 +5 秒的启动写，
 * 和 index.js 立刻发起的 runCatchUp。两者都可能盯上**同一天**，
 * 而 runDiaryOnce 原先没有 in-flight 锁：
 *   · 各投一次消息 / 各生成一次 → 白花两份钱；
 *   · 而且两篇可能是不同次写的 —— 公开来自 A 次、私密来自 B 次，
 *     语气和视角对不上，最糟的情况是 A 写完公开、B 又用自己那份覆盖一遍。
 *
 * 按**日期**加锁而不是全局锁：两条流程补不同的日子时本来就该并行，
 * 只有同一天才需要互斥。
 */
const diaryInFlight = new Set()

/**
 * 2026-11-06 第二份审查 H-2：整条链的**总预算**。
 *
 * 现状：`agents.resume`（:79）、`presets.resolve/mount`（compose:583/585）都没有超时，
 * 全链路唯一的超时是 `composeDiaryText` 里 llm-stream 的 30 秒，覆盖不到前段。
 * 一次挂起 = 锁（`startupInFlight` / `diaryInFlight`）永远不放 = 看门狗每轮直接 return
 * = 当天日记永久写不出来，而且日志里只有「开始写」没有下文。
 *
 * 12 分钟的依据：正常路径（读 JSONL + resume + 两次投递 + 等文件）在本机实测 < 2 分钟，
 * 慢机器 + 冷启动留 6 倍余量。**不给它加配置键** —— 这一轮不新增可以被调大的旋钮。
 */
export const DIARY_TOTAL_BUDGET_MS = 12 * 60_000
const MIN_DIARY_BUDGET_MS = 1_000
const MAX_DIARY_BUDGET_MS = 30 * 60_000

/**
 * 只负责让**调用方**能回来。被丢下的链仍在跑，所以下面要记 orphan。
 */
function withDeadline(promise, ms, label) {
  let timer = null
  const deadline = new Promise((_, reject) => {
    // 刻意**不 unref**：这条定时器最多活到本轮结束（finally 里 clearTimeout）。
    // unref 的话，当「这一轮是进程里唯一待处理的事」时事件循环会直接退出，
    // await 的人永远等不到 —— 单测里立刻就能复现（unsettled top-level await）。
    // 而一轮日记正在跑的时候，进程本来就该是忙的。
    timer = setTimeout(() => reject(new Error(`${label} 超过总预算 ${ms}ms`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

/**
 * 超时之后仍在跑的那些链。
 *
 * 为什么需要：`Promise.race` 不会取消被丢下的那条链。如果立刻放开锁，新一轮会
 * 和"还在跑的老链"同时读写同一天的文件 —— 比卡死更糟（可能写出一半的日记）。
 * 所以记下来，等它自己结束再放开。键是 dateKey（或 'startup'）。
 */
const orphanChains = new Map()

function markOrphan(key, chain) {
  let wrapper = null
  wrapper = chain.then(() => {}, () => {}).finally(() => {
    if (orphanChains.get(key) === wrapper) {
      orphanChains.delete(key)
      note('diary', `${key}：上一轮超时的那条链已结束，锁已放开`)
    }
  })
  orphanChains.set(key, wrapper)
}


export async function runDiaryOnce(ctx, dateStr, manualNote, options = {}) {
  const key = String(dateStr ?? '').trim()
  if (key === '') return false
  if (diaryInFlight.has(key)) {
    note('diary', `${key} 的日记正在写（另一条流程在跑），这次重复触发直接跳过`)
    return false
  }
  if (orphanChains.has(key)) {
    note('diary', `${key}：上一轮超时后那条链还没结束，这次不重入（避免两个写手）`)
    return false
  }
  const budget = Math.min(MAX_DIARY_BUDGET_MS,
    Math.max(MIN_DIARY_BUDGET_MS, Math.trunc(Number(options.budgetMs) || DIARY_TOTAL_BUDGET_MS)))
  diaryInFlight.add(key)
  const chain = runDiaryOnceLocked(ctx, dateStr, manualNote, options)
  try {
    return await withDeadline(chain, budget, `写 ${key} 的日记`)
  } catch (error) {
    // 超时才算（业务异常由 runDiaryOnceLocked 自己吞），两种情况都要留痕
    note('diary', `${key} 写失败：${error instanceof Error ? error.message : error}`)
    if (String(error instanceof Error ? error.message : error).includes('超过总预算')) markOrphan(key, chain)
    return false
  } finally {
    diaryInFlight.delete(key)
  }
}


/** 测试用：清掉 in-flight 锁（正常流程靠 finally 释放）。 */
export function __resetDiaryInFlightForTest() {
  diaryInFlight.clear()
  // 2026-11-06 H-2：orphan 记录也要清 —— 否则一个超时过的测试会把后续测试全挡在门外
  orphanChains.clear()
}


async function runDiaryOnceLocked(ctx, dateStr, manualNote, { force = false, since = 0 } = {}) {
  const config = loadConfig()

  // overwrite=false 且日记已存在 → 跳过
  if (config.diaryOverwrite === false && exists(diaryPrivatePath(dateStr))) {
    note('diary', `${dateStr} 的日记已存在（overwrite=false），跳过`)
    return false
  }

  // force：跳过「已经写完了」的判断（手动重写某一天时用）。
  // 2026-11-02 加 —— 那时改了挑对话的逻辑，想重跑昨天看效果，
  // 但看门狗认「两篇都在且 mtime 过了窗口」就跳过，根本轮不到重写。
  //
  // 2026-11-04：它现在真的传下去了。之前这里是 `void force`（什么都不做），
  // 因为当时只有一条代笔路径、文件存在与否由调用方判断。现在多了「先看她写没写」
  // 这一层，force 必须能穿透到那一层，否则重写永远会被「文件已存在」挡住。

  // 1. 读对话
  // 2026-10-31：改成自然日，不再读 diarySchedule 的分界。
  // 传 0 只为兼容函数签名；真正的边界在 diaryDayBoundaries 里固定成 00:00~24:00。
  const sm = 0
  let conversationText = ''
  try {
    conversationText = readDiaryConversations(dateStr, sm)
  } catch (error) {
    note('diary', `读取对话失败：${error instanceof Error ? error.message : error}`)
  }

  // 喂给日记前先挑（2026-11-02 改）。
  //
  // 原来是「超过 30000 字就从前面截断」——实测那天 57245 字，砍掉 47%，
  // 而砍掉的正好是早上那半段：一天里越早的事越容易被丢，最后只剩晚上。
  // 更糟的是内容构成：那天 88% 的字是她说的话，其中 80% 是技术细节
  //（函数名、断言数、commit hash），对日记毫无意义。
  //
  // 现在改成逐条打分、按分数挑、再按时间重排：
  //   · 生活/情绪词加分，代码标识符和路径减分
  //   · 树树的话权重 ×1.5（他那天只说 3216 字，她 23546 字，平分就听不见他了）
  //   · 纯技术的长文（负分）直接不要
  // 实测 26762 字 → 挑出 8517 字，生活占比从 20% 升到 87%，全天跨度保住。
  const inputMax = Number(config.diaryMaxConversationChars) || 8000
  let feedText = conversationText
  let pickStats = null
  try {
    const rows = readConversationRows(dateStr, sm)
    if (rows.length > 0) {
      const picked = pickConversation(rows, { maxChars: inputMax, ownerName: config.ownerName })
      pickStats = picked
      feedText = picked.text
      note('diary', `对话 ${picked.totalChars} 字 / ${rows.length} 条 → 挑出 ${picked.picked} 条 ${picked.usedChars} 字`
        + `（丢掉 ${picked.dropped} 条，生活占比 ${Math.round(picked.lifeRatio * 100)}%）`)
    } else if (feedText.length > inputMax) {
      // 读不出结构化行时退回老的截断（至少不会崩）
      feedText = feedText.slice(-inputMax)
      note('diary', `对话 ${conversationText.length} 字，读不出结构化行，退回截断到 ${inputMax}`)
    }
  } catch (error) {
    if (feedText.length > inputMax) feedText = feedText.slice(-inputMax)
    note('diary', `挑对话失败，退回截断：${error instanceof Error ? error.message : error}`)
  }

  // 2. 取 agent —— **不再是硬依赖**（2026-11-01，审计 C8）。
  //
  // 这里原来取不到就 return false，等于：没绑定专属会话 → 一篇日记都不写。
  // 可 agent 现在唯一用途是 composeDiaryText 里「没配 provider/model 时问一下默认路由」，
  // 而写盘（writeDiaryFile）跟它半点关系没有 —— 是改造完留下的残留依赖。
  // 现在：配了 diarySummarizeProvider/Model 就完全不碰 agent；没配又取不到才失败，
  // 而那种失败由 composeDiaryText 自己说清原因（它会把「取不到模型路由」写进日志）。
  const agent = await diaryAgent(ctx)
  if (agent === undefined || agent === null) {
    const configured = Boolean(config.diarySummarizeProvider && config.diarySummarizeModel)
    note('diary', configured
      ? '专属日记会话不可用，但已配置 diarySummarizeProvider/Model，照常写'
      : '专属日记会话不可用，且没配置日记专用模型 —— 只能退回会话模型（此时必然失败）')
  }

  // 3. 【2026-10-31 改】不再先做摘要。
  //
  // 为什么砍掉：实测摘要只吐出 128 字（提示词要 300–800），而它挑的全是窗口
  // 开头那段技术密集讨论 —— 同一天后半段「日记投递链调查」整个被压没了，
  // 结果日记写成昨天的事。摘要由模型自己判断「什么值得记」，而这件事不该由它决定。
  // 现在直接把对话原文喂给 composeDiaryText（已按 inputMax 截过），
  // 让她同时看到一整天的全貌，自己决定写什么。
  //
  // summarizeConversations 仍保留导出（其他调用方/测试可能还在用），
  // 但日记主流程不再走它。
  let summary = feedText.trim() === '' ? '今天没有对话' : feedText
  note('diary', `喂给日记的对话原文 ${summary.length} 字（上限 ${inputMax}）`)

  // 手动备注（2026-11-04：diaryManualNote 这个开关原来只写在默认值表里没人读，
  // 现在真的接上了 —— 关掉之后手动触发也不接受备注，避免「以为是设置没生效」。）
  if (config.diaryManualNote !== false && manualNote && String(manualNote).trim() !== '') {
    summary += `\n\n备注：${String(manualNote).trim()}`
  }

  // 4. 读最近日记 + 当天的情绪底色
  const recentDiaries = readRecentDiaries(dateStr, Number(config.diaryBackfillDays) || 4)
  const moodBlocks = config.moodEnabled === false
    ? { public: '', private: '' }
    : buildMoodBlocks(dateStr, sm, { config })

  // 连续线（2026-11-01）：把还悬着的事带进提示词。
  // 先过期再渲染 —— 挂了 7 天没人提的，今天就不该再拿出来。
  let threadState = loadThreads()
  threadState = expireThreads(threadState.state, dateStr).state
  const threadSection = renderThreadSection(threadState, { today: dateStr })

  // 5–8. 先让她自己写，没写成才由插件兜底（2026-11-04 改）
  //
  // 2026-10-31 那版是纯代笔：llm.stream 生成 → atomicWrite，写完就在那儿，没有中间态。
  // 可靠，但日记里没有「她决定写这件事」的成分 —— 她只是被当成一个无状态模型调了一次。
  //
  // 现在改成两段式：先投消息让她用 soul_diary 写，等文件出现；等不到再走老路生成。
  // 代价是中间态回来了（她可能不写），收益是正常情况下这篇日记真是她写的：
  // 她那边有完整人格注入、记忆、心情，而不只是这里拼的一段任务 prompt。
  //
  // 触发时机一点没动 —— 还是开机补写 + 看门狗，没有加定时器。
  // 所以「机器关着的那几天」这个老问题没有被这次改动重新引入。
  const llm = serviceOf(ctx, 'llm')
  // force（手动重写某一天）时直接走兜底生成，不投消息（2026-11-04）：
  // soul_diary 现在默认拒绝覆盖已存在的日记，她收到消息也写不进去，
  // 只能白等一个超时再掉兜底。重写的语义本来就是"插件重新生成一遍"。
  const useAgent = config.diaryAgentWrite !== false && force !== true
  const timeoutMs = Math.max(10_000, Number(config.diaryAgentTimeoutMs) || 180_000)
  // 2026-11-07 R05 / P1-D2：**问她之前**的时间基线。兜底写盘时用它判断
  // 「她是不是在超时判定之后才落盘的」—— 那种情况不能让兜底覆盖她。
  const askedAt = Date.now()

  let publicBy = 'fallback'
  // 公开那条到底有没有真的投进这个会话（2026-11-06）：
  // 只有投进去了，写私密时才省得掉重复语料；文件已存在、没投递的情况她压根没看过，
  // 那条消息得照旧带全。
  let publicAsked = false
  if (useAgent) {
    const message = composePublicMessage(config, dateStr, summary, recentDiaries, moodBlocks.public, threadSection)
    const result = await askAgentToWrite(ctx, agent, message, diaryPublicPath(dateStr), timeoutMs, { force, since })
    publicAsked = result.asked === true
    if (result.wrote) {
      publicBy = 'agent'
      note('diary', `${dateStr} 公开日记：她自己写好了${result.asked ? '' : '（文件已在，没有再打扰她）'}`)
    } else {
      note('diary', `${dateStr} 公开日记：让她自己写没成（${result.reason}），改用插件兜底生成`)
    }
  }

  if (publicBy === 'fallback') {
    const publicText = await composeDiaryText(llm, config, agent, 'public', {
      dateStr, summary, recentDiaries, moodText: moodBlocks.public, threadSection
    })
    if (publicText === null) {
      note('diary', `日记未完成（${dateStr}）：公开那篇既没等到她写、生成也失败，私密也不再写`)
      return false
    }
    if (!writeDiaryFile('public', dateStr, publicText, { skipIfNewerThan: askedAt })) {
      // 2026-11-07 P1-D2：写盘失败或「她刚写过、兜底让路」都走这里。
      // 让路的情形不该记成「写盘失败」，但要如实说没写成 —— 下一轮会重新判定。
      note('diary', `日记未完成（${dateStr}）：公开那篇没落盘（写盘失败，或她刚好写好、兜底已让路）`)
      return false
    }
  }

  // 公开落盘之后才轮到私密 —— 顺序本身就是隔离：
  // 她写公开那一步拿到的消息里只有公开历史，看不到私密内容。
  let privateBy = 'fallback'
  if (useAgent) {
    const message = composePrivateMessage(config, dateStr, summary, recentDiaries, moodBlocks.private, threadSection, {
      continueFromPublic: publicAsked,
      publicWrittenByAgent: publicBy === 'agent'
    })
    const result = await askAgentToWrite(ctx, agent, message, diaryPrivatePath(dateStr), timeoutMs, { force, since })
    if (result.wrote) {
      privateBy = 'agent'
      note('diary', `${dateStr} 私密日记：她自己写好了${result.asked ? '' : '（文件已在，没有再打扰她）'}`)
    } else {
      note('diary', `${dateStr} 私密日记：让她自己写没成（${result.reason}），改用插件兜底生成`)
    }
  }

  let privateText = ''
  if (privateBy === 'fallback') {
    privateText = await composeDiaryText(llm, config, agent, 'private', {
      dateStr, summary, recentDiaries, moodText: moodBlocks.private, threadSection
    }) ?? ''
    if (privateText === '') {
      note('diary', `日记未完成（${dateStr}）：私密那篇既没等到她写、生成也失败（公开已写入）`)
      return false
    }
    if (!writeDiaryFile('private', dateStr, privateText, { skipIfNewerThan: askedAt })) {
      note('diary', `日记未完成（${dateStr}）：私密那篇没落盘（写盘失败，或她刚好写好、兜底已让路；公开已写入）`)
      return false
    }
  } else {
    // 她自己写的，正文从文件里读回来 —— 下面更新连续线要用它的内容
    try {
      privateText = readText(diaryPrivatePath(dateStr))
    } catch {
      privateText = ''
    }
  }

  note('diary', `日记完成（${dateStr}）：公开（${publicBy === 'agent' ? '她写的' : '插件生成'}）+ 私密（${privateBy === 'agent' ? '她写的' : '插件生成'}）`)

  // 写完才动线：先关掉今天被提到的，再从私密那篇里开新的。
  // 顺序不能反 —— 反了会把今天刚开的线立刻当成"今天提过"关掉。
  // 用自己的产出（私密篇）当依据：公开那篇是给别人看的，会收着写。
  try {
    const mentioned = closeMentioned(threadState, privateText, dateStr)
    let next = mentioned.state
    for (const sentence of extractThreads(privateText)) {
      next = openThread(next, sentence, dateStr)
    }
    saveThreads(next)
    if (mentioned.closed.length > 0) note('diary', `今天收掉了：${mentioned.closed.join(' / ')}`)
  } catch (error) {
    // 线是锦上添花，坏了不能让日记整个失败
    note('diary', `连续线更新失败（日记本身已写完）：${error instanceof Error ? error.message : error}`)
  }
  return true
}


/**
 * 启动时补写：找最近缺失日，只补那一天。
 */
/**
 * 重写某一天的日记（2026-11-02 加）。
 *
 * 和看门狗、开机补写走同一套逻辑，只是跳过「两篇都在就跳过」那道闸 ——
 * 改完挑对话/提示词之后想拿真实数据看效果，需要它。
 * 不对外暴露成 UI 按钮：重写会花一次生成的钱，不该手滑点到。
 */
export async function regenerateDiary(ctx, dateStr) {
  note('diary', `重写 ${dateStr} 的日记（手动触发）`)
  return runDiaryOnce(ctx, dateStr, '', { force: true })
}

export async function runCatchUp(ctx) {
  const config = loadConfig()
  if (config.diaryCatchUp === false) return
  if (config.diaryEnabled === false) return

  const today = todayKey(Date.now())
  const missing = findMissingDay(today, 7)
  if (missing === null) {
    note('diary', '没有缺失的日记，不需要补写')
    return
  }

  note('diary', `补写缺失日：${missing}`)
  try {
    await runDiaryOnce(ctx, missing)
  } catch (error) {
    note('diary', `补写失败：${error instanceof Error ? error.message : error}`)
  }
}

// P3：时间工具与完整性判定已迁到 ./diary/completion.js，这里保持原导出名
