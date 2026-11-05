// 召回评测（真实注入路径）：走 renderRecalledBlock，看期望条目到底有没有被注入进去
//
// 为什么要有这个脚本：召回权重改一次就要重新拍一遍脑袋，「感觉更准了」不是证据。
// 改权重前后各跑一次看数字，比凭感觉可靠。
//
// 2026-11-05 改成**可复现基准** —— 旧版直接读 ~/.dsh/agents/memory/global.json，
// 期望值是那张真实卡的记录下标（[3,43] / [58]），换台机器、换一次对话结果就变，
// 报告第六节的性能瓶颈因此一直「无法证明改完变好」。现在默认用内置合成卡 +
// 固定 now + 固定 limit，同一份代码在任何机器上逐字节同结果；--card 仍可读真实卡，
// 但那个模式只做计时、不报命中率（期望片段跟真实卡对不上，报了就是骗人）。
//
// 用法：
//   npm run bench:recall                          合成卡，人读指标
//   npm run bench:recall -- --json               机器可读（含 fixture / now / 指标）
//   npm run bench:recall -- --runs 20 --json      重复计时，给 mean/min/max
//   npm run bench:recall -- --scale 10000         造一万条记忆，量化全卡扫描的规模曲线
//   npm run bench:recall -- --verbose            每条 query 打出相关区实际内容
//   npm run bench:recall -- --card <path>        读真实卡，仅测耗时
//
// 不进 npm test：它是调参工具，不是回归断言（权重一改指标本来就该变）。
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { recall, renderRecalledBlock, normalizeCard } = await import(
  pathToFileURL(join(PLUGIN, 'lib', 'memory.js')).href
)

/** 固定时钟：让衰减、recentDays、排序都不依赖跑的那一刻。 */
const FIXED_NOW = Date.UTC(2026, 10, 5, 6, 0, 0)
/** 固定注入预算与召回条数，避免默认配置变动悄悄改掉基准。 */
const FIXED_CONFIG = {}
const RECALL_LIMIT = 8
const RENDER_MAX_CHARS = 3200

const argv = process.argv.slice(2)
const verbose = argv.includes('--verbose')
const asJson = argv.includes('--json')
const runsIdx = argv.indexOf('--runs')
const runs = runsIdx >= 0 ? Math.max(1, Math.min(200, Math.trunc(Number(argv[runsIdx + 1]) || 1))) : 1
const cardIdx = argv.indexOf('--card')
const cardArg = cardIdx >= 0 ? argv[cardIdx + 1] : null
// 2026-11-05：--card 不带值原来会落到 readFileSync(undefined) 直接抛栈。
// 给一句能照着抄的提示，顺便支持 ~ 开头（Windows 下 shell 不会替 node 展开）。
if (cardIdx >= 0 && (cardArg === undefined || String(cardArg).startsWith('--'))) {
  console.error('用法错误：--card 后面要跟一个记忆卡文件路径')
  console.error('示例：npm run bench:recall -- --card ~/.dsh/agents/memory/global.json')
  process.exit(2)
}
const cardFile = cardArg === null ? null
  : String(cardArg).startsWith('~') ? join(homedir(), String(cardArg).replace(/^~[/\\]?/, ''))
    : String(cardArg)
const scaleIdx = argv.indexOf('--scale')
const scale = scaleIdx >= 0 ? Math.max(1, Math.min(50_000, Math.trunc(Number(argv[scaleIdx + 1]) || 16))) : 16

