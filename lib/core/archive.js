/**
 * archive.js —— 识别 DSH 里「已归档」的会话，别把收起来的会话列进日记下拉。
 *
 * 为什么需要（2026-11-04）：
 *   DSH 的「归档」只是把会话从侧栏移走，**磁盘目录还在**。
 *   设置页的日记会话下拉有两个来源（见 api.js 的 listDiarySessions）：
 *     ① sessions 服务 —— 理论上只有活着的会话，但服务也可能把归档的列出来；
 *     ② 直接扫 ~/.dsh/sessions/<cwd编码>/ —— 全部会话，**完全不认归档**。
 *   不过滤的话，用户收起来的会话照样出现在下拉里、能被绑成日记会话 ——
 *   她之后每晚都往一个用户以为已经收起来的会话里写日记。
 *
 * ⚠️ 为什么读文件而不是问 DSH：
 *   权威来源是 `ctx.workspaceRegistry.archivedSessionIds`，但 workspaceRegistry
 *   不在本插件的 inject 清单里，`ctx.get('workspaceRegistry')` 会直接抛
 *   "cannot get property X without inject"。所以直接读
 *   `~/.dsh/storages/workspace.json` 的 `global.archivedSessionIds` ——
 *   跟 workspaceRegistry 是同一个数据源，只是绕开了 inject。
 *
 * ⚠️ 为什么复制一份而不是 import 桥接插件：
 *   `dsh-onebot-channel` 是另一个插件，跨插件 import 会随对方装/卸/改版本一起崩。
 *   这段逻辑很短（读一个 JSON 列表），复制过来各自独立最稳。
 *
 * 健壮性：归档是「锦上添花」的功能，任何读取失败都退化成「没有归档」，
 * 绝不能让一个坏掉的 workspace.json 把下拉/绑定拖垮。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from '../paths.js'
import { note } from '../env.js'

/** DSH 自己维护的工作区表（和 registry.js 的 workspaceStorePath() 同一个文件）。 */
const workspaceFile = () => join(dshHome(), 'storages', 'workspace.json')

/** 缓存：列表页一次要判几十个 id，不缓存会反复读盘。 */
const CACHE_MS = 5000
let cache = { at: 0, ids: new Set() }
/** 「读不到」的日志只记一次，否则每次缓存过期就刷一行。 */
let warnedOnce = false
/** 上一次成功读到时的「指纹」。只用来决定要不要写日志。 */
let lastSeen = ''
/** 结构漂移（文件能解析、但没有 archivedSessionIds 这个键）的日志也只记一次。 */
let shapeWarned = false

/** 当前已归档的会话 id 集合（缓存 5 秒）。读不到就返回空集合（等于不过滤）。 */
export function archivedSessionIds() {
  const now = Date.now()
  if (now - cache.at < CACHE_MS) return cache.ids
  try {
    const data = JSON.parse(readFileSync(workspaceFile(), 'utf8'))
    const raw = data?.global?.archivedSessionIds
    // 只认「数组」。取不到就静默当空数组的话，哪天 DSH 把键改名或改成
    // per-workspace 结构，JSON 照样能解析、catch 不触发、日志一声不响，
    // 归档过滤就永久失效了。这种情况和「文件坏了」一样要留痕，但只留一次。
    if (!Array.isArray(raw) && !shapeWarned) {
      shapeWarned = true
      note('archive', 'workspace.json 里没有 global.archivedSessionIds（键变了？），归档过滤暂时失效')
    }
    const ids = Array.isArray(raw) ? raw.filter((id) => typeof id === 'string' && id !== '') : []
    cache = { at: now, ids: new Set(ids) }
    // 只在「集合变了」时记一行，别让缓存过期把日志刷满。
    const seen = ids.slice().sort().join(',')
    if (seen !== lastSeen) {
      lastSeen = seen
      if (ids.length > 0) note('archive', `读到 ${ids.length} 个归档会话`)
    }
  } catch (error) {
    // 文件不存在 / JSON 坏 —— 一律退化成「没有归档」（不过滤，不抛）
    if (!warnedOnce) {
      warnedOnce = true
      note('archive', `读不到归档集合（当作无归档）：${error instanceof Error ? error.message : error}`)
    }
    cache = { at: now, ids: new Set() }
  }
  return cache.ids
}

/** 这个会话是不是已归档。空 id 一律 false（不是「已归档」，是「没有 id」）。 */
export function isArchived(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return false
  return archivedSessionIds().has(id)
}

/** 手动失效缓存（测试用；运行时不调，5 秒自然过期）。 */
export function invalidateArchiveCache() {
  cache = { at: 0, ids: new Set() }
}
