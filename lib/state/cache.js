/**
 * 状态与持久化编排 · cache.js
 * 由 lib/store.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DEFAULTS } from '../memory.js'
import { atomicWrite, configPath, exists, memoryDir, readText } from '../paths.js'
import { normalizeState } from '../purpose.js'
import { note } from '../env.js'
import { clearAll, invalidate, readThrough, settle } from './file-cache.js'

// 保持公共导出路径不变：cards.js / mood-state.js 仍从 './cache.js' 拿 mtimeOf。
export { mtimeOf } from './file-cache.js'


export const cardCache = new Map()

export const moodCache = new Map()

/** 单值缓存也用 Map，固定 key，好让四类状态共用同一套 readThrough / settle。 */
const SINGLE = 'value'

/** 目的状态缓存。 */
const purposeStore = new Map()

/** 配置缓存带 mtime：用户可能直接用编辑器改 persona.json（README 明确说可以），
 *  只在内存里缓存会让外部改动永不生效。跟记忆卡同一套「mtime 失效」模式。 */
const configStore = new Map()


/** 配置文件路径（为了不破坏 dsh-agent-md，用另一个文件名）。 */
export const CONFIG_FILE = () => configPath()


export function loadCached(key, file, loader, fallback) {
  return readThrough(cardCache, key, file, (f) => loader(f) ?? fallback())
}


/** 目的状态文件。 */
export const PURPOSE_FILE = () => `${memoryDir()}/purpose.json`


export function purposeState() {
  return readThrough(purposeStore, SINGLE, PURPOSE_FILE(), (file) => {
    let raw = null
    try {
      const text = readText(file)
      raw = text === '' ? null : JSON.parse(text)
    } catch {
      raw = null
    }
    return normalizeState(raw)
  })
}


