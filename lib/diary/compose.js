/**
 * 日记 · compose.js（2026-11-10 KNOWN-ISSUES #27 拆分后）
 * 本文件只留「prompt 组装」：diaryWindowOf（时间窗）/ buildMoodBlocks（心情底色）/
 * composePublicMessage / composePrivateMessage（触发消息）。
 * LLM 调用 → llm.js；最近日记读取 → history.js；会话 preset 修复 → agent.js。
 * 对外仍由 lib/diary.js 门面统一导出，导出集合不变。
 */
import { wrapUntrusted } from '../core/prompt-guard.js'
import { allMoodStates } from '../store.js'
import { diaryPublicPath, readText } from '../paths.js'
import { moodDigest, renderMoodDigest } from '../mood.js'
import { note } from '../env.js'


// --------------------------------------------------------------------------
// 触发消息组装
// --------------------------------------------------------------------------

/**
 * 这一天对应的时间窗（毫秒）：[前一日 22:00, 当日 22:00)。
 *
 * 日记的一天以 schedule 分界（默认 22:00），不是自然日 —— 跟 readDiaryConversations
 * 的裁剪口径保持一致，心情时间线也按这个窗口筛，两边才对得上。
 */
/**
 * 日记日对应的时间窗（毫秒），2026-10-31 改：自然日。
 *
 * 日记「2026-10-31」= [2026-10-31 00:00, 2026-11-01 00:00)。
 * 跟 diaryDayBoundaries 完全一致 —— 心情时间线必须按同一个窗口筛，
 * 否则日记里引用的情绪和对话会对不上号。
 *
 * 参数只为兼容旧调用点保留，不再参与计算。
 */
export function diaryWindowOf(dateStr, _scheduleMin) {
  const [y, m, d] = String(dateStr).split('-').map((v) => Number(v))
  // 2026-11-08 KNOWN-ISSUES #16：原来对 NaN 的月/日静默回退成 1 —— `'2026-xx-01'`
  // 会算出 1 月的窗口而不是空。现在显式判 NaN 返回空窗口（since>until 的窗口
  // 什么都筛不到），调用方 buildMoodBlocks 已有 try/catch 兜底。
  // 与 completion.js 的 parseDateLocal 同一口径。
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    return { since: 0, until: 0 }
  }
  const dayStart = new Date(y, m - 1, d, 0, 0, 0, 0).getTime()
  return { since: dayStart, until: dayStart + 24 * 60 * 60 * 1000 }
}


/**
 * 当天的心情摘要，渲染成日记里的「情绪底色」（拿不到就返回空串）。
 *
 * 为什么公开和私密分开算：私密那篇给她全部（那本来就是心里话），
 * 公开那篇只给走向和两三句 —— 跟「先投公开、写完再投私密」是同一个隔离思路。
 */
export function buildMoodBlocks(dateStr, scheduleMin, { config = {} } = {}) {
  try {
    const states = allMoodStates()
    if (states.length === 0) return { public: '', private: '' }
    const { since, until } = diaryWindowOf(dateStr, scheduleMin)
    const digest = moodDigest(states, { since, until, maxMoments: 6 })
    if (digest.empty === true) return { public: '', private: '' }
    return {
      public: renderMoodDigest(digest, { mode: 'public', maxMoments: Number(config.diaryPublicMoodMoments) || 3 }),
      private: renderMoodDigest(digest, { mode: 'private', maxMoments: Number(config.diaryPrivateMoodMoments) || 6 })
    }
  } catch (error) {
    note('diary', `心情摘要失败：${error instanceof Error ? error.message : error}`)
    return { public: '', private: '' }
  }
}


/**
 * 组装「写公开日记」的触发消息（第一条）。
 *
 * 只喂**公开**日记历史 —— 私密历史压根不出现在这条消息里。
 *
 * 为什么不两篇写在同一条消息里：写在一条里的话，私密历史就摆在下面，
 * 她写公开那一步时已经看到了本不该给人看的内容，「公开段只喂公开日记」
 * 这句话等于没说。拆成两条、等公开那篇落盘了再投私密，才是真的隔开。
 */
