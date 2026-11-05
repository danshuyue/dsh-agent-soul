/**
 * threads.js —— 日记的连续线（2026-11-01）
 *
 * 一条「线」就是**一件悬着的事**：昨天日记里写了「明天要把那个 bug 收掉」，
 * 今天要有个回声。四篇日记得是同一个人的四天，不是四篇好文章。
 *
 * ── 三条设计约束 ──
 *
 * ① **线不是待办。** 它一律第一人称、口语、带感受。
 *    写成「任务：收尾压缩阈值 bug」就立刻变成周报 —— 那是树树最讨厌的东西。
 *
 * ② **开线走规则，不走模型。** 「明天/下周/还得/没弄完」这类句式够用了。
 *    生成时顺带吐 JSON 要改整个日记流程，收益不值。
 *
 * ③ **线会自己过期。** 连续 7 天没提就自动关。人会慢慢放下，不必假装永远记着。
 */
import { existsSync, readFileSync } from 'node:fs'
import { atomicWrite, agentsDir } from './paths.js'
import { note } from './env.js'

/** 一条线最多挂多久（天）。到点自动关。 */
export const THREAD_TTL_DAYS = 7
/** 一天最多开几条 —— 多了就成流水账。 */
export const THREAD_MAX_PER_DAY = 2
/** 总数上限，防止文件无限长大。 */
export const THREAD_MAX_TOTAL = 30

export const threadsPath = () => `${agentsDir()}/diary/threads.json`

/** 读。坏了就当没有 —— 日记照写，只是没有连续线，绝不抛错。 */
export function loadThreads() {
  try {
    const file = threadsPath()
    if (!existsSync(file)) return { threads: [] }
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (raw === null || typeof raw !== 'object' || !Array.isArray(raw.threads)) return { threads: [] }
    const threads = raw.threads
      .filter((t) => t !== null && typeof t === 'object' && String(t.text ?? '').trim() !== '')
      .map((t) => ({
        id: String(t.id ?? ''),
        text: String(t.text).trim(),
        openedAt: String(t.openedAt ?? ''),
        closedAt: typeof t.closedAt === 'string' && t.closedAt !== '' ? t.closedAt : null
      }))
    return { threads }
  } catch {
    return { threads: [] }
  }
}

export function saveThreads(state) {
  const threads = (Array.isArray(state?.threads) ? state.threads : []).slice(-THREAD_MAX_TOTAL)
  const written = atomicWrite(threadsPath(), `${JSON.stringify({ version: 1, threads }, null, 2)}\n`)
  if (written?.ok !== true) note('threads', `⚠️ 连续线写盘失败：${written?.error ?? '未知原因'}`)
  return { threads }
}

/** 还开着的线（没关、没超期）。 */
export function openThreads(state, { today = '', ttlDays = THREAD_TTL_DAYS } = {}) {
  const list = Array.isArray(state?.threads) ? state.threads : []
  return list.filter((t) => {
    if (t.closedAt !== null) return false
    if (today === '') return true
    return ageDays(t.openedAt, today) <= ttlDays
  })
}

function ageDays(from, to) {
  const a = Date.parse(`${from}T00:00:00`)
  const b = Date.parse(`${to}T00:00:00`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0
  return Math.floor((b - a) / (24 * 60 * 60 * 1000))
}

// ---------------------------------------------------------------------------
// 开线：从当天私密日记正文里按句式挑
// ---------------------------------------------------------------------------

/**
 * 「还悬着」的句式。三个方向：
 *   · 往后指的意图（明天/下周/还得）
 *   · 明说没做完（没弄完/没收尾/还差）
 *   · 挂着的担心（放不下/惦记着/还没跟他说）
 */
const OPEN_HINTS = /明天|下周|之后|回头|还得|还要|要继续|没弄完|没做完|没收尾|没收掉|还差|没搞定|放不下|惦记|悬着|还没|再说吧|拖到/

/** 句中必须有「我」，否则可能是「他说／书上说」这种转述。 */
const FIRST_PERSON = /我/

/**
 * 句首不能是「他说/她说/书上说」这类转述。
 *
 * ⚠️ 一开始写的是「整句必须含我」，实测漏掉最该抓的那条：
 *   「那个压缩阈值的坑明天还得再收一遍，今天只改到一半。」
 * 这是她在说自己的事，但整句一个「我」都没有 —— 中文本来就会省略主语。
 * 所以改成「只看句首」：句首不是转述，就是她在说自己的事。
 */
const REPORTED = /^(?:他|她|它|树树|主人|书上|网上|有人说|据说|大家|别人|[\u4e00-\u9fa5]{2,3}说)/

/** 句首可能是带时间/连接词的前缀，剥掉再判。 */
const LEADING_NOISE = /^(?:然后|后来|今天|昨天|晚上|早上|本来|可能|其实|不过|但是|而且|所以|那个|这个|反正|总之)/

/**
 * 从日记正文里抽候选线。
 *
 * @returns {string[]} 最多 THREAD_MAX_PER_DAY 条，已经是口语短句
 */
export function extractThreads(text, { limit = THREAD_MAX_PER_DAY } = {}) {
  const body = String(text ?? '')
  // 只取正文，丢掉首行标记和日期行
  const lines = body.split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('【') && !/^\d{4}-\d{2}-\d{2}$/.test(l))

  const picked = []
  for (const line of lines) {
    if (picked.length >= limit) break
    // 按句号/问号/叹号切，一句一条
    for (const raw of line.split(/(?<=[。！？!?])/)) {
      if (picked.length >= limit) break
      const sentence = raw.trim()
      if (sentence.length < 6 || sentence.length > 60) continue
      if (!isHerOwn(sentence)) continue
      if (!OPEN_HINTS.test(sentence)) continue
      if (picked.includes(sentence)) continue
      picked.push(sentence)
    }
  }
  return picked
}

