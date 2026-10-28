/**
 * registry.js —— 项目登记表 + 本机工作区清单。
 *
 * 为什么要有它（2026-10-28 真问题）：
 *   DSH 的设置页是**全局弹层**，某些版本不往 settings.section 传会话的 cwd ——
 *   于是 PersonaTab 算不出「当前工作目录」，「项目人格」药丸永远是灰的，
 *   用户想给某个目录写人格无从下手。
 *
 * dsh-agent-md 的解法是三条腿，这里照搬：
 *   ① 登记表（projects.json）：见过的工作区记下来，下拉里随时可切；
 *   ② 工作区清单：DSH 的 workspace.json + 会话目录名 + 登记表，三源合并去重；
 *   ③ 任意目录：手填路径或弹系统选择器，登记即切。
 *
 * ⚠️ projects.json 与 dsh-agent-md **共用同一个文件**（agents/projects.json）：
 *   它登记过的工作区这里直接可见，反之亦然。字段结构不能单方面改。
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  agentsDir,
  atomicWrite,
  dshHome,
  displayNameFor,
  ensureDirs,
  exists,
  normalizePathKey,
  readText,
  slugFor,
} from './paths.js'

/** 登记表位置（与 dsh-agent-md 同一个文件）。 */
export function registryPath() {
  return join(agentsDir(), 'projects.json')
}

/** 读登记表（坏文件回退空表：列工作区失败不能拖垮设置页）。 */
export function readRegistry() {
  const raw = readText(registryPath())
  if (raw.trim() === '') return { version: 1, projects: [] }
  try {
    const parsed = JSON.parse(raw)
    if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.projects)) {
      return parsed
    }
  } catch {
    // 解析失败：当作空表（下次写入即修复）
  }
  return { version: 1, projects: [] }
}

/**
 * 登记一个工作区（幂等：同 key 更新 lastSeen）。
 * 只留最近 200 个 —— 登记表是展示用的，不是真相来源（真相在人格文件本身）。
 */
export function registerProject(cwd, patch = {}) {
  const key = normalizePathKey(cwd)
  if (key === '') return readRegistry()
  const registry = readRegistry()
  const { slug, personaPath: path } = slugFor(cwd)
  const now = new Date().toISOString()
  const existing = registry.projects.find((p) => p !== null && typeof p === 'object' && p.key === key)
  if (existing !== undefined) {
    existing.cwd = cwd
    existing.slug = slug
    existing.path = path
    existing.lastSeen = now
    if (typeof patch.active === 'boolean') existing.active = patch.active
  } else {
    registry.projects.push({
      key,
      cwd,
      displayName: displayNameFor(cwd),
      slug,
      path,
      lastSeen: now,
      active: patch.active === true,
    })
  }
  registry.projects.sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')))
  registry.projects = registry.projects.slice(0, 200)
  try {
    // agents/ 目录可能还没建（插件冷启动 / 测试环境）：写盘前先建齐
    ensureDirs()
    atomicWrite(registryPath(), `${JSON.stringify(registry, null, 2)}\n`)
  } catch {
    // 写失败不影响注入
  }
  return registry
}

// ---- 本机所有工作区（DSH workspace 表 + 会话目录 + 插件登记表）-------------

/** DSH 自己维护的工作区表：<DSH_HOME>/storages/workspace.json。 */
export function workspaceStorePath() {
  return join(dshHome(), 'storages', 'workspace.json')
}

/** 会话目录根：<DSH_HOME>/sessions（DSH 给每个工作区一个目录）。 */
export function sessionsRoot() {
  return join(dshHome(), 'sessions')
}

/**
 * DSH 会话目录名 → 工作目录。
 *
 * DSH 把 cwd 编码成目录名：`D:\肥鱼` → `--D-~80A5~9C7C--`。规则是**盘符冒号与
 * 路径分隔符都写成 `-`**，非 ASCII/不安全字符写成 `~XXXX`（UTF-16 码元）。
 * 这是枚举「本机用过哪些工作区」的兜底来源，所以哪怕带点启发式也留着。
 */
