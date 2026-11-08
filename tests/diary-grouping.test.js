// 日记对话分组（2026-11-08）：工作区 → 会话 → 时间
//
// 以前的流水是一条时间线到底，几个对话交错在一起读不出上下文。
// 这里锁两件事：① groupSessions 的分组与排序；② 挑完之后拼出来的文本带分组标题。

import assert from 'node:assert/strict'
import { groupSessions, workspaceLabel, stampOf } from '../lib/core/session-groups.js'
import { pickConversation } from '../lib/core/diary-pick.js'

const t = (h, m = 0) => new Date(2026, 10, 8, h, m, 0, 0).getTime()

const cases = []
const test = (name, run) => cases.push({ name, run })

test('按工作区分块，块内按会话分节', () => {
  const rows = [
    { t: t(9), role: 'user', text: '改插件那边说的第一句', wd: 'D:\\DSH workspace\\work', sid: 's1' },
    { t: t(10), role: 'user', text: 'QQ 那边的第一句', wd: 'D:\\DSH workspace\\QQ对话', sid: 'q1' },
    { t: t(11), role: 'user', text: '改插件那边说的第二句', wd: 'D:\\DSH workspace\\work', sid: 's1' },
    { t: t(12), role: 'user', text: '闲聊那边的第一句', wd: 'D:\\DSH workspace\\work', sid: 's2' }
  ]
  const groups = groupSessions(rows)
  assert.equal(groups.length, 3, '两个工作区、三个会话 → 三组')
  assert.equal(groups[0].wd, 'D:\\DSH workspace\\work')
  assert.equal(groups[0].index, 1, 'work 里第一个会话编号 1')
  assert.equal(groups[1].sid, 's2', '同一工作区里按首条时间排')
  assert.equal(groups[2].wd, 'D:\\DSH workspace\\QQ对话', '按工作区首次出现时间排在后面')
  assert.equal(groups[2].index, 1, '每个工作区各自从 1 编号')
})

test('没标工作区/会话的老流水落到「未标注」', () => {
  const groups = groupSessions([{ t: t(9), role: 'user', text: '老数据' }])
  assert.equal(groups.length, 1)
  assert.equal(workspaceLabel(groups[0].wd), '未标注工作区')
  assert.equal(groups[0].index, 1)
})

test('workspaceLabel 取最后一段目录', () => {
  assert.equal(workspaceLabel('D:\\DSH workspace\\work'), 'work')
  assert.equal(workspaceLabel('/home/a/b'), 'b')
  assert.equal(workspaceLabel(''), '未标注工作区')
})

test('stampOf：坏时间戳给占位', () => {
  assert.equal(stampOf(t(9, 5)), '09:05')
  assert.equal(stampOf(0), '--:--')
})

test('挑完之后拼出来的文本带工作区与会话标题，且同会话不被打断', () => {
  const rows = [
    { t: t(9), role: 'user', text: '今天回宿舍的路上下了点雨，有点冷', wd: 'D:\\DSH workspace\\work', sid: 's1' },
    { t: t(10), role: 'user', text: '晚上吃的是面条，挺香的', wd: 'D:\\DSH workspace\\QQ对话', sid: 'q1' },
    { t: t(11), role: 'assistant', text: '那你早点回去，别冻着', wd: 'D:\\DSH workspace\\work', sid: 's1' }
  ]
  const picked = pickConversation(rows, { maxChars: 5000 })
  assert.ok(picked.text.includes('## 工作区：work'), '要有工作区标题')
  assert.ok(picked.text.includes('## 工作区：QQ对话'), '第二个工作区也要有标题')
  assert.ok(picked.text.includes('### 对话 1'), '要有会话小节')

  // 同一个会话的两条应该连在一起，中间不夹别的会话
  const lines = picked.text.split('\n')
  const i1 = lines.findIndex((l) => l.includes('回宿舍的路上'))
  const i2 = lines.findIndex((l) => l.includes('别冻着'))
  const between = lines.slice(i1 + 1, i2)
  assert.ok(!between.some((l) => l.includes('面条')), '别的会话不能插在同一会话中间')
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
