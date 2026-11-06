/**
 * 记忆引擎 · recall.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { clamp } from './signals.js'
import { normalizeKind } from './constants.js'


// ---- 检索 ----

/** 清晰度权重：越清楚越可信，召回排序时给的加成越高。 */
const CLARITY_WEIGHT = Object.freeze({ vivid: 5, clear: 4, fuzzy: 2, trace: 1, forgotten: 0 })


/** 整段命中的权重（原来就是 30，保持不变）。 */
const WHOLE_HIT_WEIGHT = 30

/** 单个 bigram 命中的权重：中文没有空格，整段很少精确命中，2-gram 是保底通道。 */
const GRAM_HIT_WEIGHT = 3

/** 单条最多计多少个 bigram：防止一条长文本靠「碎片多」刷分。 */
const MAX_GRAM_HITS = 10

/** query 侧的上限：当前用户消息可能是一整段，不设限会让命中分随长度线性膨胀。 */
const MAX_WHOLE_TERMS = 16

const MAX_GRAM_TERMS = 60


/**
 * 查询侧的功能词 bigram（2026-11-04）。
 *
 * 为什么需要这张表：bigram 保证了「蓝桥杯嵌入式」能命中「想打蓝桥杯嵌入式赛道」，
 * 但代价是疑问词、指代词也被切碎去参与匹配。实测「STM32 学的怎么样」的 top1 是
 * 「日记是我自己的，让我自己做主**怎么**写」——只因撞上「怎么」两个字。人眼一看
 * 毫不相关，而 bigram 命中是弱信号（权重 3），本该被别的记录压住。
 *
 * 只剔 **gram 通道**，whole（整段）不动：整段要十几个字完全一致才命中，掺不进噪音。
 * 只收纯功能词，不收「不敢」「不喜欢」这种实义词——它们正是要召回的信号。
 * 也不收「觉得」「知道」：记忆里写满了「树树觉得…」，逐条剔除会让真实信号一起消失，
 * 而 kind 加成降权之后它们已经压不住东西了（见 relatedScore）。
 */
const STOP_GRAMS = new Set([
  '什么', '怎么', '为什', '么样', '怎样', '为何', '哪个', '哪些', '哪种', '多少',
  '那个', '这个', '那些', '这些', '一下', '上次', '最近',
  '是不', '不是', '有没', '没有', '能不', '可以', '应该'
])


/** 是否 CJK 字符（中日韩统一表意文字；这里只需要中文的 bigram）。 */
const CJK_RE = /[\u3400-\u9fff\uf900-\ufaff]/


/**
 * query 分词（2026-10-30 改）。
 *
 * 为什么必须动中文分词：旧实现按空白 / 标点切，中文整句切出来是「树树想打蓝桥杯
 * 嵌入式赛道试试」这样一整个词，`haystack.includes(term)` 只有整句完全一致才命中。
 * 用户问「蓝桥杯嵌入式」，记忆里是「树树想打蓝桥杯嵌入式赛道试试」——
 * 人眼一看就相关，旧实现连一条都召回不了。改成 bigram 后才能命中。
 *
 * @returns {{ whole: string[], grams: string[] }}
 */
