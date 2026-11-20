/**
 * 摘录 · excerpt.js —— 「一行一条」的清洗、排序与落盘文本（2026-11-21 / 0.10.0）。
 *
 * 摘录（excerpt）取代了原来的「公开 + 私密」两篇日记：
 *   # 2026-11-20
 *
 *   - 灵魂插件：日记改成「摘录」，去掉公开/私密两篇
 *   - 复变：确认下周四考试，定了每天两小时
 *
 * 格式是硬规则，不靠模型自觉（跟当年「首行由插件补」同一个思路）：
 *   ① 一行一条，`- ` 开头；② 不写时间；③ 不写感受/评价（下面 FEELING_WORDS）；
 *   ④ 最多 excerptMaxLines 条；⑤ 超了优先留「约定 / 决定 / 时间 / 待办」，最多 3 条放最前面。
 *
 * 这个模块是纯函数（除了 note 日志），调度、工具、兜底三条路都走它 ——
 * 谁写的都一样，落盘形状只有这一份定义。
 */
import { note } from '../env.js'

/** 摘录里的「优先保留」词：超上限时先留这几类（都是事实，且对以后有用）。 */
export const PRIORITY_WORDS = Object.freeze(['约定', '决定', '时间', '待办'])
/** 优先条目最多几条（放在最前面）。 */
export const PRIORITY_MAX = 3

/**
 * 感受 / 评价词（摘录不写这些）。
 *
 * 提示词里已经明令禁止，这里是最后一道：模型偶尔仍会写「其实他有点累」这种句子，
 * 落在文件里就变成叙事，而摘录要的是事实。**丢弃整行**而不是删词 ——
 * 删词会把「其实下周四考试」改成「下周四考试」，看似救回来，实际是在替模型改意思。
 * 丢弃会记一行日志（失败必须可见），不是静默处理。
 */
export const FEELING_WORDS = Object.freeze(['觉得', '看得出', '其实', '似乎', '也许'])

/** 摘录里「今天没有对话」的那一行。 */
export const EMPTY_DAY_LINE = '（今天没有对话）'

/** 前置时间戳：`[22:10] `、`22:10 `、`22:10:05 `、`2026-11-20 22:10 `。 */
const TIME_PREFIX_RE = /^(?:\[\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\]\s*|\d{4}-\d{2}-\d{2}[ T]\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s*|\d{1,2}[:：]\d{2}(?:[:：]\d{2})?\s+)/

/** 行首的列表符号：`- `、`* `、`+ `、`1. `、`1、`、`• `。 */
const BULLET_RE = /^(?:[-*+•·]|\d{1,2}[.、)）])\s*/

/** 纯日期行 / 标题行 / 分隔线（都是模型爱多写的「格式外壳」）。 */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const HEADING_RE = /^#{1,6}\s*/
const RULE_RE = /^(?:---+|\*\*\*+|___+)$/

/** 单条摘录的长度上限：一行写太长就不是「一条」了。 */
const LINE_MAX_CHARS = 160

/** 把一段模型输出洗成「一行一条」的裸条目（不含 `- ` 前缀）。 */
export function excerptLinesOf(text) {
  const out = []
  const seen = new Set()
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    let line = rawLine.replace(/^\uFEFF/, '').trim()
    if (line === '') continue
    // 代码块围栏本身不是内容，但要留下里面的行（模型偶尔会把条目包进 ``` 里）
    if (/^```/.test(line)) continue
    if (RULE_RE.test(line)) continue
    if (HEADING_RE.test(line)) {
      line = line.replace(HEADING_RE, '').trim()
      if (line === '' || DATE_ONLY_RE.test(line)) continue
      // `## 2026-11-20` 这类也丢掉；`## 复变` 这种当成正文（去掉井号即可）
    }
    if (DATE_ONLY_RE.test(line)) continue
    line = line.replace(BULLET_RE, '').trim()
    line = line.replace(TIME_PREFIX_RE, '').trim()
    if (line === '') continue
    line = line.replace(/\s+/g, ' ').trim()
    if (line.length > LINE_MAX_CHARS) line = `${line.slice(0, LINE_MAX_CHARS - 1)}…`
    if (seen.has(line)) continue
    seen.add(line)
    out.push(line)
  }
  return out
}

/** 这一行是不是「约定 / 决定 / 时间 / 待办」类。 */
export function isPriorityLine(line) {
  const text = String(line ?? '')
  return PRIORITY_WORDS.some((word) => text.includes(word))
}

/**
 * 排序 + 截断。
 *
 * 超上限时优先留约定/决定/时间/待办（最多 3 条），并且**放在最前面** ——
 * 它们在文件顶部，下一轮注入/翻看时第一眼就看得见。其余按原顺序跟在后面。
 *
 * @param {string[]} lines 已经洗好的裸条目
 * @param {number} maxLines 上限（配置 excerptMaxLines，默认 15）
 * @returns {string[]}
 */
export function orderExcerptLines(lines, maxLines = 15) {
  const limit = Math.max(1, Math.trunc(Number(maxLines) || 15))
  const list = Array.isArray(lines) ? lines.filter((line) => String(line ?? '').trim() !== '') : []
  if (list.length <= limit) return list.slice()
  const priority = []
  const rest = []
  for (const line of list) {
    if (priority.length < PRIORITY_MAX && isPriorityLine(line)) priority.push(line)
    else rest.push(line)
  }
  return [...priority, ...rest].slice(0, limit)
}

/**
 * 洗 + 排序 + 截断，并把丢掉的感受行报出来。
 *
 * @returns {{ lines: string[], dropped: string[] }}
 */
export function normalizeExcerpt(text, { maxLines = 15 } = {}) {
  const raw = excerptLinesOf(text)
  const dropped = raw.filter((line) => FEELING_WORDS.some((word) => line.includes(word)))
  const kept = raw.filter((line) => !FEELING_WORDS.some((word) => line.includes(word)))
  const lines = orderExcerptLines(kept, maxLines)
  if (dropped.length > 0) {
    note('diary', `摘录里 ${dropped.length} 行带感受/评价词（${FEELING_WORDS.join('/')}），已丢弃：${dropped[0].slice(0, 40)}`)
  }
  if (raw.length > maxLines) {
    note('diary', `摘录 ${raw.length} 条超过上限 ${maxLines}，已按「约定/决定/时间/待办优先」裁到 ${maxLines} 条`)
  }
  return { lines, dropped }
}

/**
 * 落盘文本：`# 日期` + 空行 + 每条 `- `。
 *
 * 一天没有对话（lines 为空）时写一行 `（今天没有对话）` —— 空文件与「那天真的没聊」
 * 在视觉上分不开，而这两种情况对以后翻看的人意义完全不同。
 */
export function renderExcerptFile(dateStr, lines) {
  const list = Array.isArray(lines) ? lines.filter((line) => String(line ?? '').trim() !== '') : []
  const body = list.length === 0 ? [`- ${EMPTY_DAY_LINE}`] : list.map((line) => `- ${line}`)
  return `# ${String(dateStr ?? '').trim()}\n\n${body.join('\n')}\n`
}

/**
 * 读回落盘文本里的条目（设置页/注入用）。
 * 容错：旧格式、手改过的文件都尽量读出来，读不出就给空数组。
 */
export function excerptLinesFromFile(text) {
  const lines = []
  for (const rawLine of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim()
    if (!line.startsWith('- ')) continue
    const body = line.slice(2).trim()
    if (body === '' || body === EMPTY_DAY_LINE) continue
    lines.push(body)
  }
  return lines
}
