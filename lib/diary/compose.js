/**
 * 摘录 · compose.js（2026-11-21 / 0.10.0：由「公开 + 私密两条消息」改成一条）。
 *
 * 本文件只做一件事：把「写这一天的摘录」拼成一条投给绑定会话的消息。
 *
 * 0.10.0 删掉的东西（都在这个文件里有过身影）：
 *   · composePublicMessage / composePrivateMessage —— 两篇 → 一篇
 *   · buildMoodBlocks / diaryWindowOf —— 摘录不写感受，情绪记录不再进 prompt
 *     （给了它「当时怎么想的」，它就一定会写进来；摘录只要事实）
 *   · 连续线（threads 模块，已删）—— 摘录是事实，没有「悬着的事」这种叙事
 *   · 私密历史喂回（continueFromPublic）—— 没有私密篇，自然没有这一套
 */
import { wrapUntrusted } from '../core/prompt-guard.js'
import { EMPTY_DAY_LINE, PRIORITY_WORDS } from './excerpt.js'
import { renderRecentExcerpts } from './history.js'


/**
 * 组装「写这一天的摘录」的触发消息。
 *
 * @param {object} config 插件配置
 * @param {string} dateStr 'YYYY-MM-DD'（写的是哪一天）
 * @param {string} summary 那一天的对话素材
 * @param {{ recentExcerpts?: Array<{date: string, lines: string[]}>, maxLines?: number }} [options]
 * @returns {string}
 *
 * 2026-11-21 / 0.10.2：现实情境与语气**从摘录里搬走**了。
 * 摘录只写事实，不该带「今天是节日 / 已经三天没聊」这种背景，也不该有语气指令；
 * 这两样现在只喂给「心里话」（见 lib/diary/self.js）。`options.situation` 传进来也会被忽略。
 */
export function composeExcerptMessage(config, dateStr, summary, options = {}) {
  const maxLines = Math.max(1, Math.trunc(Number(options.maxLines ?? config?.excerptMaxLines) || 15))
  const history = renderRecentExcerpts(options.recentExcerpts, { linesPerDay: 3 })

  const lines = []
  lines.push(`请写 ${dateStr} 这一天的摘录。`)
  // 这个会话里躺着她以前写的摘录，必须说清那是「字」不是「事」。
  // 0.10.0 之前两篇日记就是在这一条上翻过车（旧内容被当成当天又发生了一次）。
  lines.push('先说清一件事：上文里那些你自己以前写过的摘录，只是你当时写下的字，不代表今天发生过什么。'
    + '这一天发生了什么，只看下面这段素材；素材里没有的，不要当成这一天的事写进来。')
  lines.push('')
  lines.push('这一天的对话内容：')
  lines.push(wrapUntrusted('这一天的对话', summary || '今天没有对话'))
  if (history !== '') {
    lines.push('')
    lines.push('前几天写过什么（**这是前几天写的，不是这一天的事**；只用来对齐「哪些事已经记过」，不要重复写）：')
    lines.push(wrapUntrusted('前几天的摘录', history))
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('摘录的格式，严格照这个来：')
  lines.push('- 一行一条，每条以「- 」开头；')
  lines.push('- 只写「对什么、做了什么」这种事实，不写时间（几点几分不要写），不写感受和评价'
    + '（不要出现「觉得 / 看得出 / 其实 / 似乎 / 也许」这类词）；')
  lines.push('- 不写总结段、不写感想，除了这些条目什么都不要写；')
  lines.push(`- 最多 ${maxLines} 条。超过的话优先留「${PRIORITY_WORDS.join(' / ')}」这几类`
    + '（最多 3 条，写在最前面），其余按重要性取舍；')
  lines.push(`- 这一天没有对话时，只写一行：${EMPTY_DAY_LINE}`)
  lines.push('')
  lines.push('用 soul_diary 工具写：action=write，kind=excerpt，date=' + dateStr + '，正文放进 content。')
  lines.push('首行的日期它会自己补，你不用写。')

  return lines.join('\n')
}
