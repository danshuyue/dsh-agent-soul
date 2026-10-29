/**
 * store.js —— 记忆卡 / 目的状态 / 心情状态的读写门面（唯一碰盘的地方）。
 *
 * 为什么要有这一层：
 *   记忆卡有三处消费者（注入、工具、设置页 API），每处自己拼路径、自己 load/save，
 *   迟早出现「注入读的是这份、工具写的是另一份」。集中到一处，路径和写盘策略只有一份。
 *
 * 缓存策略：
 *   每张卡在进程内缓存一份，按文件 mtime 判断是否需要重读 ——
 *   因为注入是**每回合**都跑的，每次都 readFile 会让一个回合多几次同步 I/O。
 *   工具/API 写完会主动失效缓存，所以同一进程内的写入立刻可见。
 *
 * 心情状态同款模式，按 cwd 各缓存一份（mood/ 目录下，一份心情跟一份人格走）。
 *   不做 feiyu-mood 历史迁移（2026-10-28 用户明确说记录可以不迁）—— 从空白起步。
 */
import { statSync } from 'node:fs'
import { note } from './env.js'
import {
  atomicWrite,
  configPath,
  exists,
  ensureDirs,
  globalMemoryPath,
  memoryDir,
  moodPath,
  projectMemoryPath,
  readText
} from './paths.js'
import {
  addRecord,
  applyDecay,
  compactCard,
  createCard,
  daysSince,
  loadCard,
  makeArchiver,
  normalizeCard,
  normalizeConfig,
  renderCard,
  saveCard,
  status
} from './memory.js'
import { createState, deriveDrives, mineGoals, normalizeState } from './purpose.js'
import {
  applyDelta,
  blankMoodState,
  decayMood,
  normMoodState,
  normalizeMoodConfig
} from './mood.js'

const cardCache = new Map()
const moodCache = new Map()
let purposeCache = null
/** 配置缓存带 mtime：用户可能直接用编辑器改 persona.json（README 明确说可以），
 *  只在内存里缓存会让外部改动永不生效。跟记忆卡同一套「mtime 失效」模式。 */
let configCache = null

/** 配置文件路径（为了不破坏 dsh-agent-md，用另一个文件名）。 */
export const CONFIG_FILE = () => configPath()

function mtimeOf(file) {
  try {
    return exists(file) ? statSync(file).mtimeMs : 0
  } catch {
    return 0
  }
}

function loadCached(key, file, loader, fallback) {
  const stamp = mtimeOf(file)
  const hit = cardCache.get(key)
  if (hit !== undefined && hit.stamp === stamp) return hit.value
  const value = loader(file) ?? fallback()
  cardCache.set(key, { stamp, value })
  return value
}

/** 全局记忆卡。 */
export function globalCard() {
  return loadCached('global', globalMemoryPath(), loadCard, () => createCard('global'))
}

/** 项目记忆卡（按 cwd 的 slug）。 */
export function projectCard(cwd) {
  const key = `project:${String(cwd ?? '')}`
  const file = projectMemoryPath(cwd)
  return loadCached(key, file, loadCard, () => createCard('project'))
}

/** 这个会话该用的卡集合：全局 + （有 cwd 时）项目。 */
export function cardsFor(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  const out = []
  if (cfg.enabled === false) return out
  out.push({ scope: 'global', card: globalCard() })
  if (String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false) {
    out.push({ scope: 'project', card: projectCard(cwd) })
  }
  return out
}

export function saveGlobalCard(card) {
  saveCard(globalMemoryPath(), card)
  cardCache.delete('global')
  return card
}

export function saveProjectCard(cwd, card) {
  saveCard(projectMemoryPath(cwd), card)
  cardCache.delete(`project:${String(cwd ?? '')}`)
  return card
}

/** 写入一条记忆：按 scope 决定进哪张卡。 */
export function writeMemory({ cwd = '', scope = 'global', input = {}, config = {} }) {
  const cfg = normalizeConfig(config)
  const card = scope === 'project' && String(cwd).trim() !== '' ? projectCard(cwd) : globalCard()
  const result = addRecord(card, input, cfg, Date.now())
  if (result.ok === true) {
    if (scope === 'project' && String(cwd).trim() !== '') saveProjectCard(cwd, card)
    else saveGlobalCard(card)
  }
  return result
}

/** 目的状态文件。 */
export const PURPOSE_FILE = () => `${memoryDir()}/purpose.json`

