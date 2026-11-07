/**
 * HTTP 接口 · middleware.js
 * 由 lib/api.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { CONFIG_NAME_RE, CONFIG_STRING_MAX, MAX_BODY } from './constants.js'
import { DEFAULT_CONFIG } from '../store.js'
import { diaryPrivatePath, exists, readText } from '../paths.js'
import { SAFE_LOCAL_NAMES, isSafeLocalName } from '../persona.js'
import { note } from '../env.js'


export function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('请求体太大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8')
        resolve(text === '' ? {} : JSON.parse(text))
      } catch (error) {
        reject(new Error(`JSON 解析失败：${error instanceof Error ? error.message : error}`))
      }
    })
    req.on('error', reject)
  })
}


export const json = (res, code, payload) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}


/**
 * 请求是不是从本机回环地址发来的（2026-10-31）。
 *
 * 为什么单独判一次：私密日记正文默认永不出服务器。开了 diaryPrivateVisible
 * 也只给「这台机器上的自己」看 —— 远程访问（局域网 / 反代）拿到的应当仍是 403。
 * remoteAddress 的三种写法都要认：IPv4 直连、IPv6 回环、IPv4-mapped IPv6。
 */
export function isLoopbackRequest(req) {
  const remote = String(req?.socket?.remoteAddress ?? '')
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
}


/**
 * 是否放行这次接口请求（2026-11-04 修 ⑤，纯函数便于测试）。
 *
 * 原来的权限模型是**反的**：最敏感的私密日记（/diary/private）做了回环校验，
 * 而「改写注入内容的人格」「覆盖笔记」「弹系统文件对话框」这些更危险的动作，
 * 只要请求不带 Origin 就一律放行 —— 本机任何进程（脚本、别的应用、浏览器扩展）
 * 都能直接 POST 过来。
 *
 * 现在统一：只认本机回环。设置页本来就是从 127.0.0.1 访问的，不受影响。
 *
 * 留 `apiLoopbackOnly: false` 这一个逃生口：万一某些宿主的 webServer 走的是
 * 转发/代理、remoteAddress 不是回环地址，用户能改配置自救，而不是被锁在门外
 * 又找不到原因（被拒的请求会打日志，含真实 remoteAddress）。
 */
export function shouldAllowApiRequest(req, config) {
  // 2026-11-06 修 R4：门控下沉。
  //
  // 原来只要 config.apiLoopbackOnly === false 就放行任何来源。HTTP 那条路已经有
  // 「必须 DSH_SOUL_ALLOW_REMOTE_API=1」的拦截，但配置文件是可以被手工编辑、
  // 备份还原、或别的进程写进去的 —— 一份残留的 false 就等于把边界永久关掉。
  // 现在放宽必须同时有启动环境变量，配置值单独不生效。
  if (config !== null && config !== undefined && config.apiLoopbackOnly === false) {
    return process.env.DSH_SOUL_ALLOW_REMOTE_API === '1'
  }
  return isLoopbackRequest(req)
}


/**
 * 校验单个配置值（2026-11-06 修 R6，纯函数便于测试）。
 *
 * 为什么需要它：`/config` 原来只过滤键名，值是原样写进去的。写进一个对象、NaN 或负数，
 * 归一化时要么被吞成 undefined，要么传染整块配置 —— 表现是「提示保存成功、某功能静默失效」。
 *
 * ── 2026-11-06 第二份审查 H-1：数值必须**按语义分组**设上限 ──
 *
 * 上一版这里是「刻意不设上限」，理由写作：`diarySessionBornAt` 是毫秒时间戳（≈1.79e12），
 * 卡一个 1e9 会让绑过日记会话的用户永远存不了设置。
 * 那个理由**只对一个键成立**，却让另外 34 个数值键一起失去上限：
 *
 *   POST /config {"diaryAgentTimeoutMs": 1e12}   → 200，超时变成 31.7 年
 *   （重启后仍在，且与「日记主流程没有总超时」叠加 → 日记功能永久停摆）
 *
 * 现在按语义分组给区间：时间戳类唯一允许大数；超时类收得很窄；天数/预算/分数各自成组。
 * 越界**拒绝**而不是静默夹回 —— 夹回等于悄悄改用户配置，这个项目已经吃过一次
 * 「提示保存成功、实际没生效」的亏。
 */
