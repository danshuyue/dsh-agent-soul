/**
 * 遗忘档案测试：node tests/archive.test.js
 *
 * 守着一句 README 承诺：**「忘了不是删掉，是先变得说不清；archive.jsonl 里能查回来。」**
 *
 * 2026-10-29 之前这句话只有 1/4 是真的：四条删除路径（自然衰减 / 设置页删除 /
 * 她自己忘掉 / 容量压缩）只有「自然衰减」那条会写档案，另外三条都是硬删 ——
 * 用户点了删除、或者程序自己腾空间删的，事后完全查不到丢了什么。
 *
 * 这个文件把另外三条也钉住，顺便钉住「被回想起来的记忆要刷新」这一条。
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-archive-'))

const memory = await import('../lib/memory.js')

/** 塞满一张卡（清晰度全打到 trace，压缩时一击即删）。 */
function makeFullCard(count = 60) {
  const card = memory.createCard('global')
  const cfg = { injectMaxChars: 800, warnChars: 800 }
  for (let i = 0; i < count; i += 1) {
    memory.addRecord(
      card,
      { text: `第 ${i} 条：这是一条用来把记忆卡塞满的测试数据，故意写长一点让压缩更容易触发`, isOwner: true, isPrivate: true },
      cfg,
      Date.now() - i * 1000
    )
  }
  for (const record of card.records) record.clarity = 'trace'
  return card
}

console.log('容量压缩：挤掉的要进档案')

const card = makeFullCard()
const compacted = []
const steps = memory.compactCard(card, { injectMaxChars: 800, warnChars: 800 }, {
  archive: (record, reason) => compacted.push({ text: record.text, reason })
})
ok(steps > 0, `压缩确实删了记录（${steps} 步）`)
ok(compacted.length > 0, `挤掉的都进了档案（${compacted.length} 条）`)
ok(compacted.every((item) => item.reason === 'compact'), '档案里的理由是 compact')
ok(compacted.every((item) => typeof item.text === 'string' && item.text !== ''), '档案里带着原文，能查回来')

console.log('容量压缩：不传 archive 时照样能工作（向后兼容）')

const card2 = makeFullCard()
const steps2 = memory.compactCard(card2, { injectMaxChars: 800, warnChars: 800 })
ok(steps2 > 0, '不传 archive 也能压缩（老调用方不受影响）')

console.log('手动删除：设置页 / 她自己忘，都要进档案')

const card3 = memory.createCard('global')
const added = memory.addRecord(
  card3,
  { text: '明天要把戴维南那三道题做完', isOwner: true, isPrivate: true },
  { injectMaxChars: 2400 },
  Date.now()
)
ok(added.ok === true, '先写进一条')
const manual = []
const removed = memory.forgetRecord(card3, added.record.id, (record, reason) => manual.push(reason))
ok(removed !== null, '删掉了')
ok(card3.records.length === 0, '卡里确实没了')
ok(manual.length === 1 && manual[0] === 'manual-forget', '档案里留下一条 manual-forget 记录')

console.log('被回想起来：要刷新时间、召回 +1、清晰度回升')

const card4 = memory.createCard('global')
const one = memory.addRecord(
  card4,
  { text: '她说想学会用示波器看时序', isOwner: true, isPrivate: true },
  { injectMaxChars: 2400 },
  Date.now() - 86400000
)
const beforeClarity = one.record.clarity
one.record.clarity = 'fuzzy'
const touched = memory.touchRecords(card4, [one.record.id], Date.now())
ok(touched === 1, 'touchRecords 改动了这条')
const after = card4.records[0]
ok(after.recallCount >= 1, '召回次数 +1')
ok(after.clarity !== 'fuzzy', `清晰度回升（fuzzy → ${after.clarity}）`)
ok(typeof after.lastSeenAt === 'string' && after.lastSeenAt !== '', 'lastSeenAt 被更新')
ok(beforeClarity !== undefined, '（原始清晰度字段存在）')

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
if (failed > 0) process.exit(1)
