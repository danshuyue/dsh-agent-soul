/**
 * recall-visibility.test.js —— 长寿会话里「想起来了」不许被自己去重掐死
 * （2026-11-01，审计 D12）
 *
 * 旧行为：recallSeenBySession 一个会话内只增不减，候选池又只有 topK*4 = 8 条。
 * 结果聊到后半段，"相关但说过"的记录把池子占满，这一段就再也出不来 ——
 * 而日志里什么都不说，表现只是「她后半段变冷淡了」。
 *
 * 这里守三件事：候选池够大、blocked 能如实报出来、连续多轮不枯竭。
 */
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-recall-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory'), { recursive: true })

const mem = await import('../lib/memory.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

const QUERY = '蓝桥杯嵌入式赛道怎么准备'
const card = mem.createCard('global')
for (let i = 0; i < 20; i += 1) {
  mem.addRecord(card, { text: `蓝桥杯嵌入式赛道准备计划第 ${i} 号` }, {}, Date.now() - i * 1000)
}
const cards = [card]

console.log('\n① 一轮能召回，blocked 为 0')
{
  const r = mem.renderRecallOnly(cards, { config: {}, query: QUERY, exclude: new Set() })
  ok(r.text.includes('想起来了'), '有「想起来了」段')
  eq(r.keys.length, 2, '一次取 2 条（topK 默认 2）')
  eq(r.blocked, 0, '没有东西被挡住')
}

console.log('\n② 全被 exclude 挡住时，blocked 如实报出来')
{
  const all = card.records.map((r) => r.text)
  const r = mem.renderRecallOnly(cards, { config: {}, query: QUERY, exclude: new Set(all) })
  eq(r.text, '', '空段')
  ok(r.blocked > 0, `blocked 报出被打掉的数量（${r.blocked}）`)
}

console.log('\n③ 连续多轮不枯竭（旧的 8 条池子到第 4~5 轮就没了）')
{
  const seen = new Set()
  let rounds = 0
  while (rounds < 12) {
    const r = mem.renderRecallOnly(cards, { config: {}, query: QUERY, exclude: seen })
    if (r.text === '') break
    for (const key of r.keys) seen.add(key)
    rounds += 1
  }
  ok(rounds >= 8, `连着 ${rounds} 轮都还能想起来（20 条记录最多 10 轮）`)
  ok(rounds * 2 >= 16, '召回到的条数远超旧版的 8 条候选池')
}

console.log('\n④ 真的没有相关记忆时既空、blocked 也为 0（别让调用方白重试一遍）')
{
  const r = mem.renderRecallOnly(cards, { config: {}, query: '完全不搭边的话题甲乙丙丁', exclude: new Set() })
  eq(r.text, '', '没有相关记忆')
  eq(r.blocked, 0, '不是被挡住，是真的没有')
}

console.log('\n⑤ 候选池必须严格大于去重窗口（16 条挡光之后仍要有东西）')
{
  // 复审指出的问题：池子改成 topK*8 = 16，而调用方的去重窗口也是 16，
  // 于是第 17 条以后永远摸不到 —— 只是从"想不起来"变成"反复回忆同样 16 条"。
  const blocked16 = card.records.slice(0, 16).map((r) => r.text)
  const r = mem.renderRecallOnly(cards, { config: {}, query: QUERY, exclude: new Set(blocked16) })
  ok(r.text !== '', '挡掉 16 条之后仍然召回到了东西')
  ok(r.keys.every((k) => !blocked16.includes(k)), '召回到的确实是窗口之外的那几条')
  eq(r.blocked >= 16, true, `blocked 记下了被挡的条数（${r.blocked}）`)
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