export const NUMBER_RANGES = Object.freeze({
  // ① 唯一允许大数的：毫秒时间戳（8.64e15 = 可表示的最大日期）
  diarySessionBornAt: [0, 8.64e15],

  // ② 超时（ms）：H-1 的核心。宽一档也够用，但没有上限的代价是永久卡死
  diaryAgentTimeoutMs: [10_000, 600_000],
  diarySummarizeTimeoutMs: [1_000, 120_000],

  // ③ 天 / 分钟 / 小时
  diaryWatchdogMinutes: [1, 1_440],
  diaryBackfillDays: [0, 30],
  memoryRecentDiaryDays: [0, 30],
  recentDays: [0, 365],
  fuzzyAfterDays: [0, 3_650],
  forgetAfterDays: [1, 3_650],
  conversationRetentionDays: [0, 3_650],
  dailyHour: [0, 23],

  // ④ 字符预算
  injectMaxChars: [400, 20_000],
  warnChars: [1_000, 200_000],
  notesInjectMaxChars: [200, 10_000],
  memoryRecentChatChars: [0, 20_000],
  diaryMaxConversationChars: [0, 200_000],
  diaryMaxSummaryChars: [0, 20_000],

  // ⑤ 条数 / 批次
  // 2026-11-08 KNOWN-ISSUES #8：原来夹 [50, 3000]，而 normalizeConfig（config.js）夹 [20, 5000] ——
  // 手改配置文件能绕过 /config 的校验拿到两套口径之外的值。两边统一成 [20, 5000]。
  maxRecords: [20, 5_000],
  maxPerTick: [1, 100],
  memoryRecallTopK: [1, 20],
  diaryPublicMoodMoments: [0, 20],
  diaryPrivateMoodMoments: [0, 20],

  // ⑥ 0~100 的分数
  globalPromoteImportance: [0, 100],
  autoImportanceEvent: [0, 100],
  autoImportanceDefault: [0, 100],
  minOwnerImportance: [0, 100],
  moodBase: [30, 100],
  moodFloor: [0, 100],

  // ⑦ 心情参数
  moodDecayHalfHours: [1, 168],
  moodSigMood: [1, 30],
  moodSigDim: [1, 100],
  moodToneEveryTurns: [2, 50],
  moodToneThreshold: [0, 20],

  // ⑧ 字节
  conversationMaxTotalBytes: [0, 1e10],
  archiveMaxBytes: [0, 1e10]
})

/** 表外的键（以后新增的）用它兜底，并留一行日志提醒补表。 */
const FALLBACK_RANGE = Object.freeze([0, 1e9])
let warnedUnknownRange = false

/**
 * @param {string} key 已通过键白名单的配置名
 * @param {unknown} value 客户端提交的值
 * @returns {{ok: true, value: unknown} | {ok: false, error: string}}
 */
