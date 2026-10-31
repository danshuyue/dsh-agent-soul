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
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
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
function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_BYTES) return
    renameSync(file, `${file}.${stamp()}`)
  } catch (error) {
    try {
      process.stderr.write(`[soul] 日志轮转失败：${error instanceof Error ? error.message : error}\n`)
    } catch { /* stderr 也没了就真没办法了 */ }
    return
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
}

/**
 * 写一行日志。
 *
 * @param {string} tag 分类（persona / memory / extract / tool / api / purpose / diary）
 * @param {string} message 内容
 */
export function note(tag, message) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`
  try {
    const file = LOG_FILE()
    // 2026-10-31：目录不存在时自己建。原来靠调用方保证，测试环境里
    // 就撞上 ENOENT 了 —— 日志写不进去，等于那段时间完全没有线索。
    mkdirSync(dirname(file), { recursive: true })
    rotateIfNeeded(file)
    appendFileSync(file, line, 'utf8')
  } catch (error) {
    // 原来这里 catch {} —— 日志写不进去一声不响，等于把唯一的线索来源也静音了。
    // 至少往 stderr 喊一句：日志写失败这件事本身，必须留下痕迹。
    try {
      process.stderr.write(`[soul] 日志写入失败（${tag}）：${error instanceof Error ? error.message : error}\n`)
    } catch { /* stderr 也没了就真没办法了 */ }
  }
}

/**
 * 取宿主服务。
 *
 * DSH 里两套并存：注册过的服务走 ctx.get(name)，内建服务（tools 等）是 ctx 上的属性。
 * 只试一条会漏 —— 这正是「插件装了但工具不出现」的常见原因之一。
 */
export function serviceOf(ctx, key) {
  if (ctx === undefined || ctx === null) return undefined
  if (typeof ctx.get === 'function') {
    try {
      const registered = ctx.get(key)
      if (registered !== undefined && registered !== null) return registered
    } catch {
      /* get 抛错就退回属性访问 */
    }
  }
  return ctx[key]
}
