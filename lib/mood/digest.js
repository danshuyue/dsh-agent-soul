/**
 * 心情引擎 · digest.js
 * 由 lib/mood.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { DIMS, dimPercent, dimWord } from './core.js'


// --------------------------------------------------------------------------
// 心情摘要（给日记当情绪底色）
// --------------------------------------------------------------------------

/**
 * 毫秒时间戳 → HH:MM（本地时区）。
 * 不写 UTC：日记里的「22:18」得是她感受到的那个钟点。
 */
export const clockOf = (at) => {
  const d = new Date(Number(at) || 0)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}


/**
 * 把一段时间里的心情压成一份摘要（纯函数，不读文件）。
 *
 * ── 为什么要这个 ──
 * 日记原来的素材只有「对话流水 + 摘要」—— 全是事实，没有温度。而心情时间线里
 * 存着她**用第一人称写下的、带情绪的真实想法**（reason 字段），比流水生动得多。
 * 攒了一天却只有仪表盘能看见，太浪费。
 *
 * ── 输入为什么是「状态数组」 ──
 * 心情按工作区分片（每个 cwd 一份文件），日记没有 cwd —— 所以调用方把当天所有
 * 分片一起传进来，这里合并着看：时间线跨分片按时间排序，七情取各分片的**峰值**
 * （今天情绪到过哪，而不是最后停在哪）。
 *
 * @param {object[]} states normMoodState 出来的心情状态（一个或多个）
 * @returns {object} { empty, from, to, low, high, delta, dims, moments }
 */
export function moodDigest(states, { since = 0, until = 0, maxMoments = 5, dimTop = 3 } = {}) {
  const list = Array.isArray(states) ? states : [states]
  const moments = []
  for (const state of list) {
    if (state === null || typeof state !== 'object') continue
    for (const item of Array.isArray(state.timeline) ? state.timeline : []) {
      const at = Number(item?.at)
      if (!Number.isFinite(at) || at <= 0) continue
      if (since > 0 && at < since) continue
      if (until > 0 && at > until) continue
      // 2026-11-08 KNOWN-ISSUES #19：decay 条目的 reason 是固定模板句
      // （core.js「过了几个钟头，刚才那点劲儿慢慢淡了…」），不是她自己的话。
      // 真实波动少的时候它会挤进 maxMoments 名额，日记里凭空出现一句与时间点无关的话。
      if (item?.kind === 'decay') continue
      const raw = String(item?.reason ?? '').trim()
      // 没有理由的条目只有数字，喂给日记等于没喂
      if (raw === '') continue
      moments.push({
        at,
        mood: Number(item?.mood),
        delta: Number(item?.delta),
        // 截断要留个记号：日记里出现半句话，她会以为是自己的记忆断了
        reason: raw.length > 140 ? `${raw.slice(0, 139)}…` : raw
      })
    }
  }

  if (moments.length === 0) {
    return { empty: true, from: null, to: null, low: null, high: null, delta: 0, dims: [], fading: [], moments: [] }
  }

  moments.sort((a, b) => a.at - b.at)
  const values = moments.map((m) => m.mood).filter((v) => Number.isFinite(v))
  // 2026-11-05 S3 / P2-19：moments 非空但 mood 全是 NaN 时，下面
  // values[0] / Math.min(...values) 会产出 NaN / Infinity 并一路写进日记。
  if (values.length === 0) {
    return { empty: true, from: null, to: null, low: null, high: null, delta: 0, dims: [], fading: [], moments: [] }
  }
  const round = (v) => Math.round(Number(v) * 10) / 10

  // 七情分两件事看：
  //   峰值 —— 今天到过哪（时间线里的快照取最大，也含当前值兜底）
  //   此刻 —— 现在还留着多少（各分片当前 dims 取最大）
  // 两者差得多，说明这股劲儿已经淡下去了 —— 这是日记里才有的一层信息。
  const peak = {}
  const now = {}
  for (const state of list) {
    if (state === null || typeof state !== 'object') continue
    for (const [key] of DIMS) {
      const cur = Number(state.dims?.[key]) || 0
      now[key] = Math.max(Number(now[key]) || 0, cur)
      peak[key] = Math.max(Number(peak[key]) || 0, cur)
    }
    for (const item of Array.isArray(state.timeline) ? state.timeline : []) {
      if (item?.dims === null || typeof item?.dims !== 'object') continue
      for (const [key] of DIMS) peak[key] = Math.max(Number(peak[key]) || 0, Number(item.dims[key]) || 0)
    }
  }

  const dims = DIMS
    .map(([key, label]) => {
      const percent = dimPercent(peak[key])
      return { key, label, value: Math.round(Number(peak[key]) || 0), percent, word: dimWord(percent) }
    })
    .filter((item) => item.percent > 0)
    .sort((a, b) => b.percent - a.percent)
    .slice(0, Math.max(1, dimTop))

  // 淡了 25 个百分点以上才算「明显退下去」，差一点点不值得单说
  const fading = dims
    .map((item) => ({ label: item.label, from: item.percent, to: dimPercent(now[item.key]) }))
    .filter((item) => item.from - item.to >= 25)

  // 挑「起伏最大」的几段，再按时间正序输出（读起来是顺着一天走的）
  const picked = moments
    .slice()
    .sort((a, b) => Math.abs(Number(b.delta) || 0) - Math.abs(Number(a.delta) || 0))
    .slice(0, Math.max(1, maxMoments))
    .sort((a, b) => a.at - b.at)

  return {
    empty: false,
    from: round(values[0]),
    to: round(values[values.length - 1]),
    low: round(Math.min(...values)),
    high: round(Math.max(...values)),
    delta: round(values[values.length - 1] - values[0]),
    dims,
    fading,
    moments: picked
  }
}