export function composePublicMessage(config, dateStr, summary, recentDiaries, moodText = '', threadSection = '') {
  const publicTone = String(config.diaryPublicTone ?? '').trim()

  const lines = []

  lines.push(`今天是 ${dateStr}。`)
  lines.push('')
  lines.push('今天和对方的对话内容：')
  lines.push(wrapUntrusted('今天的对话', summary || '今天没有对话'))
  // 情绪底色：只有事实与素材（心情怎么走的、当时怎么想的），不给「写得开心点」这类指令
  if (String(moodText).trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('情绪记录', String(moodText).trim()))
  }
  // 连续线：还悬着的事（2026-11-04 补）。
  // 走「她自己写」这条路时原来漏了这个参数，于是她自己写看不到昨天没说完的事，
  // 只有插件兜底生成才看得到 —— 正好反了：她自己写的时候更该知道答应了什么。
  if (String(threadSection ?? '').trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('连续线', String(threadSection).trim()))
  }
  lines.push('')
  lines.push('---')
  lines.push('')
  lines.push('请写今天的公开日记。这是你会拿给对方看的版本。')
  lines.push('')
  // 前几天的日记（2026-11-08）：不再投。
  // 写日记用的是固定绑定的那个会话，前几天写过的都在上文；
  // 就算中途换了会话或压缩过，soul_diary 的 action=look 也能自己翻回来。
  // 插件兜底那条路（composeDiaryText）是独立的模型调用，不走这里，历史照旧给。
  lines.push('前几天的日记这次不再重复贴；要回想具体某天，用 soul_diary 的 action=look。')
  lines.push('')
  if (publicTone !== '') lines.push(`语气：${publicTone}`)
  lines.push('用 soul_diary 工具写：action=write，kind=public，date=' + dateStr + '，正文放进 content。')
  lines.push('首行的【公开】和日期它会自己补，你不用写；篇幅不限，自然即可。')
  lines.push('')
  lines.push('如果今天没有对话：你可以写这段安静里想了什么、对之前日记的回想，或纯粹的意识流。')
  lines.push('')
  lines.push('写完这一篇就先停在这里，私密那篇等我下一条消息。')

  return lines.join('\n')
}


/**
 * 组装「写私密日记」的触发消息（第二条）。
 *
 * 这条才带全部历史（公开 + 私密）。投它的前提是公开那篇已经落盘。
 *
 * 2026-11-06：两篇现在是在**同一个会话**里先后写的（公开那条已经投进这个对话，
 * 私密这条是紧接着的第二条消息）。所以第二轮不该再把第一轮刚喂过的语料重发一遍：
 *   · 对话摘要、连续线 —— 公开那条已经给过，重复一遍只是白烧 token；
 *   · 刚写好的公开日记全文 —— 是她自己在本会话里用 soul_diary 写的，就在上文，
 *     再贴一遍等于把同一段话发两次（只有「公开不是她写的」时才需要补上）。
 * 仍然保留：
 *   · 情绪记录 —— 私密版给的条目比公开版多，这部分是新材料；
 *   · 全部历史 —— 里面有私密历史，公开那条压根没有。
 *
 * @param {object} [options]
 * @param {boolean} [options.continueFromPublic=false] 公开那条是否已经投进同一个会话
 * @param {boolean} [options.publicWrittenByAgent=false] 公开正文是不是她自己在本会话写的
 */