export function purposeState() {
  const file = PURPOSE_FILE()
  const stamp = mtimeOf(file)
  if (purposeCache !== null && purposeCache.stamp === stamp) return purposeCache.value
  let raw = null
  try {
    const text = readText(file)
    raw = text === '' ? null : JSON.parse(text)
  } catch {
    raw = null
  }
  const value = normalizeState(raw)
  purposeCache = { stamp, value }
  return value
}

export function savePurposeState(state) {
  atomicWrite(PURPOSE_FILE(), `${JSON.stringify(state, null, 2)}\n`)
  purposeCache = null
  return state
}

// --------------------------------------------------------------------------
// 心情状态（按 cwd 的 slug；无 cwd 用 global）
// --------------------------------------------------------------------------

/**
 * 心情状态。跟记忆卡同一套「mtime 缓存」模式：
 * 判断是异步落盘的，设置页又要20 秒轮询，每次都 readFile 会让两条路径互相踩。
 */
export function moodState(cwd) {
  const key = `mood:${String(cwd ?? '')}`
  const file = moodPath(cwd)
  const stamp = mtimeOf(file)
  const hit = moodCache.get(key)
  if (hit !== undefined && hit.stamp === stamp) return hit.value
  let raw = null
  try {
    const text = readText(file)
    raw = text === '' ? null : JSON.parse(text)
  } catch {
    raw = null
  }
  const base = loadConfig().moodBase
  const value = normMoodState(raw, base)
  moodCache.set(key, { stamp, value })
  return value
}

export function saveMoodState(cwd, state) {
  ensureDirs()
  atomicWrite(moodPath(cwd), `${JSON.stringify(state, null, 2)}\n`)
  moodCache.delete(`mood:${String(cwd ?? '')}`)
  return state
}

/** 重置成一份空白心情（设置页的「重置」按钮）。 */
export function resetMood(cwd) {
  return saveMoodState(cwd, blankMoodState(loadConfig().moodBase))
}

/**
 * 应用一次判定结果并落盘。
 * 衰减也在这里顺手做：判定前先让时间把旧情绪磨平一点，别让一周前的吃醋还全额压在底上。
 */
export function applyMoodDelta(cwd, delta, opts = {}) {
  const cfg = normalizeMoodConfig(loadConfig())
  const s = moodState(cwd)
  decayMood(s, cfg.moodBase, Date.now(), cfg.moodDecayHalfHours)
  applyDelta(s, delta, { floor: cfg.moodFloor, minor: opts.minor === true })
  saveMoodState(cwd, s)
  return s
}

/**
 * 只做时间衰减（设置页刷新、手动整理时用）。
 * 平复过半格就写盘；不然设置页看到的心情会停在上次判定那一刻。
 */
export function decayMoodFor(cwd) {
  const cfg = normalizeMoodConfig(loadConfig())
  const s = moodState(cwd)
  const before = s.mood
  const beforeNoted = s.lastNotedMood
  decayMood(s, cfg.moodBase, Date.now(), cfg.moodDecayHalfHours)
  const moved = Math.abs(s.mood - before) >= 0.5 || s.lastNotedMood !== beforeNoted
  if (moved) saveMoodState(cwd, s)
  return s
}

/** 心情统计（设置页用）：值 + 七情 + 时间线条数。 */
export function moodStats(cwd) {
  const s = moodState(cwd)
  return {
    mood: Math.round(s.mood),
    dims: Object.fromEntries(Object.entries(s.dims).map(([k, v]) => [k, Math.round(v)])),
    lastReason: s.lastReason,
    lastConfidence: s.lastConfidence,
    updatedAt: s.updatedAt,
    timelineCount: s.timeline.length
  }
}

/** 插件配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** 人格：stack = 全局 + 项目按小节合并（默认）；exclusive = 有项目就不注入全局 */
  mode: 'stack',
  includeGlobal: true,
  projectPersonaEnabled: true,
  localNames: ['AGENT.md'],
  /** 记忆 */
  injectMaxChars: 1600,
  projectMemoryEnabled: true,
  /** 目的机制 */
  purposeEnabled: true,
  /** 心情（每轮判断一次心情变化；不注入提示词、无挂饰） */
  moodEnabled: true,
  moodBase: 70,
  moodFloor: 0,
  moodDecayHalfHours: 12,
  moodSigMood: 3,
  moodSigDim: 5,
  moodSelfName: '小糖',
  moodOwnerName: '树树',
  moodSelfAliases: '树树',
  moodJudgeProvider: '',
  moodJudgeModel: ''
})

