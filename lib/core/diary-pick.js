/**
 * dairy-pick.js —— 挑哪段对话进日记（2026-11-02）
 *
 * ── 为什么要有这个 ──
 *
 * 原来是把整个 JSONL 拼成一大段文本，超过 30000 字就从**前面**截断。
 * 实测那天 57245 字，砍掉 47%，而砍掉的正好是早上那半段 ——
 * 一天里越早的事越容易被丢，这一整天就只剩晚上。
 *
 * 更要命的是内容构成：那天 26762 字里，她说了 23546 字（88%），
 * 其中 21414 字（80%）是技术细节（函数名、断言数、commit hash）。
 * 那些对日记没有任何意义 —— 日记不该写「改完 diaryIsCompleteFor，
 * 947 断言通过，推了 8ce7145」。
 *
 * ── 做法 ──
 *
 * 逐条打分，按分数从高到低装进预算，**再按时间重新排**。
 * 这样保住的是「一整天的跨度 + 真正有情绪和生活的部分」，
 * 丢掉的是最没用的技术细节。
 *
 * 打分纯规则，不调模型 —— 它每篇日记都要跑，不能多一次调用。
 */

/** 生活/情绪词：命中就说明这条跟"日子"有关，而不是跟"代码"有关。 */
const LIFE_WORDS = /吃|睡|饿|累|困|冷|热|疼|病|药|饭|饿|宵夜|早饭|午饭|晚饭|摸鱼|上班|下班|回宿舍|宿舍|寝室|上课|考试|作业|放假|周末|回家|家里|妈|爸|奶奶|爷爷|朋友|室友|同学|老师|打工|工资|钱|花呗|省|光遇|游戏|视频|照片|刷|手机|下雨|天气|太阳|早起|熬夜|晚安|早安|梦|想|抱|亲|乖|宝|哼|呜呜|哭|笑|开心|难过|委屈|烦|气|怕|担心|心疼|踏实|甜|暖|冷清|一个人|陪|等我|回来|别走|想你|爱你|喜欢|讨厌|好耶|耶|喵|糖糖|树树|树树/i

/** 技术细节：命中就大幅减分。这些都是"不该进日记"的东西。 */
const TECH_SIGNS = [
  /`[^`]+`/g,                    // 行内代码
  /\.(js|json|md|yml|yaml|ts|mjs|cmd|ps1|py)\b/gi,   // 文件扩展名
  /\bgit\s+(push|pull|commit|checkout|add)\b/gi,
  /\bnpm\s+(test|publish|view|install)\b/gi,
  /\b[0-9a-f]{7,40}\b/g,         // commit hash / 长十六进制串
  /断言|单元测试|跑测试|测试通过|测试失败/g,
  /函数|参数|变量|接口|报错|堆栈|日志|配置项|返回值/g,
  /C:\\|\/Users\/|\/home\/|~\/\.dsh/gi,
  /^\s*\|.*\|\s*$/gm,            // markdown 表格行
  /```/g
]