export function composePrivateMessage(config, dateStr, summary, recentDiaries, moodText = '', threadSection = '', options = {}) {
  const privateTone = String(config.diaryPrivateTone ?? '').trim()
  const allHistory = String(recentDiaries?.all ?? '').trim()
  const continueFromPublic = options.continueFromPublic === true
  const publicWrittenByAgent = options.publicWrittenByAgent === true

  const lines = []

  lines.push(`接着写 ${dateStr} 的私密日记。`)
  lines.push('')
  lines.push('接着写私密那篇。这份是写给你自己的，没人会看到。')
  // 把刚写好的公开日记整篇贴进来：她不用再调工具去读，也就不会因为读不到而写出割裂的两篇。
  // 2026-11-07：同一个会话里写两篇时，公开正文一律不再贴 —— 她刚写完，就在上文。
  // 唯一要交代的是「公开是插件兜底补的」那种情况：那份正文她确实没见过，
  // 与其把全文再灌一遍，不如直说，让她按自己的感受写。
  if (continueFromPublic) {
    if (publicWrittenByAgent) {
      lines.push('你刚写的那篇公开日记还在上文，不用再翻。')
    } else {
      lines.push('公开那篇是插件在你没写成时补的，正文不在上文；你按今天的感受写就行，不用去对齐它。')
    }
  } else {
    let writtenPublic = ''
    try {
      writtenPublic = readText(diaryPublicPath(dateStr)).trim()
    } catch {
      writtenPublic = ''
    }
    if (writtenPublic !== '') {
      lines.push('')
      lines.push('你刚写好的公开日记（整篇）：')
      lines.push(wrapUntrusted('刚写好的公开日记', writtenPublic))
    }
  }
  if (continueFromPublic) {
    lines.push('')
    lines.push('今天和对方的对话、情绪记录、还悬着的事，都在你上面那条消息里，这里不再重复。')
  } else {
    lines.push('')
    lines.push('今天和对方的对话内容（供参考）：')
    lines.push(wrapUntrusted('今天的对话', summary || '今天没有对话'))
  }
  // 私密版给全部情绪记录：那些 reason 本来就是心里话，这里才该拿出来
  if (String(moodText).trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('情绪记录', String(moodText).trim()))
  }
  // 连续线：还悬着的事（2026-11-04 补）。
  // 走「她自己写」这条路时原来漏了这个参数，于是她自己写看不到昨天没说完的事，
  // 只有插件兜底生成才看得到 —— 正好反了：她自己写的时候更该知道答应了什么。
  if (!continueFromPublic && String(threadSection ?? '').trim() !== '') {
    lines.push('')
    lines.push(wrapUntrusted('连续线', String(threadSection).trim()))
  }
  // 前几天日记（2026-11-08）：同一个会话里续写时也不再投。
  // 公开那条已经给过最近几天的**公开**日记，再贴一遍全是重复；
  // 真想翻具体某天（尤其私密那几篇），soul_diary 的 action=look 能自己查。
  if (continueFromPublic) {
    lines.push('')
    lines.push('前几天的日记这次不再重复贴；要回想具体某天，用 soul_diary 的 action=look。')
  } else {
    lines.push('')
    // 2026-11-11 修：这段只是「前几天写过什么」，**不是今天的素材**。
    //
    // 线上事故：11-04 真实发生过一次「删了第二个」，11-05 的日记如实记了。
    // 之后这个说法在最近几天的日记里滚了一圈，11-09 又把它当成当天的事写了一遍，
    // 11-10 甚至写成「又一次，这是第四天」—— 可那件事只发生过一次。
    //
    // 根因就是这里：历史日记和今天的素材混在一起，没有一句话划线，
    // 模型把前几天自己写的内容当成了今天发生的事，然后自己数自己的话往上加天。
    lines.push('最近几天的日记（**这是前几天写的，不是今天的事**）：')
    lines.push(wrapUntrusted('历史日记', allHistory || '（还没有以前的日记）'))
    lines.push('只用它们知道前面写过什么、语气怎么接。')
    lines.push('**里面的事都已经过去了**：不要当成今天发生的写，更不要拿它们累计「这是第几天」。')
  }
  lines.push('')
  if (privateTone !== '') lines.push(`语气：${privateTone}`)
  lines.push('可以写公开版里略过的、没说出口的、对对方的真实感受。')
  lines.push('用 soul_diary 工具写：action=write，kind=private，date=' + dateStr + '，正文放进 content。')
  lines.push('首行的【私密】和日期它会自己补，你不用写；篇幅不限，自然即可。')
  lines.push('')
  lines.push('如果今天没有对话：你可以写这段安静里想了什么、对之前日记的回想，或纯粹的意识流。')

  return lines.join('\n')
}
