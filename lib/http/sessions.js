/**
 * HTTP 接口 · sessions.js
 * 由 lib/api.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { EMPTY_SESSION_TITLE, titleForSession } from '../session-title.js'
import { archivedSessionIds } from '../core/archive.js'
import { decodeSessionDirName, listWorkspaces, sessionsRoot } from '../core/registry.js'
import { dshHome, normalizePathKey } from '../paths.js'
import { getFallbackCwd } from '../tool.js'
import { join } from 'node:path'
import { note, serviceOf } from '../env.js'
import { readdirSync, statSync } from 'node:fs'


/**
 * 会话服务里最近更新的会话 id（拿不到返回空串）。
 *
 * 2026-10-31：这台 DSH 的设置页 renderSlot('settings.section') 只传 { close }，
 * 前端拿不到当前会话 id。点「把当前会话指定为日记会话」时请求里就没 id，
 * 这里按 updatedAt 取「最近动过的那个」当当前会话 —— 只用于【手动绑定这一步】；
 * 投递侧只认配置里的 id，绝不回退到这里。
 */
export function currentSessionIdOf(ctx) {
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return ''
  try {
    const list = sessions.list()
    if (!Array.isArray(list)) return ''
    let best = null
    for (const session of list) {
      const id = String(session?.header?.id ?? session?.id ?? '')
      if (id === '') continue
      const stamp = String(session?.header?.updatedAt ?? session?.header?.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
      if (best === null || stamp > best.stamp) best = { id, stamp }
    }
    return best === null ? '' : best.id
  } catch {
    return ''
  }
}


/**
 * 日记设置页的会话候选（2026-11-04）。
 *
 * 主来源是 sessions 服务（只含活着的会话，但标题最准）；拿不到或一条都没有时，
 * 扫 sessionsRoot() 兜底 —— 至少让下拉里有 id 可选。任何一步失败都只记日志，
 * 绝不把异常抛给路由（接口约定：失败也返回 200 + 空数组）。
 *
 * 2026-11-04：两个来源都要滤掉归档会话。扫盘只认目录、完全不认归档；sessions
 * 服务也可能把归档的列出来。归档集合读不到时 archivedSessionIds() 返回空集合
 * （等于不过滤）并记一行日志，绝不因此让下拉变成空的。
 *
 * 2026-11-04（第二次改）：标题不再直接信 header —— 会话标题落在日志的
 * `session/title` 事件里（header.title 常常是 id 或空）。优先级改为：
 *   sessionTitle 服务 → 日志里的标题（见 lib/session-title.js）→ header.title
 *   → （空会话，没有消息）
 * 读日志有磁盘 IO，只对最终入选的 ≤50 条做；每条单独 try/catch，一条坏日志
 * 只丢它自己的标题，不拖垮整个列表。
 *
 * @returns {Array<{id:string,title:string,cwd:string,updatedAt:string}>}
 */
export function listDiarySessions(ctx) {
  const byId = new Map()
  // 只取一次，两个来源共用；取不到时是空集合，put 里的判断自然全部放行
  const archived = archivedSessionIds()

  const put = (raw) => {
    const id = String(raw?.id ?? '').trim()
    if (id === '') return
    // 归档会话不进下拉（用户收起来的，不该被绑成日记会话）
    if (archived.has(id)) return
    const title = String(raw?.title ?? '').trim()
    const headerTitle = String(raw?.headerTitle ?? '').trim()
    const cwd = String(raw?.cwd ?? '')
    const updatedAt = String(raw?.updatedAt ?? '')
    const old = byId.get(id)
    if (old === undefined) {
      byId.set(id, { id, title, headerTitle, cwd, updatedAt })
      return
    }
    // 同一个会话可能来自多个来源：标题留非空的，cwd 留非空的，时间留新的
    if (old.title === '' && title !== '') old.title = title
    if (old.headerTitle === '' && headerTitle !== '') old.headerTitle = headerTitle
    if (old.cwd === '' && cwd !== '') old.cwd = cwd
    if (updatedAt > old.updatedAt) old.updatedAt = updatedAt
  }

  try {
    const sessions = serviceOf(ctx, 'sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.list === 'function') {
      // 标题在 sessionTitle 服务里；它不一定会出现在 inject 里，每次访问都兜住
      let titleSvc
      try {
        titleSvc = serviceOf(ctx, 'sessionTitle')
      } catch (error) {
        note('api', `日记会话列表：sessionTitle 不可用（${error instanceof Error ? error.message : error}）`)
        titleSvc = undefined
      }
      for (const session of sessions.list() ?? []) {
        const header = session?.header ?? {}
        const id = String(header.id ?? session?.id ?? '').trim()
        if (id === '') continue
        let title = ''
        if (titleSvc !== undefined && titleSvc !== null && typeof titleSvc.get === 'function') {
          try {
            const folded = titleSvc.get(session)
            if (typeof folded === 'string') title = folded
          } catch (error) {
            note('api', `日记会话列表：读标题失败 ${id}（${error instanceof Error ? error.message : error}）`)
          }
        }
        put({
          id,
          title,
          headerTitle: String(session?.displayTitle ?? header.displayTitle ?? session?.title ?? header.title ?? ''),
          cwd: String(header.cwd ?? session?.cwd ?? ''),
          updatedAt: String(header.updatedAt ?? header.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
        })
      }
    } else {
      note('api', '日记会话列表：sessions 服务不可用，改用扫盘兜底')
    }
  } catch (error) {
    note('api', `日记会话列表：sessions.list 失败（${error instanceof Error ? error.message : error}）`)
  }

  // 服务挂了 / 一个活会话都没有时扫盘。只扫两层：<sessions>/<编码后的 cwd>/<会话 id>/
  if (byId.size === 0) {
    let cwdDirs = []
    try {
      cwdDirs = readdirSync(sessionsRoot(), { withFileTypes: true })
    } catch (error) {
      note('api', `日记会话列表：扫盘失败 ${sessionsRoot()}（${error instanceof Error ? error.message : error}）`)
    }
    for (const cwdDir of cwdDirs) {
      if (cwdDir.isDirectory() !== true) continue
      const cwd = decodeSessionDirName(cwdDir.name)
      let sessionDirs = []
      try {
        sessionDirs = readdirSync(join(sessionsRoot(), cwdDir.name), { withFileTypes: true })
      } catch (error) {
        note('api', `日记会话列表：跳过 ${cwdDir.name}（${error instanceof Error ? error.message : error}）`)
        continue
      }
      for (const sessionDir of sessionDirs) {
        if (sessionDir.isDirectory() !== true) continue
        let updatedAt = ''
        try {
          updatedAt = statSync(join(sessionsRoot(), cwdDir.name, sessionDir.name)).mtime.toISOString()
        } catch {
          /* 读不到时间就留空 */
        }
        put({ id: sessionDir.name, title: '', cwd, updatedAt })
      }
    }
  }

  const picked = [...byId.values()]
    .sort((a, b) => {
      const ta = Date.parse(a.updatedAt)
      const tb = Date.parse(b.updatedAt)
      const va = Number.isFinite(ta) ? ta : 0
      const vb = Number.isFinite(tb) ? tb : 0
      if (va !== vb) return vb - va
      return a.id.localeCompare(b.id)
    })
    .slice(0, 50)

  // 只有这里开始读磁盘，而且只读最终入选的这 ≤50 条。
  // 每条独立 try/catch：一条日志坏掉只丢它自己的标题，列表照常返回。
  for (const item of picked) {
    if (item.title === '') {
      try {
        const fromLog = titleForSession(item.id)
        if (typeof fromLog === 'string' && fromLog !== '') item.title = fromLog
      } catch (error) {
        note('api', `日记会话列表：读日志标题失败 ${item.id}（${error instanceof Error ? error.message : error}）`)
      }
    }
    if (item.title === '') item.title = item.headerTitle
    if (item.title === '') item.title = EMPTY_SESSION_TITLE
    // headerTitle 只是中间产物，不往外带
    delete item.headerTitle
  }

  return picked
}


/**
 * 日记本用了几天（绑定当天算第 1 天；绑定时间缺失时返回 0，页面据此不显示）。
 * 按 24 小时向上取整：用了 1 小时算 1 天，满 15×24 小时显示 15 天。
 */
export function diarySessionDays(bornAt, now = Date.now()) {
  const born = Number(bornAt)
  if (!Number.isFinite(born) || born <= 0) return 0
  const elapsed = Math.max(0, Number(now) - born)
  return Math.max(1, Math.ceil(elapsed / (24 * 60 * 60 * 1000)))
}


/**
 * 会话服务里「最近活跃的那个会话」的工作目录（拿不到返回空串）。
 *
 * 设置页弹层是全局的，某些 DSH 版本不给 settings.section 传 sessionId，
 * 于是「当前工作目录」解析成空、面板直接死路。这里退一步：从会话服务里挑一个
 * 最近活跃且有 cwd 的会话兜底（页面会标明这是兜底值）。
 */
function recentSessionOf(ctx) {
  const sessions = serviceOf(ctx, 'sessions')
  if (sessions === undefined || sessions === null || typeof sessions.list !== 'function') return ''
  try {
    const list = sessions.list()
    if (!Array.isArray(list)) return ''
    let best = null
    for (const session of list) {
      const cwd = session?.header?.cwd
      if (typeof cwd !== 'string' || cwd === '') continue
      const stamp = String(session?.header?.updatedAt ?? session?.header?.createdAt ?? session?.updatedAt ?? session?.createdAt ?? '')
      if (best === null || stamp > best.stamp) best = { stamp, cwd }
    }
    return best === null ? '' : best.cwd
  } catch {
    return ''
  }
}


/**
 * 2026-11-06 审计 P0-1：`?cwd=` 是**用户输入**，进磁盘读之前必须先验证。
 *
 * 原来 resolveCwd 对 direct 只做 `.trim()` 就返回，于是它被直接送进
 * `composePersona → localPersonaPath → readText`：`GET /state?cwd=X`
 * 就是一次「去 X 目录读人格文件」。配合可写的 localNames，能把任意目录下
 * 任意纯文件名文件的前 400 字读回来（已实测）。
 *
 * 这里只做「这个字符串像不像一个真实存在的目录」——不猜意图，只挡垃圾：
 *   · 必须是绝对路径（盘符 / UNC / 正斜杠根）
 *   · 不含控制字符、长度正常
 *   · 真的存在，而且**是目录**（`statSync().isDirectory()`）
 * 通过之后才允许往下走。
 */
export function normalizeCwdParam(raw) {
  const text = String(raw ?? '').trim()
  if (text === '' || text.length > 4096) return null
  if (/[\u0000-\u001f\u007f]/.test(text)) return null
  const absolute = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith('\\\\') || text.startsWith('/')
  if (!absolute) return null
  try {
    if (!statSync(text).isDirectory()) return null
  } catch {
    return null
  }
  return text
}

/**
 * R01 / P0-1 收口：`?cwd=` 是**用户输入**，「是个真实存在的目录」还不够，
 * 还得证明它属于这台机器上用户当前的工作区上下文。否则
 * `GET /state?cwd=<任意存在目录>` 依然能把那个目录下 AGENT.md 的前 400 字读回来
 * —— 文件名枚举已经收窄，目录本身却没限制。
 *
 * 三条判据满足任一即放行（R2-a）：
 *   ① 命中已登记工作区（listWorkspaces() + normalizePathKey 比较）
 *   ② 位于 DSH_HOME 之内（前缀 + 路径分隔符边界；父目录 / 相似前缀都不算）
 *   ③ 等于宿主给的 recentSessionOf(ctx) 或 getFallbackCwd()（**不是用户给的**）
 *
 * R2-b：listWorkspaces 抛异常不能把所有 cwd 判死 —— 退回条件 ②③ 并留一行日志。
 * 03 答复 §2.1：**不做任何形式的自动登记**，未登记目录一律 rejected-unowned。
 */
function isOwnedCwd(cwd, ctx) {
  const key = normalizePathKey(cwd)
  if (key === '') return false

  let workspaces = []
  try {
    workspaces = listWorkspaces()
  } catch (error) {
    note('api', `工作区清单读取失败，归属判定改用 DSH_HOME / 宿主会话（${error instanceof Error ? error.message : String(error)}）`)
  }
  if (Array.isArray(workspaces) && workspaces.some((item) => normalizePathKey(item?.cwd) === key)) return true

  const home = normalizePathKey(dshHome())
  if (home !== '' && (key === home || key.startsWith(`${home}/`))) return true

  // 条件 ③ 单独判，不能拿它当「兜底」把 ①② 绕过去；这里只认宿主给的值。
  const hostGiven = [recentSessionOf(ctx), getFallbackCwd()]
  if (hostGiven.some((given) => typeof given === 'string' && given !== '' && normalizePathKey(given) === key)) return true
  return false
}

/**
 * 接口取 cwd 的唯一入口：三级兜底。
 *
 * 2026-10-29 真事故：这套兜底原来**只写在 /state 里**，其它路由各自
 * `query.get('cwd') ?? ''` 就直接用。于是设置页拿不到会话 cwd 时：
 *
 *   概览 /state → 兜底到最近活跃会话 → 心情 80
 *   详情 /mood  → 拿到空串 → 落到 mood/global.json → 文件不存在 → 空白 70、七情全 0
 *
 * 同一个页面左边 80 右边 70，而且右边还显示「还没聊出变化」——
 * 看起来像心情功能整个坏了，其实是读了两份不同的文件。
 * 更糟的是 /mood/reset：用空 cwd 会把心情重置到一个从没用过的作用域上，
 * 页面还看不见自己刚才重置的那份。
 *
 * 三级的顺序不能改：页面手选 > 最近活跃会话 > 最近一次注入记下的。
 * 2026-11-06 起，页面手选那条要先过 normalizeCwdParam；不合格标 `rejected`，
 * 调用方据此不再读那个目录（也必须据此不回退到别的目录 —— 用户明确指过的地方
 * 读不了就是读不了，悄悄换一个目录读反而更危险）。
 */
export function resolveCwd(ctx, query) {
  const direct = String(query?.get?.('cwd') ?? '').trim()
  if (direct !== '') {
    const safe = normalizeCwdParam(direct)
    if (safe !== null) {
      // 2026-11-06 R01：真实目录 ≠ 有资格读。归属不明就当「没有项目上下文」，
      // 不回退到别的目录（R2-d）—— 悄悄换一个目录读比读不到更危险。
      if (isOwnedCwd(safe, ctx) !== true) return { cwd: '', source: 'rejected-unowned' }
      return { cwd: safe, source: 'path' }
    }
    return { cwd: '', source: 'rejected' }
  }
  const recent = recentSessionOf(ctx)
  if (recent !== '') return { cwd: recent, source: 'recent' }
  const fallback = getFallbackCwd()
  // 标 fallback 而不是 recent：这两条来源不同（一个是会话服务里捞的，一个是注入时记下的），
  // 排查「设置页到底认了哪个目录」时混在一起会看不出走的哪条
  if (fallback !== '') return { cwd: fallback, source: 'fallback' }
  return { cwd: '', source: 'none' }
}
