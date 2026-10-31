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
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { note } from './env.js'
// 落库前的硬过滤（2026-10-30）：任务/进度类候选直接丢，阈值按 kind 挑。
// 放在 extract.js 里是因为那边已经有一套「什么算人话」的判据，别再开第二处口径。
import { autoMemoryRejectReason, minImportanceForKind } from './extract.js'
import {
  atomicWrite,
  configPath,
  exists,
  ensureDirs,
  globalMemoryPath,
  memoryDir,
  moodDir,
  moodPath,
  projectMemoryPath,
  readText
} from './paths.js'
import {
  DEFAULTS,
  addRecord,
  applyDecay,
  compactCard,
  createCard,
  daysSince,
  loadCard,
  makeArchiver,
  normalizeCard,
  normalizeConfig,
  normalizeKind,
  renderCard,
  renderRecalledBlock,
  saveCard,
  scoreRecord,
  status
} from './memory.js'
import { applyEmotionToDrives, createState, deriveDrives, mineGoals, normalizeState } from './purpose.js'
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

/**
 * 所有工作区的心情分片（日记用）。
 *
 * 心情是按 cwd 存一份一份的，而**日记没有 cwd** —— 它记的是一整天，不管你在哪个
 * 工作区聊。所以这里不挑一份，把 `mood/` 下所有 json 全读出来交给调用方合并。
 *
 * 读不到 / 单个文件坏了都不抛：日记只是少了情绪底色，不该整篇写不出来。
 */
export function allMoodStates() {
  // 2026-10-31：心情已改成全局单文件（见 paths.js 的 moodPath）。
  // 原来这里把 mood/ 下所有 json 全读出来合并 —— 因为心情按工作区一份一份存，
  // 而日记没有 cwd。现在不再分工作区，继续合并只会把同一份状态重复计入。
  migrateMoodFiles()
  const file = moodPath('')
  if (!exists(file)) return []
  const base = loadConfig().moodBase
  try {
    return [normMoodState(JSON.parse(readText(file)), base)].filter((s) => s !== null && s !== undefined)
  } catch (error) {
    note('mood', `读心情状态失败：${error instanceof Error ? error.message : error}`)
    return []
  }
}

/**
 * 一次性迁移：把旧的「按工作区一份」合并成全局一份（2026-10-31）。
 *
 * 幂等：global.json 存在就什么都不做。挑时间线最多的那份 —— 它记录最全。
 * 旧文件不删，留着可以回溯（真要清理时手动删，不要替用户做不可逆的事）。
 */
export function migrateMoodFiles() {
  try {
    const dir = moodDir()
    if (!exists(dir)) return
    const globalFile = join(dir, 'global.json')
    if (exists(globalFile)) return

    const files = readdirSync(dir).filter((f) => String(f).endsWith('.json'))
    if (files.length === 0) return

    let best = null
    let bestLen = -1
    let bestName = ''
    for (const f of files) {
      try {
        const st = JSON.parse(readText(join(dir, String(f))))
        const len = Array.isArray(st?.timeline) ? st.timeline.length : 0
        if (len > bestLen) { bestLen = len; best = st; bestName = String(f) }
      } catch (error) {
        note('mood', `迁移时跳过读不了的心情文件 ${f}：${error instanceof Error ? error.message : error}`)
      }
    }
    if (best === null) return
    atomicWrite(globalFile, `${JSON.stringify(best, null, 2)}\n`)
    note('mood', `心情已合并为全局单份，沿用记录最完整的「${bestName}」（${bestLen} 条时间线）；旧文件保留未删`)
  } catch (error) {
    note('mood', `心情合并失败：${error instanceof Error ? error.message : error}`)
  }
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
  // 判定完了顺手把情绪推给目的：担心/心疼 → 更惦记你，开心/甜蜜 → 更想说点什么。
  // 放在这里而不是 maintain 里，是因为只有判定过才知道这一轮她是什么情绪。
  pullDrivesByEmotion(s.dims)
  return s
}

/**
 * 情绪牵引目的驱动一次。
 *
 * 心情是按工作区分片的，驱动是全局的 —— 这里不挑分片，谁判定了谁推一把，
 * 最后停在哪个值由「靠拢」自然收敛（见 applyEmotionToDrives）。
 *
 * 失败不影响心情：牵引只是让目的机制有素材，推不动也不该让这一轮的心情白记。
 */
