/**
 * session-title.js —— 从落盘的会话日志里抠标题（日记会话下拉用）。
 *
 * 为什么需要它（2026-11-04）：
 *   日记设置页的下拉原来只有 id。会话标题**不在 header 里**，而是日志里的
 *   `session/title` 事件（data.title，取最后一条）。header 里能拿到的
 *   displayTitle 往往就是 id 或空 —— 所以必须去读日志。
 *
 * ⚠️ 多帧（问题库 Q14，踩过的坑）：
 *   DSH 的会话日志是**追加写**的，`session.v4.jsonl.zstd` 由多段独立 zstd 帧
 *   首尾相接组成。只解第一帧只能看到会话最开头那点内容，后面追加的标题事件
 *   全在尾巴上 —— 所以这里按 zstd magic（28 B5 2F FD）切帧，逐帧解。
 *   末尾可能是正在写的半帧，解压失败直接跳过。
 *
 * 标题来源优先级（跟参考实现 dsh-onebot-channel/lib/title.js 同口径）：
 *   最后一条 session/title → 首条 user/message 的正文（截到第一个标点或 24 字）
 *   → `（空会话，没有消息）`。
 *
 * 结果按 (size, mtime) 缓存：标题没变就不重复解压。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { note } from './env.js'
import { trimMap } from './core/lru.js'
import { decodeSessionDirName, sessionsRoot } from './core/registry.js'

/** 空壳会话（一行消息都没有）的占位文案；前端靠它加灰字标记。 */
export const EMPTY_SESSION_TITLE = '（空会话，没有消息）'

/** 超过这个大小的日志不读 —— 解析成本会失控，宁可回退到 header。 */
const TITLE_MAX_BYTES = 16 * 1024 * 1024

/** file -> { key, title }；key 是 size:mtime，变了才重读。 */
const TITLE_CACHE = new Map()

/** sessionId -> { key, meta }；readSessionMeta 与 readTitleFromLog 同一套 (size,mtime) 缓存。2026-11-08 KNOWN-ISSUES #7。 */
const META_CACHE = new Map()

/** sessionId -> { file, at }；命中后确认文件还在就复用，省掉重复扫目录。 */
const PATH_CACHE = new Map()
const PATH_CACHE_MS = 60 * 1000

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * 把多帧 zstd 拼成的 buffer 拆成行。
 *
 * 为什么不用 zstdDecompressSync 一次解完：Node 只解第一帧就停，后面的帧
 * 会被静默丢掉 —— 标题事件恰好在最后几帧里。
 */
export function decodeZstdFrames(buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i)
    }
  }
  const lines = []
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i]
    const to = i + 1 < starts.length ? starts[i + 1] : buf.length
    try {
      const text = zstdDecompressSync(buf.subarray(from, to)).toString('utf8')
      for (const line of text.split('\n')) if (line !== '') lines.push(line)
    } catch {
      // 末尾可能是正在写的半帧，跳过就行
    }
  }
  return lines
}

/** 从一条 user/message 事件里抽第一段纯文本。 */
function firstTextOf(messageEvent) {
  const blocks = messageEvent?.data?.content
  if (Array.isArray(blocks) !== true) return ''
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      return block.text
    }
  }
  return ''
}

/**
 * 读一个会话日志文件的标题。
 *
 * 永不抛：文件不存在 / 太大 / 解压失败都返回 ''（或占位文案），
 * 由调用方决定回退 —— 日记下拉不能因为一条坏日志整体挂掉。
 */
