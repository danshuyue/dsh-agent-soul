/**
 * paths.js —— 所有文件路径的唯一来源（纯 node: 内置模块）。
 *
 * 为什么单独一个文件：
 *   路径散落在各处时，「全局记忆写哪儿」「项目记忆的 slug 怎么算」这类问题
 *   会在插件、测试、设置页三处给出三个答案。集中一处，改规则只改这里。
 *
 * 目录布局（跟 dsh-agent-md 保持兼容，便于从它平滑迁移）：
 *   <DSH_HOME>/AGENT.md                        全局人格（它已经在这写了，直接复用）
 *   <DSH_HOME>/agents/persona.json             本插件配置
 *   <DSH_HOME>/agents/projects/<slug>.md       项目人格（与 agent-md 同路径同规则）
 *   <DSH_HOME>/agents/memory/global.json       全局记忆卡
 *   <DSH_HOME>/agents/memory/projects/<slug>.json  项目记忆卡
 *   <DSH_HOME>/agents/memory/archive.jsonl     遗忘档案（append-only）
 *   <DSH_HOME>/agents/mood/<slug>.json         心情状态（按 cwd 的 slug；无 cwd 用 global）
 *   <DSH_HOME>/agents/notes/<标题>.md          她自己的笔记（自由格式，永不衰减）
 *   <DSH_HOME>/agents/notes/index.json         笔记索引（标题 / 时间 / 摘要）
 *
 * 为什么人格文件沿用它的路径而不是自己另起一套：
 *   他已经写好了 AGENT.md 和项目人格。换插件不该逼他搬家 ——
 *   路径一致意味着装上就能用，卸载也不丢东西。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** DSH 家目录：跟随 DSH_HOME 环境变量，否则 ~/.dsh（跟 DSH 自己的约定一致）。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? resolve(fromEnv) : join(homedir(), '.dsh')
}

export const HOME = () => dshHome()
export const agentsDir = () => join(dshHome(), 'agents')
export const projectsDir = () => join(agentsDir(), 'projects')
export const memoryDir = () => join(agentsDir(), 'memory')
export const memoryProjectsDir = () => join(memoryDir(), 'projects')
export const globalPersonaPath = () => join(dshHome(), 'AGENT.md')
export const globalMemoryPath = () => join(memoryDir(), 'global.json')
export const archivePath = () => join(memoryDir(), 'archive.jsonl')
/**
 * 每日健康一行的「写到哪天了」（2026-11-04）。
 *
 * 为什么不复用 lastDecayDate：那个字段在记忆卡里，属于**她读得到的状态**
 * （记忆卡会被渲染进提示词）；而这个日期纯粹是工程记账，不该有机会被带进上下文。
 * 单独一个小文件，内容只有 {"lastDate":"YYYY-MM-DD"}，坏了最多多写一行。
 */
export const healthStatePath = () => join(memoryDir(), 'health.json')
export const configPath = () => join(agentsDir(), 'persona.json')
export const moodDir = () => join(agentsDir(), 'mood')

// ---- 笔记目录（2026-11-04）----
// ~/.dsh/agents/notes/
//   index.json          索引：标题、文件名、创建/修改时间、字数、摘要
//   <标题>.md           她自己的笔记正文
//   trash/              删掉的笔记（不真删，留个后悔的机会）
//
// 为什么单独开一个目录、而不是塞进 memory/ 或 diary/：
//   记忆卡是会衰减的结构化条目，日记是插件驱动的每日回顾，笔记是**她自己主动写、
//   永不衰减的自由文档**。三者生命周期完全不同，混在一个目录里迟早互相误伤
//   （任何按时间清理的逻辑，一旦扫到笔记目录就全没了）。
//   单独目录还有个好处：她写的东西和你自己的东西物理隔开，清理磁盘时不会误删。
export const notesDir = () => join(agentsDir(), 'notes')
export const notesIndexPath = () => join(notesDir(), 'index.json')
export const notesTrashDir = () => join(notesDir(), 'trash')
/** 单篇笔记的正文路径。slug 由 notes.js 清洗过，这里只拼不校验。 */
export const notePath = (slug) => join(notesDir(), `${slug}.md`)

// ---- 日记目录 ----
// ~/.dsh/agents/diary/
//   conversations/YYYY-MM-DD.jsonl   每天对话流水（自然日文件名，触发时按 22:00 分界裁剪）
//   public/YYYY-MM-DD.md             公开日记
//   private/YYYY-MM-DD.md            私密日记
export const diaryDir = () => join(agentsDir(), 'diary')
export const diaryConversationsDir = () => join(diaryDir(), 'conversations')
export const diaryPublicDir = () => join(diaryDir(), 'public')
export const diaryPrivateDir = () => join(diaryDir(), 'private')