export function loadConfig() {
  const file = CONFIG_FILE()
  const stamp = mtimeOf(file)
  if (configCache !== null && configCache.stamp === stamp) return configCache.value
  let raw = {}
  try {
    const text = readText(file)
    raw = text === '' ? {} : JSON.parse(text)
  } catch {
    raw = {}
  }
  const value = { ...DEFAULT_CONFIG, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
  configCache = { stamp, value }
  return value
}

export function saveConfig(patch) {
  const value = { ...loadConfig(), ...(patch ?? {}) }
  atomicWrite(CONFIG_FILE(), `${JSON.stringify(value, null, 2)}\n`)
  // 写盘后立刻失效缓存：下一轮 loadConfig 会按新 mtime 重读，保证进程内一致
  configCache = { stamp: mtimeOf(CONFIG_FILE()), value }
  return value
}

/** 测试用：丢掉所有缓存。 */
export function resetCaches() {
  cardCache.clear()
  moodCache.clear()
  purposeCache = null
  configCache = null
}

/**
 * 每日维护：衰减 + 压缩 + 遗忘存档。
 *
 * 由注入路径（每回合）和 API 调用，但内部用 lastDecayDate 保证一天只真跑一次。
 * 补跑：DSH 关了一周，回来按「漏了几天」一次推进（最多 30 天），
 * 否则记忆会停在关掉那天，一周的衰减全丢。
 */
export function maintain(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  const archive = makeArchiver(`${memoryDir()}/archive.jsonl`)
  const report = { decayed: [], compacted: [] }

  const targets = [{ scope: 'global', card: globalCard(), save: () => saveGlobalCard(globalCard()) }]
  if (String(cwd ?? '').trim() !== '') {
    targets.push({ scope: 'project', card: projectCard(cwd), save: () => saveProjectCard(cwd, projectCard(cwd)) })
  }

  for (const target of targets) {
    const card = target.card
    const steps = daysSince(card.lastDecayDate)
    const { changed, forgotten } = applyDecay(card, cfg, Date.now(), { steps })
    if (forgotten.length > 0) {
      for (const record of forgotten) archive(record, 'decay')
      note('memory', `${target.scope}：${forgotten.length} 条彻底遗忘（已存档）`)
    }
    if (changed) {
      target.save()
      report.decayed.push(target.scope)
    }
    const st = status(card, cfg)
    if (cfg.autoCompact && st.level === 'full') {
      const steps2 = compactCard(card, cfg, { now: Date.now() })
      if (steps2 > 0) {
        target.save()
        report.compacted.push({ scope: target.scope, steps: steps2 })
        note('memory', `${target.scope}：容量到顶，压缩掉 ${steps2} 条`)
      }
    }
    // 从记忆里补目标（只在目的机制开着时）
    if (cfg.purposeEnabled !== false) {
      const state = purposeState()
      const before = state.goals.length
      for (const goal of mineGoals(card, { limit: 6 })) {
        const exists = state.goals.some((item) => item.closedAt === null && item.text === goal.text)
        if (!exists) state.goals.push({ ...goal, closedAt: null })
      }
      if (state.goals.length !== before) savePurposeState(state)
    }
  }

  // 驱动衰减：每回合都算一次（成本极低），保证「久没说话会想分享」成立
  if (cfg.purposeEnabled !== false) {
    const state = purposeState()
    const hours = state.drivesAt > 0 ? (Date.now() - state.drivesAt) / 3600000 : 0
    const derived = deriveDrives({ drives: state.drives, drivesAt: state.drivesAt, now: Date.now(), idleHours: hours })
    state.drives = derived.drives
    state.drivesAt = derived.drivesAt
    savePurposeState(state)
  }

  return report
}

/** 渲染给提示词的完整块（人格之外的记忆 + 目的）。 */
export function renderMemoryBlock(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  if (cfg.enabled === false) return ''
  const parts = []
  const limit = Math.max(400, Math.trunc(Number(cfg.injectMaxChars) || 1600))
  // 项目卡优先分预算：它更贴近当前任务
  const project = String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false ? projectCard(cwd) : null
  const global = globalCard()
  const projectBudget = project !== null ? Math.floor(limit * 0.6) : 0
  const globalBudget = limit - projectBudget

  if (project !== null) {
    const block = renderCard(project, { config: cfg, maxChars: projectBudget })
    if (block !== '') parts.push(block)
  }
  const globalBlock = renderCard(global, { config: cfg, maxChars: globalBudget })
  if (globalBlock !== '') parts.push(globalBlock)
  return parts.join('\n\n')
}

/** 记忆统计（设置页用）。 */
export function memoryStats(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  const global = status(globalCard(), cfg)
  const project = String(cwd ?? '').trim() !== '' ? status(projectCard(cwd), cfg) : null
  return { global, project, config: cfg }
}

export { normalizeCard }
