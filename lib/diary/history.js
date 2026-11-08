/**
 * 日记 · history.js（2026-11-10 KNOWN-ISSUES #27：由 compose.js 按职责拆出）
 * 最近日记读取：readRecentDiaries / digestDiaries。函数体逐字未改。
 */
import { diaryPrivatePath, diaryPublicPath, exists, readText } from '../paths.js'
import { parseDateLocal, todayKey } from './completion.js'


// --------------------------------------------------------------------------
// 最近日记读取
// --------------------------------------------------------------------------

/**
 * 读最近 N 天的日记文件。
 *
 * 按时间正序（最旧在前）返回。
 *
 * @returns {{ public: string, all: string }}
 *   public = 仅【公开】日记，用于公开 prompt
 *   all    = 公开 + 私密，用于私密 prompt
 */
export function readRecentDiaries(dateStr, days = 4) {
  const pubEntries = []
  const allEntries = []
  const dayStart = parseDateLocal(dateStr).getTime()

  // 从最旧到最新（正序）
  for (let i = days; i >= 1; i -= 1) {
    const key = todayKey(dayStart - i * 24 * 60 * 60 * 1000)

    const pubFile = diaryPublicPath(key)
    if (exists(pubFile)) {
      const content = readText(pubFile).trim()
      if (content !== '') {
        pubEntries.push(content)
        allEntries.push(content)
      }
    }

    const privFile = diaryPrivatePath(key)
    if (exists(privFile)) {
      const content = readText(privFile).trim()
      if (content !== '') {
        allEntries.push(content)
      }
    }
  }

  return {
    public: pubEntries.join('\n\n---\n\n'),
    all: allEntries.join('\n\n---\n\n')
  }
}


/**
 * 把几篇日记压成「每篇一行」的摘要（2026-11-05）。
 *
 * 为什么：新对话首轮会把最近两天的日记**整篇**注入，实测约 3000 字，
 * 是开场里最大的一块；而日记的价值在「昨天大概是什么事」，不在逐段复述。
 * 这里取每篇的第一段（日记的第一段本来就是当天的主题句），保留日期和全文字数，
 * 想细看再按日期去读文件。
 *
 * @param {string} text readRecentDiaries 的返回值（多篇用 `---` 分隔）
 * @param {number} perDay 每篇保留多少字
 * @returns {string}
 */
export function digestDiaries(text, perDay = 300) {
  const limit = Math.max(40, Math.trunc(Number(perDay) || 300))
  return String(text ?? '')
    .split(/\n\n---\n\n/)
    .map((entry) => {
      const t = String(entry ?? '').trim()
      if (t === '') return ''
      const m = t.match(/^【(公开|私密)】\s*\n\s*(\d{4}-\d{2}-\d{2})\s*\n+([\s\S]*)$/)
      if (m === null) return t.length > limit ? `${t.slice(0, limit)}…` : t
      const body = m[3].trim()
      const first = body.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim()
      const line = first.length > limit ? `${first.slice(0, limit)}…` : first
      return `- ${m[2]}：${line}（全文 ${body.length} 字）`
    })
    .filter((line) => line !== '')
    .join('\n')
}