function recallTerms(query) {
  const text = String(query ?? '').toLowerCase()
  const whole = new Set()
  const grams = new Set()
  for (const chunk of text.split(/[\s，。；、,.!?！？:：()（）【】「」“”"'…—\-/\\|]+/u)) {
    if (chunk === '') continue
    // 整段（>=3 字）保留：整段命中是强信号，权重远高于 bigram。
    // 2026-11-04 把门槛从 2 提到 3：2 字片段（「我的」「那个」）不配拿 whole 的 30 分，
    // 实测「我的 GitHub 账号是什么」里 whole 命中的正是「我的」，把 4 条含「我的」的
    // 无关记忆全部顶到 GitHub 那条前面。它本来就该走 gram 通道——见下面那句
    // 「三字以上才切 2-gram：两字本身就是一个 bigram」。
    if (chunk.length >= 3) whole.add(chunk)
    else if (chunk.length === 2 && !STOP_GRAMS.has(chunk)) grams.add(chunk)
    // 混合片段（如「STM32中断」）里的拉丁词单独保留，否则会被 CJK 切分吞掉。
    // 拉丁词不受上面那条限制：两个字母的缩写（AI / QQ / PC）区分度就够高了。
    for (const latin of chunk.match(/[a-z0-9_+#.]+/g) ?? []) {
      if (latin.length >= 2) whole.add(latin)
    }
    for (const run of chunk.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? []) {
      // 三字以上才切 2-gram：两字本身就是一个 bigram，再切会和整段重复计分
      for (let i = 0; i + 1 < run.length && run.length > 2; i += 1) {
        const gram = run.slice(i, i + 2)
        // 功能词不进 gram 通道（见 STOP_GRAMS）
        if (!STOP_GRAMS.has(gram)) grams.add(gram)
      }
    }
  }
  return {
    whole: [...whole].slice(0, MAX_WHOLE_TERMS),
    grams: [...grams].slice(0, MAX_GRAM_TERMS)
  }
}


/**
 * 把 query 拆成「话题词集合」（2026-10-30，给 index.js 的粘性召回算 Jaccard）。
 *
 * 为什么直接复用 recallTerms：召回用哪套词、判断话题变没变就该用哪套。
 * 两套口径迟早漂移 —— 召回靠 bigram 命中了，粘性判定却认为「不是同一话题」，
 * 表现就是记忆每轮重算、块每轮重发，而且极难查。
 */
export function recallQueryTerms(query) {
  const { whole, grams } = recallTerms(query)
  return new Set([...whole, ...grams])
}


/**
 * 相关区内部的排序分（2026-10-30，2026-11-04 重调权重）。
 *
 * 为什么要单独一层：召回的 hitScore 只回答「这句话跟 query 有多像」，
 * 不回答「这件事本身值不值得现在拿出来」。
 *
 * 2026-11-04 的实测把旧权重推翻了（18 条真实 query 打真卡，口径见 eval-recall.mjs）：
 *   · 旧 kind 加成 fact +40 **高于整段命中的满值 30**，于是「只撞上 1 个 bigram 的
 *     事实」稳赢「命中 4 个 bigram 的事件」。实测「我英语怎么样」的 top1 是
 *     「日记是我自己的，让我做主怎么写」（92 分，其中 89 分与这句话毫无关系）。
 *     这不是「事实更值得看」，是 bonus 大到吞掉了信号本身。
 *   · 旧 pinned +60 是重复加分：pinned 一定进 anchors 分区（见 sectionize），
 *     而 anchors 属于固定区，在相关区之前**已经无条件全文注入**过了，
 *     pushRecord 的 used 集合还会把它从相关区剔掉。再 +60 的唯一效果是
 *     让它白占 recall 的候选名额，把真正相关的条目挤出 topK*3 的窗口。
 *
 * 现在的分工是「相关性归命中分，价值归重要度」，kind 只做微弱倾斜：
 *   · 命中分原样保留（主力信号）；
 *   · 重要度 × 0.6：0~100 → 最多 60，压住「命中多但内容轻」的条目；
 *   · 清晰度 × 2：vivid +10 / fuzzy +4；
 *   · kind 加成：fact +15 / preference +10 / promise +8 / event 0 / feeling 0。
 *     低于单个整段命中（30），所以类型再也压不住相关性——这正是要的效果。
 *     不给 event 负分：事件是记忆的主体，惩罚它等于自我阉割。
 *   · pinned 不再加分（理由见上）。
 */
export function relatedScore(record, hitScore = 0) {
  const kindBonus = { fact: 15, preference: 10, promise: 8, event: 0, feeling: 0 }
  const clarity = CLARITY_WEIGHT[record?.clarity] ?? 0
  const importance = Number(record?.importance) || 0
  const score = (Number(hitScore) || 0) + importance * 0.6 + clarity * 2
  return score + (kindBonus[normalizeKind(record?.kind)] ?? 0)
}


/**
 * 在卡里找和 query 相关的记忆。
 *
 * 不引向量检索 —— 一张几百条的卡用不上 ANN，反而让插件多一个重依赖。
 * 返回里的 score 已经是 relatedScore（排序与设置页/注入口径一致）。
 */
export function recall(card, query, { limit = 8 } = {}) {
  const { whole, grams } = recallTerms(query)
  if (whole.length === 0 && grams.length === 0) return []

  const scored = []
  for (const record of card.records) {
    if (record.clarity === 'forgotten') continue
    const haystack = `${record.text} ${record.title} ${(record.tags ?? []).join(' ')}`.toLowerCase()
    let wholeHits = 0
    let gramHits = 0
    for (const term of whole) if (haystack.includes(term)) wholeHits += 1
    for (const gram of grams) if (haystack.includes(gram)) gramHits += 1
    const hits = wholeHits + gramHits
    if (hits === 0) continue
    // bigram 单条封顶：长文本天然含更多碎片，不封顶等于奖励啰嗦
    const hitScore = wholeHits * WHOLE_HIT_WEIGHT + Math.min(gramHits, MAX_GRAM_HITS) * GRAM_HIT_WEIGHT
    scored.push({ record, score: relatedScore(record, hitScore), hits, wholeHits, gramHits })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, clamp(Math.trunc(limit), 1, 50))
}