export function readTitleFromLog(file) {
  let stat
  try {
    stat = statSync(file)
  } catch {
    return ''
  }
  if (!stat.isFile() || stat.size > TITLE_MAX_BYTES) return ''
  const key = `${stat.size}:${Math.round(stat.mtimeMs)}`
  const cached = TITLE_CACHE.get(file)
  if (cached !== undefined && cached.key === key) return cached.title

  let title = ''
  try {
    const lines = decodeZstdFrames(readFileSync(file))
    let firstMessage = ''
    for (const line of lines) {
      // 取最后一条标题事件（后面的覆盖前面的）
      if (line.includes('"session/title"')) {
        try {
          const event = JSON.parse(line)
          if (event?.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
        } catch {}
        continue
      }
      if (firstMessage === '' && line.includes('"user/message"')) {
        try {
          const event = JSON.parse(line)
          if (event?.type === 'user/message') firstMessage = firstTextOf(event)
        } catch {}
      }
    }
    if (title === '' && firstMessage !== '') {
      // 首条消息可能很长，截到第一个标点或 24 个字
      title = firstMessage.split(/[。！？!?\n]/)[0].slice(0, 24)
    }
    // 一行消息都没有的空壳会话（早期自动建会话的遗留），明说一句，别让人以为坏了
    if (title === '') title = EMPTY_SESSION_TITLE
  } catch (error) {
    note('api', `读会话标题失败 ${file}: ${error instanceof Error ? error.message : error}`)
  }

  title = String(title).trim()
  // 2026-11-08 KNOWN-ISSUES #31：这两个表原来是全仓库唯一没有上限的缓存。
  trimMap(TITLE_CACHE, 200)
  TITLE_CACHE.set(file, { key, title })
  return title
}

/**
 * 扫 sessionsRoot() 找某个 sessionId 的日志文件。
 *
 * DSH 的落盘结构是 <sessions>/<编码后的 cwd>/<sessionId>/session.v4.jsonl.zstd。
 * 编码后的 cwd 目录名用 registry.decodeSessionDirName 校验一下（能解出真实 cwd
 * 的才算正常目录），但**不拿 cwd 当过滤条件** —— 没 cwd 的会话落在 `_no-cwd`
 * 里，它们也可能是合法的日记会话，解不出 cwd 不该等于找不到。
 *
 * @returns {string} 日志文件绝对路径；找不到返回 ''
 */
export function findSessionLog(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id === '') return ''
  // id 只允许是单层目录名，别让 '..' 之类的值指到别处
  if (id.includes('/') || id.includes('\\') || id === '.' || id === '..') return ''

  const cached = PATH_CACHE.get(id)
  if (cached !== undefined && Date.now() - cached.at < PATH_CACHE_MS && existsSync(cached.file)) return cached.file

  const root = sessionsRoot()
  let cwdDirs
  try {
    cwdDirs = readdirSync(root, { withFileTypes: true })
  } catch (error) {
    note('api', `扫会话目录失败 ${root}: ${error instanceof Error ? error.message : error}`)
    return ''
  }
  for (const cwdDir of cwdDirs) {
    if (cwdDir.isDirectory() !== true) continue
    // 只做一次「目录名像不像 DSH 编码过的 cwd」的体检，用于日志；不过滤
    void decodeSessionDirName(cwdDir.name)
    const file = join(root, cwdDir.name, id, 'session.v4.jsonl.zstd')
    if (existsSync(file)) {
      trimMap(PATH_CACHE, 200)
      PATH_CACHE.set(id, { file, at: Date.now() })
      return file
    }
  }
  return ''
}

/**
 * 按 sessionId 取标题（日记会话下拉用）。
 *
 * @returns {string} 标题；会话文件都找不到时返回 ''
 */
/**
 * 读会话日志**第一行**的会话头（`{"type":"session",...}`）。
 *
 * 为什么需要（2026-11-05 线上事故）：
 *   `sessions.get(id)` 只对**活着的**会话返回值；会话休眠时它返回空。
 *   于是 `header.agentPreset` 读不到，冷启动就没挂 preset ——
 *   没有 preset 就没有模型，装配时报
 *   `prompt variable "{{model}}" has no value (section "deployment:persona-prefix")`，
 *   而且每轮都报。
 *
 *   但 preset 其实一直存在落盘日志的第一行里：
 *   `{"type":"session","id":"...","cwd":"...","agentPreset":"standard"}`
 *
 * @returns {{ id: string, agentPreset: string, cwd: string, createdAt: number } | null}
 */
export function readSessionMeta(sessionId) {
  const id = String(sessionId ?? '').trim()
  if (id === '' || id.includes('/') || id.includes('\\')) return null
  const file = findSessionLog(id)
  if (file === null || file === '') return null
  try {
    // 2026-11-08 KNOWN-ISSUES #7：原来每次调用都全量解压（上限 16MB 的）日志，
    // 而同文件的 readTitleFromLog 有 (size, mtime) 缓存 —— 现在对齐同一套口径。
    // 会话头在文件头几行，落盘后基本不变；日志还在追加时 key 变了自然失效。
    const stat = statSync(file)
    const key = `${stat.size}:${Math.round(stat.mtimeMs)}`
    const cached = META_CACHE.get(id)
    if (cached !== undefined && cached.key === key) return cached.meta
    for (const line of decodeZstdFrames(readFileSync(file))) {
      if (!line.includes('"type":"session"')) continue
      const event = JSON.parse(line)
      if (event?.type !== 'session') continue
      const meta = {
        id: String(event.id ?? ''),
        agentPreset: typeof event.agentPreset === 'string' ? event.agentPreset : '',
        cwd: String(event.cwd ?? ''),
        createdAt: Number(event.createdAt) || 0
      }
      if (META_CACHE.size > 200) META_CACHE.clear()
      META_CACHE.set(id, { key, meta })
      return meta
    }
  } catch (error) {
    note('diary', `读会话头失败 ${id}：${error instanceof Error ? error.message : error}`)
  }
  return null
}

export function titleForSession(sessionId) {
  const file = findSessionLog(sessionId)
  if (file === '') return ''
  try {
    return readTitleFromLog(file)
  } catch (error) {
    note('api', `读会话标题失败 ${sessionId}: ${error instanceof Error ? error.message : error}`)
    return ''
  }
}