/** 16 条固定记忆，每条带一个独特片段，便于精确判定命中。 */
const FIXTURE_TEXTS = [
  '我的专业是机器人工程，在烟台大学读大二',
  '目标做嵌入式工程师，偏软件方向',
  'STM32 学到定时器中断和 PWM 输出了',
  '蓝桥杯嵌入式赛道在准备第十八届',
  '她叫小薇，说话句尾带喵',
  '平时大概凌晨一点才睡',
  '在玩一款横版像素解谜游戏',
  '不吃辣，闻到辣椒就咳嗽',
  'GitHub 账号是 danshuyue',
  '写过 dsh-agent-soul 这个灵魂插件',
  '想早点工作是因为想早点经济独立',
  '英语四级还没过，打算寒假补',
  '工创赛做的是新能源小车',
  '社团那边这学期退了',
  '电脑习惯开机就挂着不关',
  '对机械结构不太感兴趣'
]

function builtinCard(n) {
  // 用 normalizeCard 而不是 addRecord：后者带近重复合并与容量逻辑，大规模时
  // 会把「我造了 N 条」悄悄变成「实际留下 M 条」，基准就没法量化规模曲线了。
  // 所有时间字段都从 FIXED_NOW 派生，保证多次运行逐字节一致。
  const records = []
  for (let i = 0; i < n; i += 1) {
    const base = FIXTURE_TEXTS[i % FIXTURE_TEXTS.length]
    const text = i < FIXTURE_TEXTS.length ? base : `${base}（补充记录 ${i}）`
    const at = new Date(FIXED_NOW - i * 3600_000).toISOString()
    records.push({
      id: `fixture-${i}`, text, title: text.slice(0, 20), importance: 60,
      clarity: 'clear', tags: [], createdAt: at, lastSeenAt: at,
      recallCount: 0, pinned: false, source: 'manual', scope: 'global'
    })
  }
  return normalizeCard({
    version: 2,
    scope: 'global',
    records,
    createdAt: new Date(FIXED_NOW).toISOString(),
    updatedAt: new Date(FIXED_NOW).toISOString(),
    lastDecayDate: null
  })
}

/** [query, 期望片段]；空片段 = 无答案，只用来观察误召回，不计入分母。 */
const CASES = [
  ['我的专业是什么', '机器人工程'],
  ['我想做的工作方向', '嵌入式工程师'],
  ['STM32 学到什么程度了', '定时器中断'],
  ['蓝桥杯那个比赛怎么打', '第十八届'],
  ['你叫什么名字', '小薇'],
  ['我平时几点睡觉', '凌晨一点'],
  ['我玩的什么游戏', '横版像素解谜'],
  ['我能不能吃辣', '不吃辣'],
  ['我的 GitHub 账号是什么', 'danshuyue'],
  ['我做过什么插件', 'dsh-agent-soul'],
  ['我为什么想早点工作', '经济独立'],
  ['我英语怎么样', '四级还没过'],
  ['上次那个小车比赛', '新能源小车'],
  ['社团那边怎么样', '这学期退了'],
  ['我电脑开机习惯', '挂着不关'],
  ['机械我感兴趣吗', '不太感兴趣'],
  ['量子计算机怎么造', ''],
  ['今天天气怎么样', '']
]

let card
if (cardFile !== null) {
  try {
    card = JSON.parse(readFileSync(cardFile, 'utf8'))
  } catch (error) {
    console.error(`读记忆卡失败：${cardFile}（${error instanceof Error ? error.message : String(error)}）`)
    process.exit(2)
  }
} else {
  card = builtinCard(scale)
}
const comparable = cardFile === null && scale === FIXTURE_TEXTS.length

const cut = (s, marks) => {
  let i = s.length
  for (const m of marks) { const j = s.indexOf(m); if (j >= 0 && j < i) i = j }
  return s.slice(0, i)
}

