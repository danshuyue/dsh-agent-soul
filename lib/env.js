/**
 * env.js —— 日志与宿主服务取用（唯一的副作用入口）。
 *
 * 日志为什么必须存在：
 *   这个插件的绝大多数工作都是**静默的** —— 注入了什么、记了什么、压掉了什么，
 *   界面上全看不出来。出问题时如果只在内存里留痕，等于没有线索。
 *   所以统一写一个文件，带体积轮转。
 *
 * 2026-10-31 改轮转：
 *   原来超 2MB 就 rename 成 `soul.log.1` —— 第二次轮转会把旧的 .1 覆盖掉，
 *   再往前的历史彻底断掉，而且 .1 是个哑名字，找不回「前天下午那段」。
 *   现在改成带日期的归档：soul.log.20261031-1423，按名字就能定位时间。
 *   保留最近 KEEP_ARCHIVES 份，更早的删掉（否则磁盘会被无声吃满）。
 */
import { trimMap } from './core/lru.js'
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { agentsDir } from './paths.js'

/** 日志文件：<DSH_HOME>/agents/soul.log */
export const LOG_FILE = () => `${agentsDir()}/soul.log`

const MAX_BYTES = 2 * 1024 * 1024
/** 最多留几份归档。2MB × 5 ≈ 10MB，够定位最近的问题，也不至于吃满磁盘。 */
const KEEP_ARCHIVES = 5

/** 把时间搓成 20261031-1423 这种能按名字排序的形式。 */
function stamp(at = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
}

/**
 * 轮转：超过 2MB 归档成带时间戳的名字，并清理多余归档。
 *
 * 顺带修掉一个静默失败：原来 catch {} 吞掉一切 —— 磁盘满、权限没了、
 * 目录被删，日志全写不进去也一声不响。现在把「轮转/清理失败」这件事本身
 * 尝试记一行到 stderr（不能写文件时，stderr 是最后一根救命稻草）。
 */
/**
 * 日志文件的「准备状态」：目录建过没有、权限补过没有。
 * 2026-11-07 R9 / P2-1：这两件事只与文件有关，与写多少行无关，不该每行都做。
 */
let preparedLogFile = ''
let preparedChmod = false


function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return false
    if (statSync(file).size < MAX_BYTES) return false
    renameSync(file, `${file}.${stamp()}`)
  } catch (error) {
    try {
      process.stderr.write(`[soul] 日志轮转失败：${error instanceof Error ? error.message : error}\n`)
    } catch { /* stderr 也没了就真没办法了 */ }
    return false
  }

  // 清理老归档：只认 soul.log.YYYYMMDD-HHMM 这种名字，按名字倒序留最新的几份。
  try {
    const dir = agentsDir()
    const prefix = 'soul.log.'
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith(prefix) && /^\d{8}-\d{4}$/.test(name.slice(prefix.length)))
      .sort()
    const excess = archives.length - KEEP_ARCHIVES
    for (let i = 0; i < excess; i += 1) {
      try { unlinkSync(`${dir}/${archives[i]}`) } catch { /* 删不掉就算 */ }
    }
  } catch (error) {
    try {
      process.stderr.write(`[soul] 清理旧日志归档失败：${error instanceof Error ? error.message : error}\n`)
    } catch { /* 同上 */ }
  }
  // 轮转成功（旧文件已改名，下一次写入会创建新文件）
  return true
}

/**
 * 日志时间戳用**本地时间**（2026-11-02 改）。
 *
 * 原来用的是 `toISOString()`，也就是 UTC。看着"标准"，实际是害人：
 * 树树翻日志看到 `[2026-11-01T18:34:44Z]`，会说「怎么 18 点就写日记了」——
 * 而那是 UTC 18:34 = 北京 11-02 凌晨 2:34。连糖糖自己都先错判了一次。
 *
 * 排查时对着的本机时钟，所以日志就该写本机时钟。
 * 带 +08:00 偏移，是为了将来换时区/换机器时还能还原成绝对时间。
 */
function stampLocal(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
    + ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
    + `.${p(d.getMilliseconds(), 3)}`
    + `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`
}