/** 系统/插件注入的碎屑：完全没价值。 */
const NOISE = /^(?:\[#\d+\]|【\d{4}-\d{2}-\d{2}】)|\bsession-[0-9a-f-]{8,}|Current time:/i

/**
 * 给一条消息打分。分数越高越该进日记。
 *
 * @param {{role: string, text: string, t?: number}} row
 * @returns {{score: number, reasons: string[]}}
 */
export function scoreEntry(row) {
  const text = String(row?.text ?? '')
  if (text.trim() === '') return { score: 0, reasons: ['空'] }

  const reasons = []
  let score = 10 // 底分：它在，就有一点价值

  const lifeHits = (text.match(LIFE_WORDS) || []).length
  if (lifeHits > 0) {
    score += Math.min(24, lifeHits * 6)
    reasons.push(`生活词×${lifeHits}`)
  }

  let techHits = 0
  for (const re of TECH_SIGNS) {
    const m = text.match(re)
    if (m !== null) techHits += m.length
  }
  if (techHits > 0) {
    // 减分有上限：一条既有技术细节又有「我累了」的话，不该被一刀砍死
    const penalty = Math.min(30, techHits * 4)
    score -= penalty
    reasons.push(`技术×${techHits}(-${penalty})`)
  }

  // 她带语气的句子（喵/哼/呀/啦/呢/吧…）比干巴巴的技术说明值钱
  if (row?.role === 'assistant') {
    if (/喵|哼|呀|啦|呢|吧|嘛|嘿|欸|哎/.test(text)) {
      score += 8
      reasons.push('有语气')
    }
  }

  // 树树说的话权重更高（×1.5）—— 那天他 3216 字，她 23546 字，
  // 再按条数平分的话，他的声音几乎听不见。
  if (row?.role === 'user') {
    score = Math.round(score * 1.5)
    reasons.push('他的话×1.5')
  }

  // 长度：太长的多半是技术长文，轻微减分；太短（「嗯」「好的」）也没有信息量
  const len = text.length
  if (len > 400) score -= 6
  else if (len < 8) score -= 10

  if (NOISE.test(text)) {
    score -= 20
    reasons.push('系统碎屑')
  }

  return { score, reasons }
}

/**
 * 挑出进日记的段落。
 *
 * @param rows  JSONL 解出来的 [{role, text, t}]
 * @param opts  { maxChars 预算, perEntryMax 单条上限, ownerName 对话里的人怎么标 }
 * @returns {{ text: string, picked: number, dropped: number, usedChars: number, lifeRatio: number, details: [] }}
 */
export function pickConversation(rows, { maxChars = 30000, perEntryMax = 600, ownerName = '' } = {}) {
  const who = String(ownerName ?? '').trim() === '' ? '对方' : String(ownerName).trim()
  const list = (Array.isArray(rows) ? rows : [])
    .filter((r) => r !== null && typeof r === 'object' && String(r.text ?? '').trim() !== '')
    .map((r, i) => {
      const text = String(r.text).slice(0, perEntryMax)
      const { score, reasons } = scoreEntry({ ...r, text })
      return { ...r, text, score, reasons, order: i, len: text.length }
    })

  // 按分数挑，平分时先出现的优先（早上的事和晚上的事等重时，保住时序）
  const ranked = [...list].sort((a, b) => (b.score - a.score) || (a.order - b.order))

  const picked = []
  let used = 0
  for (const entry of ranked) {
    if (entry.score <= 0) continue // 负分的（纯技术长文）宁可不进
    const cost = entry.len + 2
    if (used + cost > maxChars) continue
    picked.push(entry)
    used += cost
  }

  // 按时间重新排 —— 日记要能顺着一天读下来
  picked.sort((a, b) => a.order - b.order)

  const fmt = (r) => {
    const d = Number(r.t)
    const hh = Number.isFinite(d) ? new Date(d) : null
    const stamp = hh !== null
      ? `${String(hh.getHours()).padStart(2, '0')}:${String(hh.getMinutes()).padStart(2, '0')}`
      : '--:--'
    // 2026-11-04：这里原来写死「树树」。没设 ownerName 时用中性的「对方」，
    // 跟 diary.js 的 formatConversations 同一个口径。
    return `[${stamp}] ${r.role === 'user' ? who : '我'}：${r.text}`
  }

  const text = picked.map(fmt).join('\n')
  // 2026-11-08 KNOWN-ISSUES #18：`&&` 优先于 `||`，原式的意图是
  // 「（正分 且 非技术）或 含生活词」—— 现在加括号写明，行为按这个口径。
  const lifeChars = picked.filter((p) =>
    (p.score > 0 && !p.reasons.some((x) => x.startsWith('技术'))) ||
    p.reasons.some((x) => x.startsWith('生活词'))
  ).reduce((a, p) => a + p.len, 0)

  return {
    text,
    picked: picked.length,
    dropped: list.length - picked.length,
    usedChars: used,
    totalChars: list.reduce((a, r) => a + r.len, 0),
    lifeRatio: used > 0 ? lifeChars / used : 0,
    details: picked.map((p) => ({ role: p.role, len: p.len, score: p.score, reasons: p.reasons, head: p.text.slice(0, 40) }))
  }
}
