// 私密日记触发消息：同一会话续写时不再重复语料（2026-11-06）
//
// 背景：公开/私密两篇现在是在同一个会话里先后写的。
// 第二轮（私密）不该再把第一轮刚喂过的对话摘要、连续线、公开全文重发一遍。

import assert from 'node:assert/strict'
import { composePrivateMessage } from '../lib/diary/compose.js'

const recent = {
  public: '公开历史：昨天写了一点点',
  all: '全部历史：公开那段 + 私密那段'
}
const summary = '今天聊了插件成本和日记模块'
const mood = '- 22:00 有点累，但还是想写'
const thread = '- 答应过：12 点前睡'

const cases = []
const test = (name, run) => cases.push({ name, run })

test('默认（没有续写标记）：照旧带全部语料', () => {
  const msg = composePrivateMessage({}, '2026-11-05', summary, recent, mood, thread)
  assert.ok(msg.includes(summary), '应带对话摘要')
  assert.ok(msg.includes('12 点前睡'), '应带连续线')
  assert.ok(msg.includes(mood), '应带情绪记录')
  assert.ok(msg.includes('全部历史'), '应带全部历史')
})

test('续写（公开是她刚在本会话写的）：不复述摘要与连续线', () => {
  const msg = composePrivateMessage({}, '2026-11-05', summary, recent, mood, thread, {
    continueFromPublic: true,
    publicWrittenByAgent: true
  })
  assert.ok(!msg.includes(summary), '不该再带对话摘要')
  assert.ok(!msg.includes('12 点前睡'), '不该再带连续线')
  assert.ok(msg.includes('都在你上面那条消息里'), '应有一句「不再重复」的说明')
  assert.ok(msg.includes('还在上文'), '应指出公开那篇在上文')
})

test('续写时仍保留私密独有的材料：情绪记录 + 全部历史', () => {
  const msg = composePrivateMessage({}, '2026-11-05', summary, recent, mood, thread, {
    continueFromPublic: true,
    publicWrittenByAgent: true
  })
  assert.ok(msg.includes(mood), '情绪记录是私密独有的，必须保留')
  assert.ok(msg.includes('全部历史'), '私密历史公开那条没有，必须保留')
})

test('续写时正文规范没丢：仍要求用 soul_diary 写 kind=private', () => {
  const msg = composePrivateMessage({}, '2026-11-05', summary, recent, mood, thread, {
    continueFromPublic: true,
    publicWrittenByAgent: true
  })
  assert.ok(msg.includes('soul_diary'))
  assert.ok(msg.includes('kind=private'))
  assert.ok(msg.includes('接着写私密那篇'))
})

test('公开不是她写的（兜底生成）：一律不贴全文，只说明一声', () => {
  const msg = composePrivateMessage({}, '2026-11-05', summary, recent, mood, thread, {
    continueFromPublic: true,
    publicWrittenByAgent: false
  })
  // 没有对应文件时这段为空，但摘要那条仍然不该重复
  assert.ok(!msg.includes(summary), '摘要仍不该重复')
  assert.ok(!msg.includes('还在上文'), '不能声称正文在上文（兜底那篇她没写过）')
  assert.ok(msg.includes('正文不在上文'), '要说明那篇她没见过，别让她去找')
  assert.ok(msg.includes('不用去对齐它'), '给她自主：按自己的感受写')
})

let failed = 0
for (const { name, run } of cases) {
  try {
    run()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  ✗ ${name}\n    ${error instanceof Error ? error.message : error}`)
  }
}
console.log(`\n结果：${cases.length - failed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
