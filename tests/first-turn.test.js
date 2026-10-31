// 首轮判断（isFirstTurnOfSession）—— 2026-10-31
//
// 这一条必须单独测：上一版就是靠 mock 跑过去的（mock 没有 snapshotEvents，
// 走了「读不到就当第一轮」的兜底），结果线上每轮都被判成第一轮，白改。
// 所以这里的 mock 要**照着真实的 session 形状**来：有 seq、有 header.id、
// snapshotEvents(from, to) 是半开区间。

import assert from 'node:assert/strict'
import { isFirstTurnOfSession } from '../lib/index.js'

function makeSession(id, events, seq) {
  return {
    seq,
    header: { id },
    snapshotEvents(from, to) {
      return events.filter((event) => Number(event.seq) >= from && Number(event.seq) < to)
    }
  }
}

const userEvent = (seq, sourceKind = 'user') => ({ seq, type: 'user/message', source: { kind: sourceKind } })
const assistantEvent = (seq) => ({ seq, type: 'assistant/message' })
const runtimeEvent = (seq) => ({ seq, type: 'user/message', source: { kind: 'runtime-context' } })

const cases = []
const test = (name, run) => cases.push({ name, run })

test('新会话只有一条人话 → 第一轮', () => {
  const events = [userEvent(1)]
  const session = makeSession('a', events, 1)
  assert.equal(isFirstTurnOfSession({ session }), true)
})

test('第二轮已经出现 → 不是第一轮', () => {
  const events = [userEvent(1), assistantEvent(2), userEvent(3)]
  const session = makeSession('b', events, 3)
  assert.equal(isFirstTurnOfSession({ session }), false)
})

test('运行时快照不算人话', () => {
  const events = [runtimeEvent(1), userEvent(2), assistantEvent(3)]
  const session = makeSession('c', events, 3)
  assert.equal(isFirstTurnOfSession({ session }), true)
})

test('同一轮里多次装配，判断不变', () => {
  const events = [userEvent(1), assistantEvent(2)]
  const session = makeSession('d', events, 2)
  assert.equal(isFirstTurnOfSession({ session }), true)
  assert.equal(isFirstTurnOfSession({ session }), true)
  assert.equal(isFirstTurnOfSession({ session }), true)
})

test('增量游标：第二轮出现后立刻转为 false', () => {
  const events = [userEvent(1), assistantEvent(2)]
  const session = makeSession('e', events, 2)
  assert.equal(isFirstTurnOfSession({ session }), true)
  events.push(userEvent(3))
  session.seq = 3
  assert.equal(isFirstTurnOfSession({ session }), false)
})

test('长会话：后面的轮次不会因为窗口看不到开头而误判成第一轮', () => {
  const events = []
  for (let i = 1; i <= 400; i += 1) {
    events.push(i % 2 === 1 ? userEvent(i) : assistantEvent(i))
  }
  const session = makeSession('f', events, 400)
  assert.equal(isFirstTurnOfSession({ session }), false)
})

test('拿不到 session → 当第一轮（宁可多注入一次）', () => {
  assert.equal(isFirstTurnOfSession(undefined), true)
  assert.equal(isFirstTurnOfSession({}), true)
})

test('没有 seq 的会话 → 当第一轮', () => {
  assert.equal(isFirstTurnOfSession({ session: { header: { id: 'g' } } }), true)
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