/** 这句话是不是她自己在说自己的事（而不是转述别人）。 */
function isHerOwn(sentence) {
  const text = String(sentence ?? '').trim()
  // 句首剥掉时间/连接词再看
  let head = text
  for (let i = 0; i < 3; i += 1) {
    const next = head.replace(LEADING_NOISE, '')
    if (next === head) break
    head = next
  }
  // 「我」开头的永远是她的
  if (head.startsWith('我')) return true
  // 句首是转述 → 只有整句里有「我」才算她的回应（「他说…，我说好，回头帮他找资料」）
  if (REPORTED.test(head)) return FIRST_PERSON.test(text)
  // 剩下的：没有转述，就是她自己说自己的事（中文常省略主语）
  return true
}

/**
 * 把抽出来的句子变成一条线。
 *
 * **原句直接留用，不改写。** 改写要调模型，而且改完就不是她的话了。
 */
export function openThread(state, sentence, dateStr) {
  const text = String(sentence ?? '').trim()
  if (text === '') return state
  const list = Array.isArray(state?.threads) ? state.threads : []
  // 已经有一模一样的就不重复开
  if (list.some((t) => t.text === text)) return state
  list.push({
    id: `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    text,
    openedAt: String(dateStr ?? ''),
    closedAt: null
  })
  note('diary', `新开一条线：${text.slice(0, 30)}`)
  return { threads: list }
}

/**
 * 关线：某条线今天被提到了，就关掉。
 *
 * @param mentioned 今天日记正文
 */
export function closeMentioned(state, mentioned, dateStr) {
  const body = String(mentioned ?? '')
  if (body === '') return { state, closed: [] }
  const norm = (s) => String(s).replace(/[，。！？、；：\s…—－\-·""''「」『』（）()《》]/g, '')
  const flatBody = norm(body)
  const closed = []
  const threads = (Array.isArray(state?.threads) ? state.threads : []).map((t) => {
    if (t.closedAt !== null) return t
    // 判据：从句首和句尾各取一小段，**两段都在**才算提到。
    // 取 8 个字而不是 10：日记里换个说法（「那个坑」→「压缩阈值的事」）也能撞上中段。
    // 首尾都要在，是为了挡住「只是聊到同一个话题」—— 那不算这件事收尾了。
    const flat = norm(t.text)
    if (flat.length < 4) return t

    // 判据：**句中任意 6 字窗口**出现在今天的日记里，就算提到。
    //
    // 为什么不用"首尾都在"：线里自带「还没/明天」这类词，收尾时一定会换成
    // 「收掉了/弄完了」，首尾永远撞不上 —— 实测「那个压缩阈值的坑还没收尾」
    // 和「今天终于把那个压缩阈值的坑收掉了」尾段对不上，关不掉。
    // 6 字窗口够长（不会拿"那个"这种泛词乱撞），又不怕改写。
    const mentionedNow = flat.length <= 6
      ? flatBody.includes(flat)
      : anyWindowHit(flat, flatBody, 6)
    if (mentionedNow) {
      closed.push(t.text)
      return { ...t, closedAt: String(dateStr ?? '') }
    }
    return t
  })
  if (closed.length > 0) note('diary', `收掉了 ${closed.length} 条线：${closed.map((t) => t.slice(0, 20)).join(' / ')}`)
  return { state: { threads }, closed }
}

/** 这句话的任意连续 window 字，是不是出现在 haystack 里。 */
function anyWindowHit(needle, haystack, window) {
  for (let i = 0; i + window <= needle.length; i += 1) {
    if (haystack.includes(needle.slice(i, i + window))) return true
  }
  return false
}

/**
 * 超期关线：连续 TTL 天没提，就自己放下。
 * @returns {{state, expired: string[]}}
 */
export function expireThreads(state, today, { ttlDays = THREAD_TTL_DAYS } = {}) {
  const expired = []
  const threads = (Array.isArray(state?.threads) ? state.threads : []).map((t) => {
    if (t.closedAt !== null) return t
    if (ageDays(t.openedAt, today) <= ttlDays) return t
    expired.push(t.text)
    return { ...t, closedAt: today }
  })
  if (expired.length > 0) {
    note('diary', `${expired.length} 条线挂了 ${ttlDays} 天没人提，自己放下了`)
  }
  return { state: { threads }, expired }
}

/**
 * 渲染进日记提示词的那一段。
 *
 * 措辞是这里最要紧的东西：写成「待办」就变周报。
 * 所以固定带一句「这是惦记，不是任务清单」。
 */
export function renderThreadSection(state, { today = '', ttlDays = THREAD_TTL_DAYS } = {}) {
  const list = openThreads(state, { today, ttlDays })
  if (list.length === 0) return ''
  const lines = list.slice(0, 6).map((t) => `- ${t.text}`)
  return [
    '还悬着的事（**这是惦记，不是任务清单**）：',
    ...lines,
    '',
    '写的时候：今天提到了、有进展，就自然带一句；没提到就完全不用管。',
    '别为了"交代进度"硬塞 —— 日记不是周报。'
  ].join('\n')
}