export function pullDrivesByEmotion(dims) {
  try {
    if (loadConfig().purposeEnabled === false) return null
    const state = purposeState()
    const next = applyEmotionToDrives(state.drives, dims)
    state.drives = next
    savePurposeState(state)
    return next
  } catch (error) {
    note('purpose', `情绪牵引失败：${error instanceof Error ? error.message : error}`)
    return null
  }
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
  // 注入预算只留一个默认值来源：memory.js 的 DEFAULTS（2026-10-30 统一，默认 3200）。
  // 这里以前写死 1600、memory.js 写 2400，实际生效 1600 而告警按 2400 算。
  injectMaxChars: DEFAULTS.injectMaxChars,
  /** 注入时按当前用户消息召回相关区（false = 退回整卡渲染，逐字节等价旧行为）。 */
  memoryRecall: DEFAULTS.memoryRecall,
  // 2026-10-31 补：设置页和 index.js 一直在读这个开关，但默认值表里漏了它。
  // 缺默认值时行为仍然「默认开启」（undefined === false 不成立），
  // 但设置页显示不出默认状态，配置项也容易被当成不存在。补上。
  memoryEnabled: true,
  /** 相关区最多召回几条。 */
  memoryRecallTopK: DEFAULTS.memoryRecallTopK,
  projectMemoryEnabled: true,
  /** 跨工作区双写门槛：自动提取的记忆同时满足「关于主人本人」+ 重要度 ≥ 这个值，
   *  就额外往全局卡写一份 —— 换工作区也认得你。调高更严、调低更舍得记。 */
  globalPromoteImportance: 62,
  /** 自动提取时先让模型提炼成「记忆」再入库（关掉就退回原话直存，会变成流水账）。
   *  提炼失败/超时会自动退回原话，不会丢信息。 */
  memoryRefine: true,
  memoryRefineProvider: '',
  memoryRefineModel: '',
  /** 自动记忆的重要度门槛，按 kind 分档（2026-10-30）。
   *  默认值只在 memory.js 的 DEFAULTS 里定义一次，这里引用不复制字面量。
   *  event=70（一次性经历要够格才占位置）/ 其余=42（画像类保持宽口径）。 */
  autoImportanceEvent: DEFAULTS.autoImportanceEvent,
  autoImportanceDefault: DEFAULTS.autoImportanceDefault,
  // 2026-10-31：新会话第一轮带上「最近」—— 最近几天的日记 + 今天到目前为止的流水。
  //
  // 为什么需要：树树不会在一个对话里做完所有事（修插件、QQ、闲聊是分开的会话）。
  // 记忆卡只有零碎事实，日记只写到「昨天」，所以新开一个对话时她不知道
  // 今天早些时候在别的对话里做过什么。这条是补那条通路的。
  // 0 = 关闭对应项。
  memoryRecentDiaryDays: 2,
  memoryRecentChatChars: 3000,
  // 私密日记要不要也进「最近」。默认 false：私密是写给自己的，
  // 不该默认出现在每个新对话的开场里。
  memoryRecentDiaryIncludePrivate: false,
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
  moodJudgeModel: '',
  /** 日记：开机时写前一天的那一篇（公开 + 私密） */
  diaryEnabled: true,
  // 2026-10-31：原来这里是 diarySchedule: '22:00'（每天 22 点触发）。
  // 机器的开机时间不固定——可能几天不开，也可能一直不关——定点闹钟靠不住，
  // 所以改成「第二天写前一天的」：开机写一次，看门狗定时兜底。
  // diarySchedule 仍保留在默认值里，兼容旧配置和旧测试（判定逻辑已不再使用）。
  diarySchedule: '22:00',
  // 看门狗间隔（分钟）：电脑一直不关机时，每隔这么久看一眼昨天写没写。
  // 只是两次文件存在性判断，几乎不花钱；真正烧钱的生成一天最多一次。
  diaryWatchdogMinutes: 30,
  diaryCatchUp: true,
  diaryBackfillDays: 4,
  diaryOverwrite: true,
  diaryManualNote: true,
  diaryPublicTone: '',
  diaryPrivateTone: '',
  // 喂给摘要模型的对话上限。工具密集的一天能攒几十万字，不设上限会把单次调用撑爆。
  // 30000 字对正常的一天足够宽裕，超限才保留最近的部分。
  diaryMaxConversationChars: 30000,
  diaryMaxSummaryChars: 2000,
  // 日记里的情绪底色：给几条「当时你自己的想法」。公开那篇是要拿给人看的，少给几条。
  // 设 0 或关掉心情（moodEnabled=false）就完全不带情绪段。
  diaryPublicMoodMoments: 3,
  diaryPrivateMoodMoments: 6,
  // 投第二条（私密）之前，等公开那篇落盘的最长时间。等不到也照样投，不丢日记。
  diaryPublicWaitMs: 180000,
  diarySummarizeProvider: '',
  diarySummarizeModel: '',
  // 对话流水保留天数。要 >= 补写能追溯的天数（findMissingDay 查 7 天），
  // 否则补写时当天的对话已经被清掉了。
  diaryJsonlKeepDays: 7,
  // 绑定的日记会话（2026-10-31）：只认这个 id，不再自建会话。
  // 空串 = 未绑定，日记触发时跳过并提示去设置页绑定。
  diarySessionId: DEFAULTS.diarySessionId,
  // 私密日记正文是否允许在设置页查看（默认 false = 只报存在性）。
  diaryPrivateVisible: DEFAULTS.diaryPrivateVisible,
  diarySummarizeTimeoutMs: 30000
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
      const steps2 = compactCard(card, cfg, { now: Date.now(), archive })
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
        // 判据不能只看「还开着的」那条：目标被 closeGoal 设上 closedAt 之后，
        // 原来的 `closedAt === null &&` 会让 exists 变 false，下一轮 maintain
        // 又从记忆卡里挖出一条全新的（closedAt: null）—— 表现就是用户点了
        // 「放下」，过十分钟它自己回来了，永远关不掉。
        const exists = state.goals.some((item) => item.text === goal.text)
        if (!exists) state.goals.push({ ...goal, closedAt: null })
      }
      if (state.goals.length !== before) savePurposeState(state)
    }
  }

  // 驱动衰减：每回合都算一次（成本极低），保证「久没说话会想分享」成立
  if (cfg.purposeEnabled !== false) {
    const state = purposeState()
    const hours = state.drivesAt > 0 ? (Date.now() - state.drivesAt) / 3600000 : 0
    // 素材刺激：把最近记下的东西喂进 deriveDrives。
    // 之前这里永远不传 materials，于是 curiosity / mastery 只能靠自然衰减 + 空闲上涨，
    // README 写的「被聊到的内容会推高对应维度」从来没兑现过 —— 属于参数留了口子但没人接。
    const materials = [
      ...globalCard().records,
      ...(String(cwd ?? '').trim() !== '' ? projectCard(cwd).records : [])
    ].slice(-12).map((record) => ({ text: record.text, title: record.title }))
    const derived = deriveDrives({
      drives: state.drives,
      drivesAt: state.drivesAt,
      now: Date.now(),
      idleHours: hours,
      materials
    })
    state.drives = derived.drives
    state.drivesAt = derived.drivesAt
    savePurposeState(state)
  }

  return report
}

