/**
 * notes.js —— 她自己的笔记（2026-11-04）。
 *
 * ── 这跟记忆卡、日记的区别（三者别混）──
 *   记忆卡：一句一条的事实/偏好，会自动衰减到遗忘，靠 importance 排序，每轮按 query 召回。
 *   日记：  插件驱动的每日回顾 —— 开机时收集昨天的对话、调一次 LLM 生成、直接落盘。
 *          她在这条链里是被调用的模型，没有"要不要写"的决定权。
 *   笔记：  **她自己主动写**的自由格式文档。不衰减、不排序、不按天切割，
 *          想建什么主题就建什么主题，内容她组织。这是三者里唯一由她完全做主的。
 *
 * ── 为什么用 md 文件而不是再往记忆卡里加一个字段 ──
 *   记忆卡的每条记录都进了重要性打分和衰减曲线，写进去的东西迟早会被压缩掉。
 *   而"我想把关于树树的观察整理成一篇"这件事，本质上是在写文档，不是记流水。
 *   用 md 还能让人直接用编辑器打开看/改 —— 索引会在下次读到 mtime 变化时自动重建。
 *
 * ── 谁说了算：md 文件是真相，index.json 只是缓存 ──
 *   index.json 里存标题、时间、字数、摘要，是为了注入时不用把 30 篇正文全读一遍。
 *   但它随时可能过期（用户手动改了 md、或者复制了个新文件进来），所以 listNotes()
 *   每次都会调 reconcile() 按目录实际情况校正 —— 文件没了就删条目，mtime 变新就重算摘要。
 *   宁可多 stat 几次（毫秒级），也不要让索引和真相各说一套。
 *
 * ── 安全边界（这是全插件唯一允许模型指定文件名的入口，必须收紧）──
 *   ① 标题清洗：去掉路径分隔符、Windows 非法字符、前后点，防 `../../AGENT.md` 这类穿越；
 *   ② 只写 notesDir() 下面一层，不递归、不许子目录；
 *   ③ Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）会让写盘直接失败，提前拦；
 *   ④ 单篇字数 + 总篇数有上限，防一次糊几万字进来把注入预算撑爆；
 *   ⑤ 删除不真删，挪进 notes/trash/ 带时间戳 —— 她后悔了、你想找回来都还有机会。
 */
import { existsSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { note as log } from './env.js'
import {
  atomicWrite,
  ensureDirs,
  notePath,
  notesDir,
  notesIndexPath,
  notesTrashDir,
  readText
} from './paths.js'

/**
 * 清洗后的 slug → 绝对路径，并**再验一次**它确实在 notes/ 下面。
 *
 * 为什么要验两次：cleanTitle 已经用白名单挡住了 `.` `/` `\`，理论上穿不出去；
 * 但这条链路上游是模型给的字符串，而"理论上有拦"和"物理上证明它在目录内"
 * 是两件事。多一次 resolve 比较的代价是微秒级，换的是「任何一次清洗规则改错
 * 都不会变成任意文件写入」。这类防线要在能加的时候就加，出事再加就晚了。
 *
 * @returns {string|null} 越界返回 null
 */
function safePath(slug) {
  const dir = resolve(notesDir())
  const file = resolve(notePath(slug))
  return file.startsWith(`${dir}${sep}`) ? file : null
}

/** 最多几篇。到顶就拒绝新建，让她先合并或删掉 —— 不静默淘汰，淘汰会让她写过的东西凭空消失。 */
export const MAX_NOTES = 30
/** 单篇正文字数上限。2 万字大约是一篇长文的量，再多就该拆成两篇了。 */
export const MAX_NOTE_CHARS = 20000
/** 标题长度上限。太长会撑爆索引行，也容易踩文件系统限制。 */
export const MAX_TITLE_CHARS = 40
/** 索引里每条摘要的长度：只够认出「这是哪一篇」，正文要看再调工具。 */
const SUMMARY_CHARS = 36

/** Windows 保留设备名：这些名字建文件会直接失败，且报错信息很难懂。 */
const RESERVED = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
])