/**
 * 写一行**原样**日志（2026-11-04）。
 *
 * 为什么单独开这个口子：每日健康那一行要求格式就是
 *   [health] 记忆 项目=N …
 * 前面不带时间戳。原来的 note() 会强制拼 `[时间] [tag] `，用它写出来就不是那个格式了。
 * 但直接 appendFileSync 又会绕开轮转 —— 所以把「建目录 / 轮转 / 追写 / stderr 兜底」
 * 抽到这里，note() 和健康行共用同一条写盘路。
 *
 * @param {string} line 完整的一行（带不带结尾换行都行）
 * @returns {boolean} 是否真的写进磁盘
 */
export function appendLogLine(line) {
  const text = String(line ?? '')
  if (text.trim() === '') return false
  const body = text.endsWith('\n') ? text : `${text}\n`
  try {
    const file = LOG_FILE()
    // 2026-11-07 R9 / P2-1：这 4 次系统调用原来**每一行都做**。
    //
    //   mkdirSync(dirname)          每行一次
    //   rotateIfNeeded → exists/stat 每行一次
    //   appendFileSync              必要
    //   chmodSync                   每行一次（Windows 上没有 mode，每行抛一次异常再吞掉）
    //
    // soul.log 现在几千行，启动一次就要几千次 mkdir + chmod —— 而这两件事的正确性
    // 只与「文件是否存在 / 这次是不是刚建过」有关，与行数无关。
    // 现在：目录与 chmod 每个文件只做一次（建过就记下来）；轮转检查仍然每行做，
    // 因为它是**正确性**相关的（写之前必须知道要不要换文件）。
    if (preparedLogFile !== file) {
      mkdirSync(dirname(file), { recursive: true })
      preparedLogFile = file
      preparedChmod = false
    }
    // 轮转成功 = 写的是新文件，权限要重新补一次
    if (rotateIfNeeded(file) === true) preparedChmod = false
    // 权限每个文件只补一次（Windows 上 mode 无效，第一次抛就被吞，后面不再白抛）
    if (preparedChmod !== true) {
      try { chmodSync(file, 0o600) } catch { /* Windows 下 mode 无效，由 ACL 兜底 */ }
      preparedChmod = true
    }
    appendFileSync(file, body, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch (error) {
    // 2026-11-07 R9：准备状态是缓存的（目录建过、chmod 过就跳过），所以目录被删、
    // 权限被改之后第一次写会失败。这里**重置并重试一次**，把自愈留在同一次调用里 ——
    // 否则调用方会看到一次莫名其妙的丢日志。
    preparedLogFile = ''
    preparedChmod = false
    try {
      const file = LOG_FILE()
      mkdirSync(dirname(file), { recursive: true })
      preparedLogFile = file
      try { chmodSync(file, 0o600) } catch { /* Windows 下 mode 无效 */ }
      preparedChmod = true
      appendFileSync(file, body, { encoding: 'utf8', mode: 0o600 })
      return true
    } catch {
      /* 重试也失败，走下面的 stderr */
    }
    // 原来这里 catch {} —— 日志写不进去一声不响，等于把唯一的线索来源也静音了。
    // 至少往 stderr 喊一句：日志写失败这件事本身，必须留下痕迹。
    try {
      process.stderr.write(`[soul] 日志写入失败：${error instanceof Error ? error.message : error}\n`)
    } catch { /* stderr 也没了就真没办法了 */ }
    return false
  }
}

/**
 * 写一行日志。
 *
 * @param {string} tag 分类（persona / memory / extract / tool / api / purpose / diary）
 * @param {string} message 内容
 */
export function note(tag, message) {
  // 失败兜底已经在 appendLogLine 里（含 stderr），这里不再重复 catch，
  // 否则同一件事会往 stderr 喊两遍。
  appendLogLine(`[${stampLocal()}] [${tag}] ${message}`)
}

/**
 * 记忆卡落盘失败的进程内计数（2026-11-04，供每日健康行使用）。
 *
 * 为什么放 env.js 而不是 memory.js：memory.js 要往这里计数，而健康行模块
 * 反过来要读 memory.js 的 ownerImportant —— 计数放 memory.js 会和 health.js
 * 形成循环依赖。env.js 是两边都已经依赖的「副作用入口」，放这里没有新增边。
 *
 * 语义：**进程启动以来累计**，由每日健康行写成功后清零（= 每天一个数）。
 * 只增不减，不做分频 —— 它只进日志的工程指标，不进任何提示词。
 */
let cardWriteFailures = 0

export function countCardWriteFailure() {
  cardWriteFailures += 1
}

export function cardWriteFailureCount() {
  return cardWriteFailures
}

export function resetCardWriteFailureCount() {
  cardWriteFailures = 0
}

/**
 * 分频日志（2026-11-04）。
 *
 * ── 为什么需要它 ──
 * 失败日志有两种完全不同的成因：
 *   · 偶发：一次超时、一次格式异常。逐条记正好，能定位。
 *   · 系统性：密钥过期、模型下线、磁盘满、卡被设成只读。这时每次都会失败，
 *     逐条记会把 soul.log 刷成噪音，**真正重要的那行（第一次）反而被埋掉**。
 * 第一版的分频写死在 index.js 的提炼失败上（每小时第 1 次 + 第 5 次）。
 * 后来发现同一个毛病在 refine.js 的两处、还有记忆落盘失败、记忆卡写盘失败上都各写了一遍，
 * 于是抽到这里：一处实现，各处调用，口径一致（也免得哪一处忘了分频）。
 *
 * 规则：同一个 key 在同一个时间窗口（默认 1 小时）内
 *   · 第 1 次 → 记完整原因（第一次最值钱：它带着真实错误）
 *   · 第 againAt 次（默认 5）→ 补一句「这不像偶发」（用 againMessage）
 *   · 其余 → 静默，等到下个窗口
 *
 * 为什么按「小时槽」而不是「距上次超过一小时」：后者在持续失败时会每 59 分钟
 * 就重新打开一次日志，一小时一条，仍然会淹（长跑一整天 = 24 条）；
 * 按整点分槽则是「每个小时最多两条」，好歹有界且好对照时间线。
 *
 * @returns {boolean} 这次有没有真的写日志（测试和调用方可据此判断）
 */
const throttleWindows = new Map()

export function noteThrottled(tag, key, message, { againAt = 5, againMessage = '', windowMs = 3_600_000 } = {}) {
  const now = Date.now()
  const span = Math.max(1, Number(windowMs) || 3_600_000)
  const slot = Math.floor(now / span)
  const id = `${tag}\u0000${key}`

  // 表不能无限涨：key 里带会话 id / 文件名，跑久了会攒。超了整体清空 ——
  // 清空只影响"这一小时算到第几次"，最坏是多记两条日志，不会丢线索。
  trimMap(throttleWindows, 200)

  const state = throttleWindows.get(id)
  if (state === undefined || state.slot !== slot) {
    throttleWindows.set(id, { slot, count: 1 })
    note(tag, message)
    return true
  }

  state.count += 1
  if (state.count === Math.max(2, Math.trunc(Number(againAt) || 5))) {
    note(tag, againMessage !== '' ? againMessage : message)
    return true
  }
  return false
}

/** 清空分频状态（测试用；也让"下一条必定记下来"可控制）。 */
export function __resetNoteThrottleForTest() {
  throttleWindows.clear()
}

/**
 * 取宿主服务。
 *
 * DSH 里两套并存：注册过的服务走 ctx.get(name)，内建服务（tools 等）是 ctx 上的属性。
 * 只试一条会漏 —— 这正是「插件装了但工具不出现」的常见原因之一。
 */
export function serviceOf(ctx, key) {
  if (ctx === undefined || ctx === null) {
    noteThrottled('apply', `service:${key}:no-ctx`, `⚠️ 宿主上下文缺失，服务 ${key} 不可用（相关能力静默缺失）`)
    return undefined
  }
  if (typeof ctx.get === 'function') {
    try {
      const registered = ctx.get(key)
      if (registered !== undefined && registered !== null) return registered
    } catch {
      /* get 抛错就退回属性访问 */
    }
  }
  const fallback = ctx[key]
  if (fallback === undefined || fallback === null) {
    // 2026-11-05 修 P1-10：以前降级是完全无声的，宿主升级后用户只能靠
    // 「功能怎么没了」猜。写一条分频 WARN（每小时最多几条，不刷屏）。
    noteThrottled('apply', `service:${key}:missing`,
      `⚠️ 宿主服务 ${key} 不可用：相关能力静默缺失（宿主升级或 inject 未声明），请查宿主日志`)
  }
  return fallback
}