export function validateConfigEntry(key, value) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULT_CONFIG, key)) return { ok: false, error: '未知配置项' }
  const fallback = DEFAULT_CONFIG[key]
  if (value === undefined) return { ok: false, error: '值是 undefined' }

  if (typeof fallback === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value }
    if (value === 'true' || value === '1') return { ok: true, value: true }
    if (value === 'false' || value === '0') return { ok: true, value: false }
    return { ok: false, error: '应为 true/false' }
  }

  if (typeof fallback === 'number') {
    if (typeof value !== 'number') return { ok: false, error: '应为数字' }
    if (!Number.isFinite(value)) return { ok: false, error: '不是有限数字（NaN/Infinity）' }
    if (value < 0) return { ok: false, error: '不能为负数' }
    const range = NUMBER_RANGES[key]
    if (range === undefined) {
      if (!warnedUnknownRange) {
        warnedUnknownRange = true
        note('api', `配置键 ${key} 没有数值区间，暂用兜底 ${FALLBACK_RANGE[0]}~${FALLBACK_RANGE[1]}；请补进 NUMBER_RANGES`)
      }
      if (value < FALLBACK_RANGE[0] || value > FALLBACK_RANGE[1]) {
        return { ok: false, error: `应在 ${FALLBACK_RANGE[0]}~${FALLBACK_RANGE[1]} 之间` }
      }
      return { ok: true, value }
    }
    if (value < range[0] || value > range[1]) {
      return { ok: false, error: `应在 ${range[0]}~${range[1]} 之间` }
    }
    return { ok: true, value }
  }

  if (Array.isArray(fallback)) {
    if (!Array.isArray(value)) return { ok: false, error: '应为字符串数组' }
    if (value.length > 64) return { ok: false, error: '数组元素过多（上限 64）' }
    const out = []
    for (const item of value) {
      if (typeof item !== 'string') return { ok: false, error: '数组元素应为字符串' }
      if (item === '.' || item === '..' || !CONFIG_NAME_RE.test(item)) {
        return { ok: false, error: '数组元素只能是纯文件名（不能带路径分隔符或 ..）' }
      }
      // 2026-11-06 审计 P0-1：localNames 决定「从项目目录读哪个文件」。
      // 只校验成纯文件名根本不够 —— `.env` 也是纯文件名。这里必须再过一道枚举。
      if (key === 'localNames' && !isSafeLocalName(item)) {
        return { ok: false, error: `项目人格文件名只允许 ${SAFE_LOCAL_NAMES.join(' / ')}` }
      }
      out.push(item)
    }
    return { ok: true, value: out }
  }

  if (typeof fallback === 'string') {
    if (typeof value !== 'string') return { ok: false, error: '应为字符串' }
    if (value.length > CONFIG_STRING_MAX) return { ok: false, error: `超过 ${CONFIG_STRING_MAX} 字上限` }
    // 允许换行/制表（语气、人设这类多行文本），其余控制字符一律拒绝。
    // 2026-11-08 KNOWN-ISSUES #12：黑名单补 C1 区（\u0080-\u009F）与 U+2028/2029 ——
    // 后两者是 JS 字符串里的真实换行，能经 /config 进人格文本再进 soul.log。
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(value)) return { ok: false, error: '含控制字符' }
    return { ok: true, value }
  }

  // 默认值为 null 或类型未知：只放行标量，别让对象混进来
  if (value === null) return { ok: true, value: null }
  const t = typeof value
  if (t === 'string' || t === 'number' || t === 'boolean') return { ok: true, value }
  return { ok: false, error: '值类型不支持' }
}


/**
 * 私密日记的访问闸门 + 读取（2026-10-31，纯函数便于测试）。
 *
 * 顺序不能换：先判回环，再判开关，最后才读文件 —— 开关关着时连「文件在不在」
 * 之外的任何内容都不回。鉴权沿用 /api/soul 全局那道 Origin 跨源检查（POST /diary
 * 用的也是它），这里再加一层回环限制，是私密内容的第二道锁。
 *
 * @returns {{ status: number, payload: object }}
 */
export function privateDiaryView(req, config) {
  if (!isLoopbackRequest(req)) {
    return { status: 403, payload: { ok: false, error: '私密日记只允许本机回环请求' } }
  }
  if (config === null || config === undefined || config.diaryPrivateVisible !== true) {
    return { status: 403, payload: { ok: false, error: '私密日记查看未开启（diaryPrivateVisible=false）' } }
  }
  let dateStr = ''
  try {
    dateStr = String(new URL(req?.url ?? '/', 'http://127.0.0.1').searchParams.get('date') ?? '').trim()
  } catch {
    dateStr = ''
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    return { status: 400, payload: { ok: false, error: '缺少或非法的 date 参数（YYYY-MM-DD）' } }
  }
  const file = diaryPrivatePath(dateStr)
  const hasPrivate = exists(file)
  return {
    status: 200,
    payload: { ok: true, date: dateStr, hasPrivate, content: hasPrivate ? readText(file) : '' }
  }
}