/**
 * 把一批**已经成形的记忆**写进卡（自动提取 + 模型提炼之后的落盘口）。
 *
 * 跟 ingestCandidates 的区别：那边收的是「候选原话」（还要现场打分、判是否够格），
 * 这边收的是「提炼过的条目」，重要度由提炼阶段给出（模型判断它值多少分）。
 * tags 仍然交给 addRecord 里的正则去算 —— 写成事实句就自动拿到 fact，
 * 拿到 fact 就有了「永不遗忘」的保护，不用模型去猜标签体系。
 *
 * @returns {{ written: number, promoted: number }}
 */
export function writeAutoMemories(cwd, items, config = {}) {
  const cfg = normalizeConfig(config)
  const list = (Array.isArray(items) ? items : []).filter((item) => String(item?.text ?? '').trim() !== '')
  const report = { written: 0, promoted: 0 }
  if (list.length === 0) return report

  const useProject = String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false
  const target = useProject ? projectCard(cwd) : globalCard()
  // 记下落库后的记录本身：去重命中时 addRecord 返回的是**老记录**，
  // 它的 kind / importance 才是卡里真实的字段（item 那份可能会被后续逻辑改掉）。
  const written = []
  const dropped = []
  for (const item of list) {
    // 2026-10-30 第一道闸（提示词管不住的用规则兜底）：祈使句、代码改动进度、
    // 「对…进行…」、「最近在排查 X / 下一步要 Y」—— 命中整条丢弃。
    // 用户当场在项目卡里抓到的那三条垃圾记忆全是这一类。
    const junk = autoMemoryRejectReason(item.text)
    if (junk !== null) {
      dropped.push(junk)
      continue
    }
    // 第二道闸：kind=event 的自动记忆要 ≥ autoImportanceEvent（默认 70）才配占位置，
    // fact/preference/promise 照旧 autoImportanceDefault（42）。
    // 阈值由 extract.js 的 minImportanceForKind 统一挑选，不在调用方散写。
    const kind = normalizeKind(item.kind)
    const importance = Number.isFinite(Number(item.importance))
      ? Math.min(100, Math.max(0, Math.round(Number(item.importance))))
      : scoreRecord({ text: String(item.text ?? ''), isOwner: true, isPrivate: true }).importance
    if (importance < minImportanceForKind(kind, cfg)) {
      dropped.push(`${kind} 重要度 ${importance} 不够`)
      continue
    }
    const result = addRecord(target, {
      text: item.text,
      isOwner: true,
      isPrivate: true,
      source: item.source ?? 'auto',
      importance: item.importance,
      kind: item.kind
    }, cfg, Date.now())
    if (result?.ok === true) {
      report.written += 1
      written.push(result.record)
    }
  }
  if (report.written > 0) {
    if (useProject) saveProjectCard(cwd, target)
    else saveGlobalCard(target)
  }
  if (dropped.length > 0) {
    // 2026-10-31：原来只记 dropped[0] —— 丢了几条、剩下的是什么都看不到。
    // 现在把前几条原因都带上，至少能回头判断「这个判断对不对」。
    const shown = dropped.slice(0, 3).join('；')
    const more = dropped.length > 3 ? `；…另有 ${dropped.length - 3} 条` : ''
    note('memory', `丢弃 ${dropped.length} 条任务/进度类记忆（宁可少记）：${shown}${more}`)
  }
  report.dropped = dropped.length

  // 跨工作区双写：长期事实无条件进全局卡，其余看重要度。
  // （自动提取原来只按 cwd 选卡，而实际每个对话都有工作区 → 全局卡永远是空的，
  //   「树树是机器人工程大二」这种跟项目无关的事，换个工作区就完全失忆。）
  if (useProject) {
    const threshold = Number(cfg.globalPromoteImportance) || 62
    // 2026-10-30：判据从「内存里的 item.kind」改成「落库后的 record.kind」——
    // 同一件事只留一份真相；而且去重时返回的老记录才是真正要提升的那条。
    const promo = written.filter((record) => record.kind === 'fact' || (Number(record.importance) || 0) >= threshold)
    if (promo.length > 0) {
      const gcard = globalCard()
      for (const record of promo) {
        const result = addRecord(gcard, {
          text: record.text,
          isOwner: true,
          isPrivate: true,
          source: 'auto-promoted',
          importance: record.importance,
          kind: record.kind
        }, cfg, Date.now())
        if (result?.ok === true) report.promoted += 1
      }
      if (report.promoted > 0) saveGlobalCard(gcard)
    }
  }
  return report
}