/**
 * 把摘要渲染成给日记的一段（纯函数）。
 *
 * 公开 / 私密两版的区别不只是条数：
 *   · 公开版只给心情走向和两三句，措辞是「可以写进去」—— 那是要拿给人看的；
 *   · 私密版给全部，措辞是「这是你当时的真实想法」—— 那些 reason 本来就是心里话。
 *
 * 只给**事实与素材**，不给「你要写得开心一点」这类指令：
 * 一旦让她照着情绪演，日记就假了（跟心情不注入提示词是同一个道理）。
 */
export function renderMoodDigest(digest, { mode = 'public', maxMoments = 3 } = {}) {
  if (digest === null || typeof digest !== 'object' || digest.empty === true) return ''
  const privateMode = mode === 'private'
  const limit = privateMode ? Math.max(1, maxMoments) : Math.min(Math.max(1, maxMoments), 3)

  const lines = []
  lines.push(privateMode ? '【今天的情绪（只有你自己看得到）】' : '【今天的情绪】')

  const from = digest.from
  const to = digest.to
  const arrow = from === null ? '' : `心情 ${from} → ${to}`
  const spread = digest.low === null ? '' : `（区间 ${digest.low}~${digest.high}`
  const net = Number(digest.delta) || 0
  const netText = spread === '' ? '' : `，净 ${net > 0 ? '+' : ''}${net}）`
  if (arrow !== '') lines.push(`${arrow}${spread}${netText}`)

  if (Array.isArray(digest.dims) && digest.dims.length > 0) {
    // 按 20 满格折算成百分比：「踏实 64%」比「踏实 13」读得出来
    lines.push(`七情峰值：${digest.dims.map((d) => `${d.label} ${d.percent}%（${d.word}）`).join('、')}`)
  }
  const fading = Array.isArray(digest.fading) ? digest.fading : []
  if (fading.length > 0) {
    lines.push(`已经淡下去的：${fading.map((f) => `${f.label} ${f.from}% → ${f.to}%`).join('、')}`)
  }

  const moments = (Array.isArray(digest.moments) ? digest.moments : []).slice(0, limit)
  if (moments.length > 0) {
    lines.push('')
    lines.push('那天你自己的想法（当时记下的）：')
    for (const m of moments) {
      const sign = Number(m.delta) > 0 ? '+' : ''
      const deltaText = Number.isFinite(Number(m.delta)) && Number(m.delta) !== 0 ? `（${sign}${Math.round(m.delta)}）` : ''
      lines.push(`  ${clockOf(m.at)} ${deltaText} 「${m.reason}」`)
    }
  }

  lines.push('')
  lines.push(privateMode
    ? '这些是你今天的真实情绪。私密日记里不用收着，可以写公开版里略过的、没说出口的部分。'
    : '写的时候可以带上你当时的心情，但记得这是会拿给对方看的版本。')

  return lines.join('\n')
}