/**
 * 日记日期白名单（2026-11-05 修 P0-2）。
 *
 * 事故：/api/soul/diary/read 把请求里的 date 直接拼进文件名，只判了非空。
 * `date=../private/2026-11-02` 会让「公开日记路径」解析到私密目录，
 * 正文被当 publicContent 返回 —— /diary/private 的 403 形同虚设；
 * `date=../../../AGENT` 能读到人格文件，POST /diary 还能覆盖它。
 *
 * 为什么校验放在这里而不是各个 API 分支：
 *   路径函数是所有调用方（API / 工具 / 日记主流程 / 测试）的唯一入口，
 *   在这里收口，以后新增一个调用点也不会再漏。API 层另补 400 是为了
 *   给出友好错误，而不是把断言当异常处理。
 */
export const DIARY_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
export function isDiaryDateKey(dateKey) {
  return typeof dateKey === 'string' && DIARY_DATE_RE.test(dateKey)
}
function assertDiaryDateKey(dateKey) {
  const key = String(dateKey ?? '')
  if (!DIARY_DATE_RE.test(key)) {
    throw new TypeError(`日记日期必须是 YYYY-MM-DD（收到「${key}」）`)
  }
  return key
}
export function diaryJsonlPath(dateKey) {
  return join(diaryConversationsDir(), `${assertDiaryDateKey(dateKey)}.jsonl`)
}
export function diaryPublicPath(dateStr) {
  return join(diaryPublicDir(), `${assertDiaryDateKey(dateStr)}.md`)
}
export function diaryPrivatePath(dateStr) {
  return join(diaryPrivateDir(), `${assertDiaryDateKey(dateStr)}.md`)
}

/**
 * 「昨天想对今天说的话」（2026-11-09 R19 / ⑥）。
 * 单条、按天覆盖 —— 跨天作废，不做历史列表（累积就会变成「本周金句」，那是人格样本）。
 */
export const diaryToTodayPath = () => join(diaryDir(), 'to-today.json')

/** 节日表（可编辑覆盖内置默认；不存在时用内置的）。 */
export const situationHolidaysPath = () => join(agentsDir(), 'situation.json')

/**
 * 心情状态路径（2026-10-31 改：全局唯一，不再按工作区拆）。
 *
 * 原来按 cwd 的 slug 一个工作区一个文件。实测结果是四个互不相识的人：
 *   work 99.95、diary 89.16、qq 75.18、default 71
 * 同一个人换个目录心情就换一份 —— 可心情是「这个人现在的状态」，
 * 不是「这个文件夹的状态」。记忆和人格都是跨工作区共享的，唯独心情分裂，
 * 会出现「刚在 A 里说累、切到 B 又满血」这种自相矛盾。
 *
 * 所以改成全局一个文件。cwd 参数保留只为兼容既有调用点，不再参与路径。
 * 旧的分工作区文件保留不动（migrateMoodFiles 会把最完整的那份搬过来）。
 */
export function moodPath(_cwd) {
  return join(moodDir(), 'global.json')
}

/** 一次建齐所有目录（幂等）。 */
export function ensureDirs() {
  for (const dir of [agentsDir(), projectsDir(), memoryDir(), memoryProjectsDir(), moodDir(), notesDir(), notesTrashDir(), diaryDir(), diaryConversationsDir(), diaryPublicDir(), diaryPrivateDir()]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 并发创建不算错误 */
    }
  }
}

/**
 * 路径归一：小写 + 正斜杠 + 去尾斜杠 + 去盘符大小写差异。
 * 目的只有一个 —— 同一个工作区在 Windows 上写法很多（D:\a\b、D:/a/b、d:\A\B），
 * 不归一就会产生好几份「同一个项目」的人格和记忆。
 */
