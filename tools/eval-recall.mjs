// 召回评测（真实注入路径）：走 renderRecalledBlock，看期望条目到底有没有被注入进去
//
// 为什么要有这个脚本：召回权重改一次就要重新拍一遍脑袋，「感觉更准了」不是证据。
// 这里用**本机真实的记忆卡** + 20 条模拟口语 query 打分，改权重前后各跑一次看数字。
//
// 注意：它依赖 ~/.dsh/agents/memory/global.json 这份真实数据，换台机器结果会变，
// 所以**不进 npm test**，只作本地调参工具用。耗时约 0.2 秒。
//
// 用法：
//   node tools/eval-recall.mjs            只看总分
//   node tools/eval-recall.mjs --verbose  每条 query 打出相关区实际内容
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = dirname(dirname(fileURLToPath(import.meta.url)))
const { recall, renderRecalledBlock } = await import(pathToFileURL(join(PLUGIN, 'lib', 'memory.js')).href)

const card = JSON.parse(
  readFileSync(join(homedir(), '.dsh', 'agents', 'memory', 'global.json'), 'utf8')
)

// 期望 = 记忆条目下标（可多个，命中任一即算对）
const CASES = [
  ['我的专业是什么', [0, 1]],
  ['我想做的工作方向', [3, 43]],
  ['STM32 学到什么程度了', [5]],
  ['蓝桥杯那个比赛怎么打', [6]],
  ['你叫什么名字', [25, 46]],
  ['我平时几点睡觉', [29, 49]],
  ['我玩的什么游戏', [7]],
  ['我能不能吃辣', [9]],
  ['我的 GitHub 账号是什么', [33]],
  ['我做过什么插件', [22, 35]],
  ['我为什么想早点工作', [3]],
  ['你怎么看身体这件事', [58]],
  ['我英语怎么样', [10]],
  ['社团那边怎么样', [30, 61]],
  ['我电脑开机习惯', [19, 20, 21]],
  ['机械我感兴趣吗', [2, 42]],
  ['养我这个感受', [45, 51]],
  ['熬夜这事说了什么', [29, 49]],
  ['上次那个小车比赛', []],
  ['量子计算机怎么造', []]
]

const head = (t, n = 10) => String(t ?? '').trim().slice(0, n)
const verbose = process.argv.includes('--verbose')
let h1 = 0, h3 = 0, injected = 0, pos = 0
const misses = []

for (const [q, want] of CASES) {
  const got = recall(card, q, { limit: 8 })
  const idx = got.map((x) => card.records.indexOf(x.record))
  const out = renderRecalledBlock([card], { query: q, maxChars: 3200 })
  // 相关区实际内容
  const relMatch = out.split('## 和这句话有关的')[1] ?? ''
  const related = relMatch.split('\n## ')[0] ?? ''
  // 固定区只到「和这句话有关的 / 关于你的事」之前的两个分区为止，
  // 否则兜底回填的内容会被误判成「固定区已有」
  const cut = (s, marks) => {
    let i = s.length
    for (const m of marks) { const j = s.indexOf(m); if (j >= 0 && j < i) i = j }
    return s.slice(0, i)
  }
  const fixed = cut(out, ['## 和这句话有关的', '## 关于你的事', '## 最近记得的', '## 正在模糊的'])

  // 三档：fixed = 固定区无条件注入（不算召回功劳）；related = 相关区真召回；miss = 都没有
  const inFixed = want.some((i) => fixed.includes(head(card.records[i]?.text)))
  const inRelated = want.some((i) => related.includes(head(card.records[i]?.text)))
  if (want.length > 0) {
    pos++
    if (want.includes(idx[0])) h1++
    if (idx.slice(0, 3).some((i) => want.includes(i))) h3++
    if (inRelated) injected++
    else misses.push(`${q}${inFixed ? '（固定区已有）' : ''}`)
  }
  if (verbose) {
    console.log(`\n【${q}】 ${inRelated ? '✓ 相关区命中' : '✗ 相关区没有'}`)
    for (const line of related.split('\n').filter((x) => x.startsWith('- '))) {
      console.log('   ' + line.slice(0, 46))
    }
  }
}

console.log(`\n排序指标（recall 原始）：hit@1 ${h1}/${pos}  hit@3 ${h3}/${pos}`)
console.log(`实际注入指标：相关区命中 ${injected}/${pos} (${(injected / pos * 100).toFixed(0)}%)`)
if (misses.length > 0) console.log(`相关区没进：${misses.join('、')}`)