// --------------------------------------------------------------------------
// 标题 → 文件名
// --------------------------------------------------------------------------

/**
 * 把标题清洗成安全的文件名（不含扩展名）。
 *
 * 返回值里的 slug 同时是文件名和唯一 key —— 不做「标题展示 / 文件名哈希」那套，
 * 因为文件是给人看的：`~/.dsh/agents/notes/关于树树的观察.md` 一眼就知道是什么，
 * 而 `note-a3f9c2.md` 你得打开才知道。代价是改标题等于改文件名（见 renameNote）。
 *
 * @returns {{ ok: true, slug: string } | { ok: false, reason: string }}
 */
export function cleanTitle(title) {
  const raw = String(title ?? '').trim()
  if (raw === '') return { ok: false, reason: '标题不能为空' }

  // 出现路径分隔符或 `..` 一律拒绝，而不是静默清洗掉。
  // 清洗也确实安全（`../../evil` 会变成 `evil`，落不到目录外），但会留下一个
  // 没人能解释的现象：「我明明写的是 ../../evil，怎么多出一篇叫 evil 的」。
  // 正常的标题里不会出现这两种东西，出现只说明一件事 —— 在拼路径，或者被注入牵着走。
  if (/[\\/]/.test(raw) || raw.includes('..')) {
    return { ok: false, reason: '标题里不能有路径分隔符或 ..' }
  }

  // 剩下的非法字符（Windows 不允许出现在文件名里）删掉而不是替换成下划线：
  // 替换会留下 `ab_c` 这种和原标题对不上的名字，删掉更接近原意。
  let slug = raw
    .replace(/[*?"<>|\u0000-\u001f]/g, '')
    .replace(/\.+$/, '')           // 结尾的点：Windows 上会被静默吞掉，和索引对不上
    .replace(/^\.+/, '')           // 开头点：`.` / `..` 是目录引用
    .replace(/\s+/g, ' ')
    .trim()

  if (slug === '') return { ok: false, reason: '标题里没有可用的字符' }
  if (slug.length > MAX_TITLE_CHARS) slug = slug.slice(0, MAX_TITLE_CHARS).trim()
  if (RESERVED.has(slug.toLowerCase())) return { ok: false, reason: `「${slug}」是系统保留名，换一个` }
  // 兜底再校验一次：清洗之后只允许中英文、数字、空格和少数安全符号
  if (!/^[\w\u3400-\u9fff \-—·、，。！？()（）《》【】]+$/u.test(slug)) {
    return { ok: false, reason: '标题里有不支持的符号' }
  }
  return { ok: true, slug }
}

/** 摘要：取正文第一个非空行，去掉 md 标记，截到 SUMMARY_CHARS。 */
export function summaryOf(text) {
  const lines = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^#{1,6}\s*/, '').replace(/[*_`>~-]/g, '').trim())
    .filter((line) => line !== '')
  const first = lines[0] ?? ''
  return first.length > SUMMARY_CHARS ? `${first.slice(0, SUMMARY_CHARS)}…` : first
}

// --------------------------------------------------------------------------
// 索引
// --------------------------------------------------------------------------

function blankIndex() {
  return { version: 1, notes: [] }
}

function normalizeEntry(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const slug = String(raw.slug ?? '').trim()
  if (slug === '') return null
  return {
    slug,
    title: String(raw.title ?? slug).trim() || slug,
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    chars: Math.max(0, Math.trunc(Number(raw.chars) || 0)),
    summary: String(raw.summary ?? '')
  }
}

export function loadIndex() {
  try {
    const text = readText(notesIndexPath())
    if (text.trim() === '') return blankIndex()
    const parsed = JSON.parse(text)
    const list = Array.isArray(parsed?.notes) ? parsed.notes : []
    return { version: 1, notes: list.map(normalizeEntry).filter((entry) => entry !== null) }
  } catch (error) {
    // 索引坏了不该让笔记整个不可用 —— 当成空索引，reconcile 会从目录重建出来。
    log('notes', `索引读取失败，将从目录重建：${error instanceof Error ? error.message : error}`)
    return blankIndex()
  }
}

export function saveIndex(index) {
  ensureDirs()
  atomicWrite(notesIndexPath(), `${JSON.stringify(index, null, 2)}\n`)
  // 写索引 = 缓存一定过期。放在这里而不是散在各个调用方：
  // 以后新增写入路径也不会漏掉失效这一步。
  invalidateCache()
  return index
}

/** 测试用：丢掉 reconcile 缓存（正常流程靠写入失效 + TTL）。 */
export function __resetNotesCacheForTest() {
  invalidateCache()
}

/** 目录里实际的 md 文件名（不含扩展名，已排序）。 */
function scanSlugs() {
  try {
    const dir = notesDir()
    if (!existsSync(dir)) return []
    return readdirSync(dir)
      .filter((name) => String(name).toLowerCase().endsWith('.md'))
      .map((name) => basename(String(name), '.md'))
      .filter((slug) => slug !== '')
  } catch (error) {
    log('notes', `扫目录失败：${error instanceof Error ? error.message : error}`)
    return []
  }
}

function mtimeOf(slug) {
  try {
    const file = safePath(slug)
    return file !== null && existsSync(file) ? statSync(file).mtimeMs : 0
  } catch {
    return 0
  }
}

/**
 * reconcile 的短期缓存（2026-11-04）。
 *
 * 为什么需要：注入路径每轮都走 renderNotesBlock → listNotes → reconcile，
 * 而 reconcile 会把 notes/ 下每个 md 都 stat 一次。30 篇就是 30 次同步 IO，
 * 每轮都付 —— 单次是微秒级，但注入是**每回合必经**的路径，能省就省。
 *
 * 为什么敢缓存：笔记的变化频率是「人写文档」的量级（一天几次），
 * 3 秒的窗口不会让人察觉到旧数据。而真正的写入路径（write/append/rename/delete）
 * 都会主动 invalidateCache，所以「她刚写完，下一轮就能看见」这个承诺不受影响。
 *
 * 不带参数调 reconcile 才用缓存；带参数的调用方要的是对**那份**索引做校正，
 * 不能拿缓存糊弄它。
 */
let reconcileCache = { at: 0, value: null }
const RECONCILE_TTL_MS = 3000

function invalidateCache() {
  reconcileCache = { at: 0, value: null }
}

/**
 * 按目录实际情况校正索引，返回**始终有效的**索引。
 *
 * 三种偏差都要修：
 *   ① 目录里有、索引里没有 → 手动放的 md，补条目；
 *   ② 索引里有、目录里没有 → 文件被删了，去条目；
 *   ③ 文件 mtime 比 updatedAt 新 → 用户手动改过，重算字数和摘要。
 *
 * 只有真的变了才写盘，否则每轮注入都要写一次文件，白白触发磁盘 IO 和 mtime 变化。
 */
export function reconcile(index) {
  if (index === undefined && reconcileCache.value !== null && Date.now() - reconcileCache.at < RECONCILE_TTL_MS) {
    return reconcileCache.value
  }
  const current = index ?? loadIndex()
  const slugs = scanSlugs()
  const seen = new Set()
  const next = []

  for (const slug of slugs) {
    seen.add(slug)
    const known = current.notes.find((entry) => entry.slug === slug)
    const mtime = mtimeOf(slug)
    // mtime 有 1 秒内的抖动，用 >= 而不是 > 才不会漏
    if (known !== undefined && mtime <= Number(known.updatedAt) + 1) {
      next.push(known)
      continue
    }
    let text = ''
    try {
      text = readText(notePath(slug))
    } catch (error) {
      log('notes', `读「${slug}」失败：${error instanceof Error ? error.message : error}`)
      continue
    }
    next.push({
      slug,
      title: known?.title ?? slug,
      createdAt: known?.createdAt || Math.trunc(mtime) || Date.now(),
      updatedAt: Math.trunc(mtime) || Date.now(),
      chars: text.length,
      summary: summaryOf(text)
    })
  }

  const dropped = current.notes.filter((entry) => !seen.has(entry.slug))
  if (dropped.length > 0) log('notes', `索引清理：${dropped.length} 篇文件已不存在（${dropped.map((e) => e.slug).join('、')}）`)

  const changed = dropped.length > 0
    || next.length !== current.notes.length
    || next.some((entry, i) => {
      const old = current.notes[i]
      return old === undefined || old.slug !== entry.slug
        || old.updatedAt !== entry.updatedAt || old.chars !== entry.chars || old.summary !== entry.summary
    })

  const result = { version: 1, notes: next }
  if (changed) saveIndex(result)
  // 只缓存「按目录重建」这条路径的结果；带参数进来的调用方要的是对特定索引的校正
  if (index === undefined) reconcileCache = { at: Date.now(), value: result }
  return result
}

/** 列表：按最后修改时间倒序（最近动过的在前）。 */
export function listNotes() {
  const index = reconcile()
  return [...index.notes].sort((a, b) => b.updatedAt - a.updatedAt)
}

// --------------------------------------------------------------------------
// 读写
// --------------------------------------------------------------------------

/**
 * 读一篇。
 * @returns {{ ok: true, note: object, text: string } | { ok: false, reason: string }}
 */
export function readNote(slug) {
  const cleaned = cleanTitle(slug)
  if (cleaned.ok !== true) return { ok: false, reason: cleaned.reason }
  const key = cleaned.slug
  const file = safePath(key)
  if (file === null) return { ok: false, reason: '标题不合法' }
  if (!existsSync(file)) {
    const all = listNotes().map((entry) => entry.slug)
    const hint = all.length === 0 ? '现在一篇都没有' : `现有的：${all.slice(0, 8).join('、')}`
    return { ok: false, reason: `没有叫「${key}」的笔记（${hint}）` }
  }
  let text = ''
  try {
    text = readText(file)
  } catch (error) {
    return { ok: false, reason: `读不出来：${error instanceof Error ? error.message : String(error)}` }
  }
  const entry = loadIndex().notes.find((item) => item.slug === key)
  return {
    ok: true,
    note: entry ?? { slug: key, title: key, createdAt: mtimeOf(key), updatedAt: mtimeOf(key), chars: text.length, summary: summaryOf(text) },
    text
  }
}

/**
 * 新建或整篇覆盖。
 *
 * @param {{ title: string, content: string, overwrite?: boolean }} input
 * @returns {{ ok: true, slug: string, created: boolean } | { ok: false, reason: string }}
 */
export function writeNote({ title, content, overwrite = false } = {}) {
  // 写入路径一律先失效缓存：她刚写完的那篇必须立刻出现在下一次注入里
  invalidateCache()
  const cleaned = cleanTitle(title)
  if (cleaned.ok !== true) return { ok: false, reason: cleaned.reason }
  const slug = cleaned.slug

  const body = String(content ?? '').trim()
  if (body === '') return { ok: false, reason: '内容不能为空' }
  if (body.length > MAX_NOTE_CHARS) {
    return { ok: false, reason: `太长了（${body.length} 字），单篇上限 ${MAX_NOTE_CHARS} 字，拆成两篇吧` }
  }

  ensureDirs()
  const index = reconcile()
  const known = index.notes.find((entry) => entry.slug === slug)
  const file = safePath(slug)
  if (file === null) return { ok: false, reason: '标题不合法' }
  const existed = existsSync(file)

  // 已存在且没说覆盖 → 明确拒绝，让她决定是覆盖还是追加。
  // 静默覆盖是最坏的选择：她以为是新写一篇，实际把上次那篇清了。
  if (existed && overwrite !== true) {
    return { ok: false, reason: `「${slug}」已经存在。要整篇替换就带 overwrite=true，要续写在后面就用 append` }
  }
  // 新建才查篇数上限；覆盖已有篇不占新名额
  if (!existed && index.notes.length >= MAX_NOTES) {
    return { ok: false, reason: `已经 ${index.notes.length} 篇了（上限 ${MAX_NOTES}），先合并或删掉几篇` }
  }

  try {
    atomicWrite(file, body.endsWith('\n') ? body : `${body}\n`)
  } catch (error) {
    return { ok: false, reason: `写盘失败：${error instanceof Error ? error.message : String(error)}` }
  }

  const now = Date.now()
  const entry = {
    slug,
    title: slug,
    createdAt: known?.createdAt || now,
    updatedAt: now,
    chars: body.length,
    summary: summaryOf(body)
  }
  const notes = index.notes.filter((item) => item.slug !== slug)
  notes.push(entry)
  saveIndex({ version: 1, notes })
  log('notes', `${existed ? '重写' : '新建'}笔记「${slug}」（${body.length} 字）`)
  return { ok: true, slug, created: !existed, entry }
}

/**
 * 往已有的那篇后面续写。
 *
 * 不存在就直接建 —— 她多半是"想到一点补一点"，不该因为第一篇还没建就报错。
 */
export function appendNote({ title, content } = {}) {
  // 写入路径一律先失效缓存：她刚写完的那篇必须立刻出现在下一次注入里
  invalidateCache()
  const cleaned = cleanTitle(title)
  if (cleaned.ok !== true) return { ok: false, reason: cleaned.reason }
  const slug = cleaned.slug
  const add = String(content ?? '').trim()
  if (add === '') return { ok: false, reason: '内容不能为空' }

  ensureDirs()
  const file = safePath(slug)
  if (file === null) return { ok: false, reason: '标题不合法' }
  if (!existsSync(file)) return writeNote({ title: slug, content: add })

  let old = ''
  try {
    old = readText(file).replace(/\s+$/, '')
  } catch (error) {
    return { ok: false, reason: `读原文件失败：${error instanceof Error ? error.message : String(error)}` }
  }
  const merged = `${old}\n\n${add}`
  if (merged.length > MAX_NOTE_CHARS) {
    return { ok: false, reason: `续写后会到 ${merged.length} 字，超过单篇上限 ${MAX_NOTE_CHARS}，另起一篇吧` }
  }
  return writeNote({ title: slug, content: merged, overwrite: true })
}

/**
 * 改标题（= 改文件名）。
 *
 * 为什么单独做一个动作：文件名就是标题，改标题在文件系统上就是 rename。
 * 只改 index 里的 title 而不动文件，会让「索引说是 A、磁盘上是 B」，
 * 下次 reconcile 按目录重建时标题又变回去 —— 那种"改了又反弹"最难查。
 */
export function renameNote(slug, newTitle) {
  // 写入路径一律先失效缓存：她刚写完的那篇必须立刻出现在下一次注入里
  invalidateCache()
  const from = cleanTitle(slug)
  if (from.ok !== true) return { ok: false, reason: from.reason }
  const to = cleanTitle(newTitle)
  if (to.ok !== true) return { ok: false, reason: to.reason }
  if (from.slug === to.slug) return { ok: true, slug: to.slug, renamed: false }

  ensureDirs()
  const src = safePath(from.slug)
  const dst = safePath(to.slug)
  if (src === null || dst === null) return { ok: false, reason: '标题不合法' }
  if (!existsSync(src)) return { ok: false, reason: `没有叫「${from.slug}」的笔记` }
  if (existsSync(dst)) return { ok: false, reason: `「${to.slug}」已经有一篇了，换个名字` }

  try {
    renameSync(src, dst)
  } catch (error) {
    return { ok: false, reason: `改名失败：${error instanceof Error ? error.message : String(error)}` }
  }
  // 2026-11-04：这里原来还有一段「reconcile 之后找到旧条目、改 slug 再 saveIndex」。
  // 那是死代码 —— renameSync 之后目录里已经是新文件名、旧文件名没了，
  // reconcile() 按目录重建索引时不会再看到 from.slug，那段里的 entry 永远是 undefined。
  // 索引正确性完全靠 reconcile 本身，不需要在调用方再补一遍。
  reconcile()
  log('notes', `笔记改标题：「${from.slug}」→「${to.slug}」`)
  return { ok: true, slug: to.slug, renamed: true }
}

/**
 * 删一篇。**不真删** —— 挪进 trash/ 带时间戳。
 *
 * 她写的东西可能过两天又想要；你也可能想看看她到底删了什么。
 * 磁盘上多留几十 KB 的代价，远小于「手滑删错找不回来」。
 */
export function deleteNote(slug) {
  // 写入路径一律先失效缓存：她刚写完的那篇必须立刻出现在下一次注入里
  invalidateCache()
  const cleaned = cleanTitle(slug)
  if (cleaned.ok !== true) return { ok: false, reason: cleaned.reason }
  const key = cleaned.slug
  const file = safePath(key)
  if (file === null) return { ok: false, reason: '标题不合法' }
  if (!existsSync(file)) return { ok: false, reason: `没有叫「${key}」的笔记` }

  ensureDirs()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const target = join(notesTrashDir(), `${stamp}-${key}.md`)
  try {
    renameSync(file, target)
  } catch (error) {
    // rename 跨不了设备时退回「复制 + 删」。正常同盘不会走到这里，但别让它变成"删不掉"。
    try {
      atomicWrite(target, readText(file))
      unlinkSync(file)
    } catch (inner) {
      return { ok: false, reason: `删除失败：${inner instanceof Error ? inner.message : String(inner)}` }
    }
  }
  const index = reconcile()
  saveIndex({ version: 1, notes: index.notes.filter((item) => item.slug !== key) })
  log('notes', `笔记「${key}」已移入回收站：${target}`)
  return { ok: true, slug: key, trashed: target }
}

// --------------------------------------------------------------------------
// 注入
// --------------------------------------------------------------------------

/**
 * 渲染注入用的索引块。
 *
 * 只给索引、不给正文 —— 这是 Inline & Spill：标题 + 摘要 + 字数 inline，
 * 正文留在窗口外，她要写/要改/要看全文时用 soul_note 按需读。
 * 三十篇笔记每篇两千字，全文注入就是六万字，什么预算都撑不住。
 *
 * 空列表返回空串（调用方据此不注入），避免注入一个空标题占位置。
 */
export function renderNotesBlock({ maxChars = 600 } = {}) {
  const notes = listNotes()
  if (notes.length === 0) return ''
  const head = '【你自己的笔记】\n（这些是你自己写下来的，不是别人塞给你的设定。想翻全文、想改、想新写一篇，用 soul_note。）'
  const lines = []
  for (const entry of notes) {
    const line = `- ${entry.title}（${entry.chars} 字）${entry.summary === '' ? '' : `：${entry.summary}`}`
    // 预算不够就停，宁可少列几篇也不要超预算 —— 超了会被上层整个裁掉，反而一篇都看不到
    if ([head, ...lines, line].join('\n').length > maxChars) break
    lines.push(line)
  }
  if (lines.length === 0) return ''
  const more = notes.length > lines.length ? `\n（还有 ${notes.length - lines.length} 篇没列出来，用 soul_note list 看全部）` : ''
  return `${head}\n${lines.join('\n')}${more}`
}
