/**
 * env.js —— 日志与宿主服务取用（唯一的副作用入口）。
 *
 * 日志为什么必须存在：
 *   这个插件的绝大多数工作都是**静默的** —— 注入了什么、记了什么、压掉了什么，
 *   界面上全看不出来。出问题时如果只在内存里留痕，等于没有线索。
 *   所以统一写一个文件，带体积轮转，超 2MB 就换一份（不删旧的，改名为 .1）。
 */
import { appendFileSync, existsSync, renameSync, statSync } from 'node:fs'
import { agentsDir } from './paths.js'

/** 日志文件：<DSH_HOME>/agents/soul.log */
export const LOG_FILE = () => `${agentsDir()}/soul.log`

const MAX_BYTES = 2 * 1024 * 1024

/** 轮转：超过 2MB 改成 .1（只保留一份，够定位最近的问题）。 */
function rotateIfNeeded(file) {
  try {
    if (!existsSync(file)) return
    if (statSync(file).size < MAX_BYTES) return
    renameSync(file, `${file}.1`)
  } catch {
    /* 轮转失败不该影响主流程 */
  }
}

/**
 * 写一行日志。
 *
 * @param {string} tag 分类（persona / memory / extract / tool / api / purpose）
 * @param {string} message 内容
 */
export function note(tag, message) {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}\n`
  try {
    const file = LOG_FILE()
    rotateIfNeeded(file)
    appendFileSync(file, line, 'utf8')
  } catch {
    /* 日志写不进去也不能让插件崩 */
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