export function decodeSessionDirName(name) {
  if (typeof name !== 'string' || name.length < 5) return ''
  if (!name.startsWith('--') || !name.endsWith('--')) return ''
  const body = name.slice(2, -2)
  if (body === '') return ''
  const sep = process.platform === 'win32' ? '\\' : '/'
  let text = ''
  for (let i = 0; i < body.length; i += 1) {
    if (body[i] === '~' && /^[0-9A-Fa-f]{4}$/.test(body.slice(i + 1, i + 5))) {
      text += String.fromCharCode(parseInt(body.slice(i + 1, i + 5), 16))
      i += 4
      continue
    }
    text += body[i] === '-' ? sep : body[i]
  }
  // 盘符的冒号也被写成了 `-`（`D-team` 其实是 `D:\team`），这里补回来
  return text.replace(/^([A-Za-z])[\\/]/, `$1:${sep}`).replace(/[\\/]+$/, '')
}

/** 读 DSH 的工作区表（坏文件回退空表）。 */
export function readWorkspaceStore() {
  const raw = readText(workspaceStorePath())
  if (raw.trim() === '') return []
  try {
    const parsed = JSON.parse(raw)
    const table = parsed !== null && typeof parsed === 'object' && parsed.tables !== undefined
      ? parsed.tables.workspaces
      : undefined
    if (table === null || table === undefined || typeof table !== 'object') return []
    return Object.values(table).filter(
      (w) => w !== null && typeof w === 'object' && typeof w.path === 'string' && w.path.trim() !== ''
    )
  } catch {
    return []
  }
}

/**
 * 本机所有已知工作区（设置页「工作区」下拉的清单）。
 *
 * 三个来源合并去重，按最近活跃倒序：
 *   1. DSH 的工作区表（最权威，带 title / updatedAt）；
 *   2. 插件自己的项目登记表（写过人格的，sources 标 persona）；
 *   3. `~/.dsh/sessions` 目录名（老工作区、没进工作区表的也捞得回来）。
 */
export function listWorkspaces() {
  const map = new Map()
  const ensure = (cwd) => {
    if (typeof cwd !== 'string' || cwd.trim() === '') return null
    const key = normalizePathKey(cwd)
    if (key === '') return null
    let entry = map.get(key)
    if (entry === undefined) {
      entry = { key, cwd, title: '', sources: [], lastActive: '', sessionCount: 0, registered: false }
      map.set(key, entry)
    }
    return entry
  }
  const mark = (entry, source) => {
    if (entry !== null && !entry.sources.includes(source)) entry.sources.push(source)
  }

  for (const w of readWorkspaceStore()) {
    const entry = ensure(w.path)
    if (entry === null) continue
    mark(entry, 'workspace')
    if (typeof w.title === 'string' && w.title !== '') entry.title = w.title
    if (typeof w.updatedAt === 'string' && w.updatedAt > entry.lastActive) entry.lastActive = w.updatedAt
    if (Array.isArray(w.sessionIds)) entry.sessionCount = Math.max(entry.sessionCount, w.sessionIds.length)
  }

  for (const p of readRegistry().projects) {
    const entry = ensure(typeof p.cwd === 'string' ? p.cwd : '')
    if (entry === null) continue
    mark(entry, 'persona')
    entry.registered = true
    if (typeof p.lastSeen === 'string' && p.lastSeen > entry.lastActive) entry.lastActive = p.lastSeen
  }

  let dirs = []
  try {
    dirs = readdirSync(sessionsRoot(), { withFileTypes: true })
  } catch {
    dirs = []
  }
  for (const d of dirs) {
    if (d.isDirectory() !== true) continue
    const cwd = decodeSessionDirName(d.name)
    if (!/^[A-Za-z]:[\\/]/.test(cwd) && !cwd.startsWith('/')) continue
    const entry = ensure(cwd)
    if (entry === null) continue
    mark(entry, 'sessions')
    try {
      const iso = statSync(join(sessionsRoot(), d.name)).mtime.toISOString()
      if (iso > entry.lastActive) entry.lastActive = iso
    } catch {
      // 读不到时间就只按目录名收录
    }
  }

  const out = []
  for (const entry of map.values()) {
    const { slug, personaPath: file } = slugFor(entry.cwd)
    out.push({
      key: entry.key,
      slug,
      cwd: entry.cwd,
      displayName: entry.title !== '' ? entry.title : displayNameFor(entry.cwd),
      sources: entry.sources,
      lastActive: entry.lastActive,
      sessionCount: entry.sessionCount,
      registered: entry.registered,
      path: file,
      exists: exists(file),
    })
  }
  out.sort((a, b) => String(b.lastActive || '').localeCompare(String(a.lastActive || '')))
  return out
}