/** 渲染给提示词的完整块（人格之外的记忆 + 目的）。 */
export function renderMemoryBlock(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  if (cfg.enabled === false) return ''
  const parts = []
  const limit = Math.max(400, Math.trunc(Number(cfg.injectMaxChars) || DEFAULTS.injectMaxChars))
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
  // 引导她主动记：工具注册了不等于她会想到用。
  // 自动提取只能接住「说得够明确、信号够强」的那些，
  // 剩下「这句其实值得留」的判断，只有她自己在对话里才做得出。
  if (parts.length > 0) {
    parts.push('觉得该记住的，可以自己用 soul_memory 记下来；记错了也能删。')
  }
  return parts.join('\n\n')
}

/**
 * 按「当前这句用户消息」注入记忆（2026-10-30，P1）。
 *
 * 结构：固定区（开始 / 永远不会忘的，不裁剪）→ 相关区（按 query 召回 top-k）
 * → 兜底（还有余量就按分区顺序回填）。项目卡和全局卡一起打分、按 text 去重。
 *
 * 两条安全底线：
 *   ① memoryRecall=false 或 query 为空 → 原样调用 renderMemoryBlock，
 *      输出与改动前逐字节一致（旧路径没有第二份实现）。
 *   ② query 只来自 extract.currentUserText（当前用户消息），
 *      绝不拿注入块 / 工具结果 / time-context 拼 —— 那会把上下文自身当检索词，
 *      越召越偏，而且不可复现。
 */
export function renderMemoryBlockRecalled(cwd, config = {}, queryText = '') {
  const cfg = normalizeConfig(config)
  if (cfg.enabled === false) return ''
  const query = String(queryText ?? '').trim()
  if (query === '' || cfg.memoryRecall !== true) return renderMemoryBlock(cwd, cfg)

  const cards = []
  if (String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false) cards.push(projectCard(cwd))
  cards.push(globalCard())
  const block = renderRecalledBlock(cards, { config: cfg, query, now: Date.now() })
  if (block === '') return ''
  // 引导她主动记：跟整卡路径保持同一句提示。
  return `${block}\n\n觉得该记住的，可以自己用 soul_memory 记下来；记错了也能删。`
}

/** 记忆统计（设置页用）。 */
export function memoryStats(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  const global = status(globalCard(), cfg)
  const project = String(cwd ?? '').trim() !== '' ? status(projectCard(cwd), cfg) : null
  return { global, project, config: cfg }
}

export { normalizeCard }