export function savePurposeState(state) {
  // 2026-11-05 DSH 复核收尾：S3 只补了「结果不再被忽略 + 记日志」，清缓存仍无条件
  // 执行 —— 这是「同类 bug 只修了一半」，看起来修过其实更危险。
  // purposeState() 按 mtime 判缓存，缓存一清就强制回盘读；写失败时盘上还是旧内容，
  // 刚写进去的新状态**当场回退**，调用方还拿不到任何失败信号。
  // 现在：成功才清缓存；失败把「新值 + 当前磁盘 mtime」留在缓存里，内存视图不回退，
  // 并返回结构化失败结果。内部调用点（tick / maintain / 情绪牵引）忽略返回值是安全的：
  // 日志已写明「重启会丢失」，且内存不会回退。
  const file = PURPOSE_FILE()
  const written = atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`)
  if (written?.ok !== true) {
    const error = written?.error ?? '未知原因'
    note('purpose', `⚠️ 目的状态写盘失败：${error}（改动保留在内存，重启会丢失，请检查磁盘/权限）`)
    // 写失败：把内存新值与当前磁盘 mtime 绑定，purposeState() 不会回退成旧值。
    settle(purposeStore, SINGLE, file, normalizeState(state) ?? state)
    return { ok: false, error, state }
  }
  // 写成功：失效，下次按新 mtime 重读盘上内容（跨进程改动也能看见）。
  invalidate(purposeStore, SINGLE)
  return { ok: true, state }
}


/** 插件配置。 */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  /** 设置页接口只允许本机回环请求（2026-11-04）。
   *  默认 true：本机任何进程都能 POST 改人格 / 覆盖笔记，这事必须收口。
   *  万一某些宿主的 webServer 走代理、remoteAddress 不是回环，改 false 可自救。 */
  apiLoopbackOnly: true,
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

  // ---- 2026-11-04（B6）：把「只在 memory.js 的 DEFAULTS 里、谁都改不到」的 9 个参数
  // 补进公开配置。之前它们没有默认值条目 → loadConfig() 不返回 → /state 不回传 →
  // 设置页没有控件 → 只能手改 persona.json 才生效，等于「有个旋钮但没装在面板上」。
  //
  // 值一律引用 DEFAULTS，不复制字面量（injectMaxChars 那次 2400/1600 打架就是这么来的）。
  //
  // 但「有默认值」不等于「该给滑块」。这些参数调坏了是静默崩的（maxRecords=5 的表现是
  // 「她什么都不记得了」，没有任何报错），所以设置页上它们只以**档位**形式出现，
  // 不给直接改数字的口子。真正需要单独暴露的只有下面标了「可单列」的三个。
  recentDays: DEFAULTS.recentDays,
  fuzzyAfterDays: DEFAULTS.fuzzyAfterDays,
  forgetAfterDays: DEFAULTS.forgetAfterDays,
  minOwnerImportance: DEFAULTS.minOwnerImportance,
  maxRecords: DEFAULTS.maxRecords,
  /** 可单列：告警字数，调大了只是提醒晚一点，不会破坏数据 */
  warnChars: DEFAULTS.warnChars,
  autoCompact: DEFAULTS.autoCompact,
  /** 可单列：一次维护最多动几条，调小了只是慢 */
  maxPerTick: DEFAULTS.maxPerTick,
  /** 维护时段（小时）。2026-11-04 之前它只被 clamp、从没被读 —— 死配置。
   *  接上之前先保持 0 = 不限制时段，避免「设了却不生效」再来一次。 */
  dailyHour: DEFAULTS.dailyHour,
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
  /** 笔记（2026-11-04）：她自己写的 md，永不衰减。
   *  跟记忆的区别：记忆是一句一条、会淡忘；笔记成篇、她自己组织、一直留着。 */
  notesEnabled: true,
  /** 笔记索引的注入预算。只注入「标题 + 字数 + 摘要」，正文靠 soul_note 按需读，
   *  所以这个值不用大 —— 600 字够列 8~10 篇。 */
  notesInjectMaxChars: 600,
  /** 心情：每轮判断一次心情变化；状态注入为 `soul:mood` 段（order 230），语气另由 moodToneInject 控 */
  moodEnabled: true,
  moodBase: 70,
  moodFloor: 0,
  moodDecayHalfHours: 12,
  moodSigMood: 3,
  moodSigDim: 5,
  moodSelfName: '小糖',
  // ---- 主人是谁（2026-11-04）----
  //
  // 值一律引用 memory.js 的 DEFAULTS，不复制字面量（跟 injectMaxChars 那次
  // 1600/2400 打架是同一个教训）。默认是空串 —— 陌生人装完不会被告知
  // 「你是树树的伴侣」。空串时提示词整句省略，见 mood.js 的 buildJudgeSystem。
  ownerName: DEFAULTS.ownerName,
  ownerGender: DEFAULTS.ownerGender,
  relationship: DEFAULTS.relationship,
  /**
   * 已废弃（2026-11-04）：旧版把主人名字写在 `moodOwnerName` 里。
   * 现在统一到 `ownerName`，这个键**只为两件事保留**：
   *   ① 迁移：loadConfig 发现配置里没有 ownerName、却有它时，把值搬过去并写回；
   *   ② 兼容：外部代码（旧设置页、手写调用）直接传 moodOwnerName 时，
   *      normalizeMoodConfig 仍能认出来。
   * 新代码不要再读它。默认空串 = 没设过。
   */
  moodOwnerName: '',
  // 2026-11-04：别名是「主人平时怎么叫她」，原来误填成 '树树'（跟 moodOwnerName
  // 一样），判定提示词会写成「树树平时会这样叫你：树树」。默认空，空时整句省略。
  moodSelfAliases: '',
  moodJudgeProvider: '',
  moodJudgeModel: '',
  // 心情语气（2026-11-01）：隔几轮往用户消息后挂一行。
  // 中档什么都不发（大多数时候），低/高才发，且每 N 轮才发一次。
  moodToneInject: true,
  moodToneEveryTurns: 7,
  moodToneThreshold: 8,
  /** 日记：开机时写前一天的那一篇（公开 + 私密） */
  diaryEnabled: true,
  // 2026-10-31：原来这里是 diarySchedule: '22:00'（每天 22 点触发）。
  // 机器的开机时间不固定——可能几天不开，也可能一直不关——定点闹钟靠不住，
  // 所以改成「第二天写前一天的」：开机写一次，看门狗定时兜底。
  //
  // 这个键现在**完全停用**：不再触发定时（定时器已删），
  // 也不再参与日记的「一天边界」（2026-10-31 起固定为自然日 00:00~24:00，
  // 见 diary.js 的 diaryDayBoundaries）。留着只为不让旧配置报错。
  diarySchedule: '22:00',
  // 看门狗间隔（分钟）：电脑一直不关机时，每隔这么久看一眼昨天写没写。
  // 只是两次文件存在性判断，几乎不花钱；真正烧钱的生成一天最多一次。
  diaryWatchdogMinutes: 30,
  diaryCatchUp: true,
  diaryBackfillDays: 4,
  diaryOverwrite: true,
  /** 让她自己写日记（2026-11-04）。
   *  true  = 先投消息让她用 soul_diary 写，等文件出现；等不到才由插件兜底生成
   *  false = 老路子，插件直接调模型生成（2026-10-31 那版）
   *  兜底永远在，所以这一项关不关都不会丢日记，只影响「谁来写」。 */
  diaryAgentWrite: true,
  /** 等她写多久（毫秒）。写一篇日记要几十秒，3 分钟够；
   *  设太短会经常掉进兜底，设太长开机后日记会迟到。 */
  diaryAgentTimeoutMs: 180000,
  diaryManualNote: true,
  /**
   * 「昨天想对今天说的话」（2026-11-09 R19 / ⑥）。
   * 写完私密日记后，她可以在正文末尾多写一行（前缀「想对明天说：」），
   * 插件把它单独存下来、当天每个会话首轮带进上下文、设置页日记卡片里能看到。
   * 关掉 = 不产出、不注入、UI 不显示，首轮文本逐字节等价。
   */
  diaryToTodayEnabled: true,
  /** 那句话的字数上限（太长就不是「一句」了）。 */
  diaryToTodayMaxChars: 30,
  /**
   * 现实情境感知（2026-11-09 R19 / ④）。
   * 时段 / 节日 / 久未交互 / 季节，纯规则零模型。
   * 只喂日记素材与目的地一句状态，**不进提示词主干**（否则每轮上下文随时间抖动）。
   */
  situationEnabled: true,
  diaryPublicTone: '',
  diaryPrivateTone: '',
  // 喂给日记模型的对话预算（2026-11-02 改）。
  // 原来 30000 且超了从前面截断 —— 砍掉的正好是早上那半段，而且那 30000 字里
  // 80% 是技术细节。现在改成按分数挑（见 diary-pick.js），8000 字就够写，
  // 生活内容占比从 20% 升到 87%，全天跨度也保住了。
  diaryMaxConversationChars: 8000,
  // 已停用，仅为兼容旧配置保留（2026-11-04 核对：只有废弃的 summarizeConversations
  // 还在读它，日记主流程不做摘要；删了会让老配置报错）。
  diaryMaxSummaryChars: 2000,
  // 日记里的情绪底色：给几条「当时你自己的想法」。公开那篇是要拿给人看的，少给几条。
  // 设 0 或关掉心情（moodEnabled=false）就完全不带情绪段。
  diaryPublicMoodMoments: 3,
  diaryPrivateMoodMoments: 6,
  // 投第二条（私密）之前，等公开那篇落盘的最长时间。
  //
  // 2026-11-04：**这个配置已经删掉**。它存在的理由是当年两条消息并发投递、
  // 需要等公开落盘再投私密。现在投递是串行的（公开等到文件出现才轮到私密），
  // 而且她写、插件兜底两条路都会保证顺序，没有可等的东西了。
  // 留着它只会让人以为「把它调大能解决竞态」——那是个假旋钮。
  diarySummarizeProvider: '',
  diarySummarizeModel: '',
  // 对话流水保留期（2026-11-05 修 P1-5 的另一半，机制见 lib/retention.js）。
  // 默认 0 = 永不自动删除；老配置文件没有这两个键，loadConfig 的
  // {...DEFAULT_CONFIG, ...raw} 会自动补 0，升级后一个文件都不会动。
  // 设了值也要 >= 补写能追溯的天数（findMissingDay 查 7 天，建议 >= 30），
  // 否则补写时那天的对话已经被清掉，那一天就永远补不回来了。
  conversationRetentionDays: 0,
  // 目录总量上限（字节），0 = 不限。超出时从最旧的整天 .jsonl 开始删，今天永不删。
  conversationMaxTotalBytes: 0,
  // 归档档案体积上限（字节），0 = 不启用（默认）。超过时把 archive.jsonl
  // 另存为带时间戳的分片，旧内容完整保留、绝不删除；recallArchived 会连分片一起查。
  // 默认 0 时 rotateArchiveIfNeeded 连 stat 都不做，升级后一个文件都不会动。
  archiveMaxBytes: 0,
  // 绑定的日记会话（2026-10-31）：只认这个 id，不再自建会话。
  // 空串 = 未绑定，日记触发时跳过并提示去设置页绑定。
  diarySessionId: DEFAULTS.diarySessionId,
  // 这次绑定是什么时候开始的（2026-11-04，毫秒时间戳）。0 = 老配置没有这个字段。
  diarySessionBornAt: 0,
  // 私密日记正文是否允许在设置页查看（默认 false = 只报存在性）。
  diaryPrivateVisible: DEFAULTS.diaryPrivateVisible,
  diarySummarizeTimeoutMs: 30000
})


/**
 * 旧配置迁移：把 `moodOwnerName` 搬到 `ownerName`（2026-11-04）。
 *
 * ── 为什么必须有这一步 ──
 * 0.5.2 及以前，主人名字只有一个来源：`moodOwnerName`，默认写死 `'树树'`。
 * 现在默认值改成了空串（陌生人装完不该被告知「你是树树的伴侣」），
 * 但老用户的 persona.json 里**只有旧键**、没有新键 —— 如果什么都不做，
 * 升级之后 prompt 里「关于谁」的整段会静默消失，表现是「她突然不认识我了」。
 *
 * 所以：只要配置里没有 `ownerName` 这个键，就认为它是旧配置，
 *   · 有 `moodOwnerName` 就搬它的值（用户可能自己改过，不该被覆盖）；
 *   · 没有就用旧版的默认值 `'树树'`；
 * 然后把 `ownerName` **写回文件** —— 只迁一次，之后这个键就存在了。
 *
 * 全新安装不会误迁：新版本的 saveConfig 写的是 merge 过 DEFAULT_CONFIG 的完整配置，
 * 里面天然带 `ownerName` 键（哪怕是空串）；而安装后没改过任何设置时，
 * 配置文件压根不存在。两种情况都不会走进来。
 *
 * 写回失败不算错误（可能只是只读），内存里已经用迁移后的值了；
 * 日志只记一次，别把 soul.log 刷满。
 *
 * @returns {string} 迁移后的 ownerName；没迁移返回 null
 */
const LEGACY_OWNER_NAME = '树树'

let ownerMigrateNoted = false


function migrateOwnerName(file, raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  // 已经把新键显式写进配置（哪怕是空串 = 「我就是不设」）→ 尊重它，不迁移
  if (Object.prototype.hasOwnProperty.call(raw, 'ownerName')) return null
  // 没有配置文件 / 文件读不出东西（JSON 坏了）→ 不猜。坏文件写回会把它整份抹掉。
  if (!exists(file) || Object.keys(raw).length === 0) return null

  const legacy = typeof raw.moodOwnerName === 'string' ? raw.moodOwnerName.trim() : ''
  const ownerName = legacy !== '' ? legacy : LEGACY_OWNER_NAME
  const next = { ...raw, ownerName }
  try {
    const written = atomicWrite(file, `${JSON.stringify(next, null, 2)}\n`)
    if (written?.ok !== true) note('config', `⚠️ ownerName 迁移写盘失败（内存已按新值运行）：${written?.error ?? '未知原因'}`)
    if (!ownerMigrateNoted) {
      ownerMigrateNoted = true
      note('config', `已从旧配置迁移 ownerName=${ownerName}（来源：${legacy !== '' ? 'moodOwnerName' : '旧版默认值'}），已写回 persona.json`)
    }
  } catch (error) {
    if (!ownerMigrateNoted) {
      ownerMigrateNoted = true
      note('config', `旧配置迁移 ownerName=${ownerName} 写回失败（本次仍按迁移后的值运行）：${error instanceof Error ? error.message : error}`)
    }
  }
  return ownerName
}


export function loadConfig() {
  return readThrough(configStore, SINGLE, CONFIG_FILE(), (file) => {
    let raw = {}
    try {
      const text = readText(file)
      raw = text === '' ? {} : JSON.parse(text)
    } catch {
      raw = {}
    }
    const migrated = migrateOwnerName(file, raw)
    const value = { ...DEFAULT_CONFIG, ...(raw !== null && typeof raw === 'object' ? raw : {}) }
    if (migrated !== null) value.ownerName = migrated
    return value
  })
}


export function saveConfig(patch) {
  const value = { ...loadConfig(), ...(patch ?? {}) }
  // 2026-11-10 R18-B：废弃键不落盘 —— 它们是兼容占位，不是配置项；照原样写回
  // config.json 会让它们在文件里永远活着，看起来像有效配置。内存里保留
  // （DEFAULT_CONFIG / validateConfigEntry 的口径不变），只是文件里不放。
  //   · diarySchedule：直接剔（代码里没人读）；
  //   · moodOwnerName：**只在 ownerName 已经有值之后**剔 —— migrateOwnerName
  //     读的是文件原文，ownerName 还空着就把源值剔了，老用户的迁移数据会丢。
  const toWrite = { ...value }
  delete toWrite.diarySchedule
  if (String(toWrite.ownerName ?? '') !== '') delete toWrite.moodOwnerName
  const written = atomicWrite(CONFIG_FILE(), `${JSON.stringify(toWrite, null, 2)}\n`)
  if (written?.ok !== true) {
    // 2026-11-05 S3：这一处原来是 P0-4 的同型漏检 —— 写盘失败也回 200「配置已保存」。
    // 现在抛给调用方，handler 的外层 catch 会回 500；缓存清空避免内存里留假配置。
    invalidate(configStore, SINGLE)
    throw new Error(`配置写盘失败：${written?.error ?? '未知原因'}`)
  }
  // 写盘后把已知新值与写后 mtime 绑定，保证进程内一致（不必再读一次盘）
  settle(configStore, SINGLE, CONFIG_FILE(), value)
  return value
}


/** 测试用：丢掉所有缓存。 */
export function resetCaches() {
  clearAll(cardCache)
  clearAll(moodCache)
  clearAll(purposeStore)
  clearAll(configStore)
}
