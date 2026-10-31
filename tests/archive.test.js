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
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
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

console.log('自动写入触发的压缩也要进档案（2026-10-30：addRecord 之前没传 archive）')

{
  const memoryDirPath = join(process.env.DSH_HOME, 'agents', 'memory')
  mkdirSync(memoryDirPath, { recursive: true })
  // maxRecords 在 normalizeConfig 里下限是 20（防呆），所以这里要真塞到 20 条。
  const tight = { maxRecords: 20, injectMaxChars: 600, warnChars: 600 }
  const long = '这是一条占满容量用的长记忆，故意写长一点，好让 addRecord 内部的压缩真的删掉东西。'.repeat(8)
  const card5 = memory.createCard('global')
  for (let i = 0; i < 20; i += 1) {
    memory.addRecord(card5, {
      text: `第 ${i} 条：${long}`,
      isOwner: false,
      isPrivate: true,
      importance: 5
    }, tight, Date.now() - (20 - i) * 1000)
  }
  // compactCard 一次只降一档，只有「只剩印象」的才会真删 —— 这条路径要验的是
  // 真删那一刻有没有留档，所以先把这 20 条都打到 trace。
  for (const record of card5.records) record.clarity = 'trace'
  const push = memory.addRecord(card5, {
    text: '触发 addRecord 内部压缩的那一条：写进来的时候卡已经到上限了，必须腾地方',
    isOwner: false,
    isPrivate: true,
    importance: 5
  }, tight, Date.now())
  ok(push.ok === true, '容量到顶时仍能写入新记录')

  let lines = []
  try {
    lines = readFileSync(join(memoryDirPath, 'archive.jsonl'), 'utf8').trim().split('\n').filter((line) => line !== '').map((line) => JSON.parse(line))
  } catch {
    /* 文件不存在 → lines 保持空，下面的断言会报出来 */
  }
  ok(lines.length > 0, `addRecord 挤掉的记录进了 archive.jsonl（${lines.length} 条）`)
  ok(lines.every((item) => item.reason === 'compact'), '理由与 maintain 一致：compact')
  ok(lines.every((item) => typeof item.archivedAt === 'string' && typeof item.record?.text === 'string'), '格式与 maintain 一致：{archivedAt, reason, record}')
  rmSync(join(memoryDirPath, 'archive.jsonl'), { force: true })
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
if (failed > 0) process.exit(1)
