/**
 * 摘录 · scheduler.js
 * 由 lib/diary.js 按职责拆出（2026-11-06 模块化重构）。
 *
 * 2026-11-21 / 0.10.0：产出从「公开 + 私密两篇」改成「一篇摘录」。
 * 触发链路（启动补写 / 看门狗 / 总预算 / 孤儿链 TTL / 按日期加锁）**一行逻辑都没动**，
 * 只是把「两条消息、两篇文件」收成「一条消息、一篇文件」，兜底从「再调一次模型」
 * 换成规则化提取（见 fallback.js）。
 */
import { diaryAgent } from './agent.js'
import { composeExcerptMessage } from './compose.js'
import { diaryIsCompleteFor, todayKey, yesterdayKey } from '../diary/completion.js'
import { diaryExcerptPath, exists } from '../paths.js'
import { findMissingDay, writeExcerptFile } from './files.js'
import { askAgentToWrite } from './deliver.js'
import { excerptFromConversations } from './fallback.js'
import { readRecentExcerpts } from './history.js'
import { loadConfig } from '../store.js'
import { note } from '../env.js'
import { readDiaryConversations } from './feed.js'

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
 * 一天内多次重启不会重复写：runDiaryOnce 会先看 diaryExcerptPath(dateStr)
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
      note('diary', `${dateStr} 的摘录已写完，跳过`)
      return
    }
    // 2026-11-07 R05 / P1-D3：这里一旦判定「有旧版、要重写」，就必须同时记下
    // 本轮开始的时间，并一路传到 askAgentToWrite —— 否则那边的 `exists(file)`
    // 会把这份旧文件当成「她刚写的」，直接记完成，于是永远重写不出来。
    // 只有这一条分支传 since；其它调用方（追补、手动重写）保持老行为，
    // 避免把刚写好的文件误判成旧文件再找她写一遍。
    let since = 0
    if (exists(diaryExcerptPath(dateStr))) {
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
    if (orphanChains.has('startup') && !orphanExpired('startup')) {
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

/**
 * 执行一次完整的摘录生成流程（0.10.0：一条消息、一篇文件）。
 *
 * 1. 读那天对话 JSONL
 * 2. 取绑定会话的 agent
 * 3. 投一条消息，让她用 soul_diary 写摘录，等文件出现
 * 4. 等不到 → 规则化兜底（从流水里提取「谁说了什么」，不调模型）
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} [manualNote] 手动触发时的备注（追加到对话内容之后）
 * @returns {Promise<boolean>} 是否成功写出
 */

/**
 * 同一天同时只允许一条写摘录的流程在跑（2026-11-04 修 ④）。
 *
 * 起因：启动时有两处会触发 —— startDiaryTimer 里 +5 秒的启动写，
 * 和 index.js 立刻发起的 runCatchUp。两者都可能盯上**同一天**，
 * 而 runDiaryOnce 原先没有 in-flight 锁：
 *   · 各投一次消息 / 各生成一次 → 白花两份钱；
 *   · 两条流程还可能各写一半、互相覆盖。
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
 * 一次挂起曾 = 锁（`startupInFlight` / `diaryInFlight`）永远不放 = 看门狗每轮直接 return
 * = 当天日记永久写不出来，而且日志里只有「开始写」没有下文。
 * 2026-11-10 R20-A3（审查 S1）：孤儿链现在带强制 TTL（预算 × 1.5，见 orphanExpired），
 * 到期放行重入并留 ⚠️ 日志 —— 底层挂起不再等于永久停摆。
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
 *
 * 2026-11-10 R20-A3（审查 S1）：孤儿链**必须**有独立的强制 TTL。
 * 原来解锁的唯一途径是链自己 settle 的 finally —— 而 `agents.resume` /
 * `presets.resolve/mount` 都没有超时（本文件 :237-240 的注释自己承认过
 * 「一次挂起 = 锁永远不放」），底层连接挂起时锁永不释放，
 * 看门狗从此每轮空转，日记永久停摆且无自愈。现在每条孤儿链带时间戳，
 * 检查点（has 之前）发现超过 ORPHAN_TTL（预算的 1.5 倍）就强制放行并留一条
 * 显眼日志 —— 两个写手的风险由「每日最多两篇 + atomicWrite 原子落盘」兜住，
 * 比「永久停摆」便宜。
 */
const orphanChains = new Map() // key → { wrapper, at }

function markOrphan(key, chain) {
  let wrapper = null
  wrapper = chain.then(() => {}, () => {}).finally(() => {
    const entry = orphanChains.get(key)
    if (entry !== undefined && entry.wrapper === wrapper) {
      orphanChains.delete(key)
      note('diary', `${key}：上一轮超时的那条链已结束，锁已放开`)
    }
  })
  orphanChains.set(key, { wrapper, at: Date.now() })
}

/** 检查点：孤儿链还在，但超过强制 TTL → 放行 + 显眼日志（S1 的自愈路径）。 */
function orphanExpired(key) {
  const entry = orphanChains.get(key)
  if (entry === undefined) return false
  // TTL = 总预算 × 1.5（DIARY_TOTAL_BUDGET_MS 在下面才声明，这里运行时取值没问题）
  const ttl = Math.round(DIARY_TOTAL_BUDGET_MS * 1.5)
  if (Date.now() - entry.at < ttl) return false
  orphanChains.delete(key)
  note('diary', `⚠️ ${key}：超时孤儿链超过 ${Math.round(ttl / 60000)} 分钟仍未结束（底层挂起，没有超时的服务调用卡住了），强制放行重入。若出现两篇日记内容混杂，删掉当天重写即可`)
  return true
}


export async function runDiaryOnce(ctx, dateStr, manualNote, options = {}) {
  const key = String(dateStr ?? '').trim()
  if (key === '') return false
  if (diaryInFlight.has(key)) {
    note('diary', `${key} 的日记正在写（另一条流程在跑），这次重复触发直接跳过`)
    return false
  }
  if (orphanChains.has(key) && !orphanExpired(key)) {
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
  const maxLines = Math.max(5, Math.min(60, Math.trunc(Number(config.excerptMaxLines) || 15)))

  // overwrite=false 且摘录已存在 → 跳过
  if (config.diaryOverwrite === false && exists(diaryExcerptPath(dateStr))) {
    note('diary', `${dateStr} 的摘录已存在（overwrite=false），跳过`)
    return false
  }

  // force：跳过「已经写完了」的判断（手动重写某一天时用）。
  // 2026-11-02 加 —— 那时改了挑对话的逻辑，想重跑昨天看效果，
  // 但看门狗认「文件在且 mtime 过了窗口」就跳过，根本轮不到重写。
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

  // 0.10.0：不再按分数挑素材（core 里那套素材打分已删）。
  //
  // 摘录要的是「这一天发生了什么」的事实，挑与不挑都是把这些事实交给模型，
  // 而打分那套是为「写一篇散文」服务的（生活词加分、代码减分）。
  // 现在只保留一道预算：超过 diaryMaxConversationChars 就从**前面**截断，
  // 保留最近的一段 —— 跟 readRecentChat / 原来的兜底截断同一个方向。
  const inputMax = Number(config.diaryMaxConversationChars) || 8000
  let feedText = conversationText
  if (feedText.length > inputMax) {
    feedText = feedText.slice(-inputMax)
    note('diary', `对话 ${conversationText.length} 字，超过上限 ${inputMax}，保留最近的一段`)
  }

  // 2. 取 agent —— **不是硬依赖**（2026-11-01，审计 C8）。
  //
  // 取不到不等于写不出来：兜底是规则化提取，压根不需要模型。
  // 这里只把原因记清楚，让日志能区分「没绑会话」和「会话不可用」。
  const agent = await diaryAgent(ctx)
  if (agent === undefined || agent === null) {
    note('diary', `${dateStr}：没有可用的绑定会话，这一篇只能走规则化兜底`)
  }

  let summary = feedText.trim() === '' ? '今天没有对话' : feedText
  note('diary', `喂给摘录的对话原文 ${summary.length} 字（上限 ${inputMax}）`)

  // 手动备注（2026-11-04：diaryManualNote 这个开关原来只写在默认值表里没人读，
  // 现在真的接上了 —— 关掉之后手动触发也不接受备注，避免「以为是设置没生效」。）
  if (config.diaryManualNote !== false && manualNote && String(manualNote).trim() !== '') {
    summary += `\n\n备注：${String(manualNote).trim()}`
  }

  // 3. 现实情境已从摘录退出（2026-11-21 / 0.10.2）。
  // 摘录只写当天事实；节日 / 久未聊 / 语气现在只喂「心里话」。见 lib/diary/self.js。

  // 4. 先让她自己写（0.10.0：只有一条消息、一篇文件）
  //
  // 2026-10-31 那版是纯代笔：llm.stream 生成 → atomicWrite。可靠，但摘录里没有
  // 「她决定记这件事」的成分。现在先投消息让她用 soul_diary 写，等文件出现。
  // 触发时机一点没动 —— 还是开机补写 + 看门狗，没有加定时器。
  const useAgent = config.diaryAgentWrite !== false && force !== true
  const timeoutMs = Math.max(10_000, Number(config.diaryAgentTimeoutMs) || 180_000)
  // 2026-11-07 R05 / P1-D2：**问她之前**的时间基线。兜底写盘时用它判断
  // 「她是不是在超时判定之后才落盘的」—— 那种情况不能让兜底覆盖她。
  const askedAt = Date.now()

  let excerptBy = 'fallback'
  if (useAgent) {
    const message = composeExcerptMessage(config, dateStr, summary, {
      recentExcerpts: readRecentExcerpts(dateStr, 3),
      maxLines
    })
    const result = await askAgentToWrite(ctx, agent, message, diaryExcerptPath(dateStr), timeoutMs, { force, since })
    if (result.wrote) {
      excerptBy = 'agent'
      note('diary', `${dateStr} 摘录：她自己写好了${result.asked ? '' : '（文件已在，没有再打扰她）'}`)
    } else {
      note('diary', `${dateStr} 摘录：让她自己写没成（${result.reason}），改用规则化兜底`)
    }
  }

  // 5. 兜底：规则化提取（0.10.0 起**不调模型**）
  //
  // 为什么不再调模型：见 fallback.js 头注释 —— 同一天付两次钱，出来的还是散文，
  // 跟「一行一条」不是同一个形状。现在从 conversations/YYYY-MM-DD.jsonl 里
  // 每行取「role + 首句」，最多 20 条，纯规则、可复现。
  if (excerptBy === 'fallback') {
    const lines = excerptFromConversations(dateStr, { ownerName: config.ownerName })
    // 手动触发时带的备注：投递那条路它已经在 summary 里；兜底这条路没有 prompt，
    // 就把它本身当成一条事实记进摘录 —— 否则用户写了备注、界面回了「已触发」，
    // 备注却哪儿都没有（静默丢失）。
    if (config.diaryManualNote !== false && manualNote && String(manualNote).trim() !== '') {
      lines.push(`备注：${String(manualNote).trim()}`)
    }
    const written = writeExcerptFile(dateStr, lines.join('\n'), { skipIfNewerThan: askedAt, maxLines })
    if (!written) {
      // 2026-11-07 P1-D2：写盘失败或「她刚写过、兜底让路」都走这里。
      // 让路的情形不该记成「写盘失败」，但要如实说没写成 —— 下一轮会重新判定。
      note('diary', `摘录未完成（${dateStr}）：兜底那篇没落盘（写盘失败，或她刚好写好、兜底已让路）`)
      return false
    }
    note('diary', `${dateStr} 摘录：规则化兜底写入（${lines.length} 条，上限 ${maxLines}）`)
  }

  note('diary', `摘录完成（${dateStr}）：${excerptBy === 'agent' ? '她写的' : '规则化兜底'}`)
  return true
}


/**
 * 启动时补写：找最近缺失日，只补那一天。
 */
/**
 * 重写某一天的摘录（2026-11-02 加）。
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
  // 2026-11-21 / 0.10.4：以前这里硬编码 7 天，`diaryBackfillDays` 只在别的路径上生效 ——
  // 设置页改了也没用。现在跟着配置走（夹在 1~7，再大就是翻旧账了）。
  const days = Math.min(7, Math.max(1, Math.trunc(Number(config.diaryBackfillDays) || 7)))
  const missing = findMissingDay(today, days)
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