/** 跑一遍全部 query，返回指标；cardFile 模式跳过命中判定，只统计召回条数。 */
function evaluate() {
  let h1 = 0, h3 = 0, injected = 0, pos = 0, recalledTotal = 0
  const misses = []
  const details = []
  for (const [q, want] of CASES) {
    const got = recall(card, q, { limit: RECALL_LIMIT })
    recalledTotal += got.length
    const out = renderRecalledBlock([card], {
      query: q, maxChars: RENDER_MAX_CHARS, now: FIXED_NOW, config: FIXED_CONFIG
    })
    const relMatch = out.split('## 和这句话有关的')[1] ?? ''
    const related = relMatch.split('\n## ')[0] ?? ''
    const fixed = cut(out, ['## 和这句话有关的', '## 关于你的事', '## 最近记得的', '## 正在模糊的'])

    let hit1 = false, hit3 = false, inRelated = false, inFixed = false
    if (comparable && want !== '') {
      hit1 = String(got[0]?.record?.text ?? '').includes(want)
      hit3 = got.slice(0, 3).some((x) => String(x.record?.text ?? '').includes(want))
      inRelated = related.includes(want)
      inFixed = fixed.includes(want)
      pos++
      if (hit1) h1++
      if (hit3) h3++
      if (inRelated) injected++
      else misses.push(`${q}${inFixed ? '（固定区已有）' : ''}`)
    }
    if (verbose) {
      details.push({ query: q, want, hit1, hit3, inRelated, recalled: got.length, related })
    }
  }
  return { h1, h3, injected, pos, recalledTotal, misses, details }
}

const timings = []
let result
for (let i = 0; i < runs; i += 1) {
  const t0 = performance.now()
  result = evaluate()
  timings.push(performance.now() - t0)
}
const meanMs = timings.reduce((a, b) => a + b, 0) / timings.length
const timing = {
  runs,
  meanMs: Number(meanMs.toFixed(3)),
  minMs: Number(Math.min(...timings).toFixed(3)),
  maxMs: Number(Math.max(...timings).toFixed(3))
}

const payload = {
  fixture: cardFile ? `file:${cardFile}` : 'builtin-synthetic',
  fixedNow: FIXED_NOW,
  scale: cardFile ? null : scale,
  records: Array.isArray(card?.records) ? card.records.length : 0,
  cases: CASES.length,
  comparable,
  ...(comparable
    ? { positive: result.pos, hitAt1: result.h1, hitAt3: result.h3, injected: result.injected, misses: result.misses }
    : { note: cardFile
      ? '真实卡与内置期望片段不对应，只报耗时与召回条数，命中率不可比'
      : `--scale ${scale} 下有大量同主题补充记录，命中率不与默认基准可比，只用于规模曲线` }),
  recalledTotal: result.recalledTotal,
  timing
}

if (asJson) {
  console.log(JSON.stringify(payload, null, 2))
} else {
  console.log(`基准：${payload.fixture} / ${payload.records} 条记忆 / ${payload.cases} 条 query / now 固定为 ${new Date(FIXED_NOW).toISOString()}`)
  if (comparable) {
    console.log(`\n排序指标（recall 原始）：hit@1 ${result.h1}/${result.pos}  hit@3 ${result.h3}/${result.pos}`)
    // 2026-11-05 S3 / P3：一条 query 都没评上时 pos=0，原来会打出 Infinity%/NaN%。
    const hitRate = result.pos === 0 ? '0' : (result.injected / result.pos * 100).toFixed(0)
    console.log(`实际注入指标：相关区命中 ${result.injected}/${result.pos} (${hitRate}%)`)
    if (result.misses.length > 0) console.log(`相关区没进：${result.misses.join('、')}`)
  } else {
    console.log('\n⚠️ --card 模式只测耗时：期望片段来自内置合成卡，与真实卡不对应，命中率不可比。')
  }
  console.log(`\n耗时 ${timing.runs} 轮：mean ${timing.meanMs} ms / min ${timing.minMs} ms / max ${timing.maxMs} ms`)
  for (const d of result.details) {
    console.log(`\n【${d.query}】 ${d.inRelated ? '✓ 相关区命中' : '✗ 相关区没有'}（召回 ${d.recalled} 条）`)
    for (const line of String(d.related).split('\n').filter((x) => x.startsWith('- '))) {
      console.log('   ' + line.slice(0, 46))
    }
  }
}