export function normalizePathKey(cwd) {
  const raw = String(cwd ?? '').trim()
  if (raw === '') return ''
  return raw.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * 8 位短哈希 —— **必须和 dsh-agent-md 的 hash8 完全一致（FNV-1a）**。
 *
 * 2026-10-28 真事故：这里原来用的是 sha1 前 8 位，看着"也能用"，但算出来的
 * 目录标识跟 dsh-agent-md **对不上**：
 *
 *   D:\DSH workspace\work
 *     dsh-agent-md (FNV-1a) → work-ea826e02   ← 他的人格文件在这
 *     本插件 (sha1)         → work-d8a72c47   ← 找一个不存在的文件
 *
 * 后果不是报错，是**静默认不出来**：设置页显示"项目人格：没有"，
 * 看起来像人格被弄丢了，其实文件好端端躺在原地；再点一下保存，
 * 还会在那个新 slug 下建出一份空人格，从此两份并存、各生效一半。
 *
 * 哈希算法没有"兼容性"可言 —— 换算法等于换一套命名空间。
 * 想改这里的实现，必须同时想清楚已有文件怎么办。
 */
export function shortHash(input) {
  const text = String(input ?? '')
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * cwd → slug。规则与 dsh-agent-md 完全一致（同一目录算出同一个 slug），
 * 这样它已经建好的项目人格文件能直接被本插件认领。
 */
export function slugFor(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return { key: '', slug: 'global', fileName: 'global.md', personaPath: join(projectsDir(), 'global.md') }
  const tail = key.replace(/\/+$/, '').split('/').filter((part) => part !== '').pop() || 'root'
  // 只保留 ASCII 字母数字、汉字、连字符、下划线、点；其余一律换成 '-'
  const safe = tail.replace(/[^0-9a-zA-Z\u4e00-\u9fa5._-]/g, '-').slice(0, 40) || 'root'
  const slug = `${safe}-${shortHash(key)}`
  return { key, slug, fileName: `${slug}.md`, personaPath: join(projectsDir(), `${slug}.md`) }
}

/** 项目记忆卡路径（跟人格同 slug，便于对照排查）。 */
export function projectMemoryPath(cwd) {
  return join(memoryProjectsDir(), `${slugFor(cwd).slug}.json`)
}

/** 显示的目录名（设置页用）。 */
export function displayNameFor(cwd) {
  const key = normalizePathKey(cwd)
  if (key === '') return '（全局）'
  const tail = key.split('/').filter((part) => part !== '').pop() || key
  return tail
}

/**
 * 原子写：先写 .tmp 再 rename。
 *
 * 为什么不能直接 writeFileSync：
 *   记忆卡是每回合都可能被写的文件。DSH 被杀进程 / 断电时，
 *   半截 JSON 会让下次启动读到坏文件 —— 那一刻丢的是**全部记忆**，不是一条。
 *   rename 在同一分区上是原子的，最坏情况是丢掉最后一次写入，不会读到半个文件。
 */
/**
 * 原子写：先写临时文件，再 rename 覆盖。
 *
 * 2026-11-04 修 B10：返回 `{ ok, error }`，让「写失败」这件事能被看见。
 * 2026-11-05 修 S3 / P1-6：
 *   · tmp 名加 randomUUID —— 原来 `${file}.tmp-${pid}` 是固定值，同进程里两次
 *     并发写会互相踩，崩溃残留也容易被误当成有效临时文件。
 *   · rename 失败不再退化 `copyFileSync` 覆盖。那条路看着「保住了内容」，实际
 *     是先在目标文件上原地覆盖写，读的人可能读到半截 JSON —— 正好把原子写
 *     想防的事又请回来了。现在直接失败并交回原因，让上层能重试 / 报错。
 *   · 临时文件统一 0o600（Linux/macOS 生效；Windows 的 mode 参数无效，
 *     由 ACL 兜底，见报告 P1-5 修订）。
 *
 * 契约：`writeFileSync` 那步仍然抛（保持旧调用方的兼容行为），
 * rename 失败返回 `{ ok: false }`。**所有调用方都必须检查返回值**——
 * B10 那句「它们忽略返回值也不会变」是 P0-4 漏网的根源，已作废。
 *
 * @returns {{ ok: boolean, error?: string }}
 */
let atomicWriteFailureHook = null

/** 仅供测试注入写盘故障；传 null 关闭。不要在生产代码里用。 */
export function __setAtomicWriteFailureForTest(hook) {
  atomicWriteFailureHook = typeof hook === 'function' ? hook : null
}

export function atomicWrite(file, text) {
  if (atomicWriteFailureHook !== null) {
    const injected = atomicWriteFailureHook(file, text)
    if (injected !== null && injected !== undefined && injected.ok === false) return injected
  }
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`
  try {
    writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 })
    // 已存在的 tmp（极少见）不会因上面的 mode 改权限，补一次 chmod。
    try { chmodSync(tmp, 0o600) } catch { /* Windows 下不支持，忽略 */ }
  } catch (error) {
    try { unlinkSync(tmp) } catch { /* 清不掉也不能盖住真正的原因 */ }
    throw error
  }
  try {
    renameSync(tmp, file)
    return { ok: true }
  } catch (renameError) {
    try { unlinkSync(tmp) } catch { /* 同上 */ }
    const first = renameError instanceof Error ? renameError.message : String(renameError)
    return { ok: false, error: `rename 失败（${first}）；已放弃非原子的 copyFileSync 退化覆盖` }
  }
}

/** 读文本文件，不存在或读不了返回空串。 */
export function readText(file) {
  try {
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** 是否存在。 */
export function exists(file) {
  try {
    return existsSync(file)
  } catch {
    return false
  }
}
