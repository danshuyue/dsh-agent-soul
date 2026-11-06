/**
 * R01 · T1 归档失败回滚回归：node tests/r01-archive-rollback.test.js
 *
 * 钉住一件事：**归档写不进去时，记忆不能从卡里消失，统计也不能虚报**。
 * 四个入口（applyDecay / forgetRecord / compactCard 清理 forgotten /
 * compactCard 超预算）以前都是「先删后归档、不检查返回值」。
 *
 * 所有断言都写成「退回旧实现就会红」的形式。对方重放 REDGREEN 的方式是
 * 把 mutation.js 里私有函数 archiveAll 的函数体临时换成「永远当作成功」，
 * 本文件的 ①–④ 必须同时变红，恢复后全绿。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r01-archive-'))
process.env.DSH_HOME = sandbox

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const memory = await import('../lib/memory.js')
const { saveCard } = memory
const { __setAtomicWriteFailureForTest } = await import('../lib/paths.js')

const NOW = Date.parse('2026-11-06T12:00:00Z')
const LONG_AGO = new Date(NOW - 400 * 86400_000).toISOString()

/** 一条「按规则已经该被遗忘」的记录：400 天前、1 分、无保护标签。 */
function makeRecord(i, clarity = 'trace') {
  return {
    id: `r01-${i}`,
    text: `第 ${i} 条用来验证归档回滚的测试记忆，内容写长一点，避免被短文本规则干扰`,
    title: `第 ${i} 条`,
    importance: 1,
    kind: 'event',
    clarity,
    tags: [],
    createdAt: LONG_AGO,
    lastSeenAt: LONG_AGO,
    recallCount: 0,
    pinned: false,
    isInitial: false,
    source: 'test',
    scope: 'global'
  }
}

function decayCard(n = 3) {
  const card = memory.createCard('global', NOW)
  for (let i = 0; i < n; i += 1) card.records.push(makeRecord(i))
  return card
}

/** 参考 tests/archive.test.js：塞满一张卡，清晰度全打到 trace，压缩时一击即删。 */
function fullCard(count = 60) {
  const card = memory.createCard('global', NOW)
  const cfg = { injectMaxChars: 800, warnChars: 800 }
  for (let i = 0; i < count; i += 1) {
    memory.addRecord(
      card,
      { text: `第 ${i} 条：这是一条用来把记忆卡塞满的测试数据，故意写长一点让压缩更容易触发`, isOwner: true, isPrivate: true },
      cfg,
      NOW - i * 1000
    )
  }
  for (const record of card.records) record.clarity = 'trace'
  return card
}

const failArchive = () => false
const okArchive = () => true

// ---------------------------------------------------------------------------
console.log('① applyDecay · 恒失败 archiver')
// ---------------------------------------------------------------------------
{
  const card = decayCard(3)
  const before = card.records.length
  const statsBefore = Number(card.stats.forgotten) || 0
  const report = memory.applyDecay(card, {}, NOW, { force: true, archive: failArchive })
  eq(card.records.length, before, '①a 卡里记录数不变（记录还在）')
  eq(Number(card.stats.forgotten) || 0, statsBefore, '①b stats.forgotten 没有虚报')
  eq(report.forgotten.length, 0, '①c 返回的 forgotten 不含失败项')
  eq(report.changed, false, '①d 没有真实变化时 changed 为 false')
  eq(Object.keys(report).sort(), ['changed', 'forgotten'], '①e 返回键集合不变（behavior-golden 钉着它）')
}

// ---------------------------------------------------------------------------
console.log('② forgetRecord · 恒失败 archiver')
// ---------------------------------------------------------------------------
{
  const card = memory.createCard('global', NOW)
  card.records.push(makeRecord(9, 'clear'))
  const updatedBefore = card.updatedAt
  const res = memory.forgetRecord(card, 'r01-9', failArchive, NOW + 1000)
  eq(res.ok, false, '②a 返回值明确表示失败')
  eq(res.error, 'archive-failed', '②b 能与「没找到」区分')
  eq(card.records.length, 1, '②c 卡里那条仍在')
  eq(card.updatedAt, updatedBefore, '②d card.updatedAt 未变')
  const notFound = memory.forgetRecord(card, 'does-not-exist', failArchive, NOW + 1000)
  eq(notFound.error, 'not-found', '②e 没找到与归档失败是两个不同的 error')
}

// ---------------------------------------------------------------------------
console.log('③ compactCard（清理 forgotten）· 恒失败 archiver')
// ---------------------------------------------------------------------------
{
  const card = memory.createCard('global', NOW)
  card.records.push(makeRecord(1, 'forgotten'))
  card.records.push(makeRecord(2, 'clear'))
  const statsBefore = Number(card.stats.forgotten) || 0
  const ret = memory.compactCard(card, { warnChars: 100000, injectMaxChars: 20000 }, { now: NOW, archive: failArchive })
  ok(card.records.some((r) => r?.clarity === 'forgotten') === true, '③a 已遗忘那条仍在卡里')
  eq(ret, 0, '③b 返回值 0（没有真的删掉东西）')
  eq(Number(card.stats.forgotten) || 0, statsBefore, '③c 统计没有虚报')
}

// ---------------------------------------------------------------------------
console.log('④ compactCard（超预算）· 恒失败 archiver')
// ---------------------------------------------------------------------------
{
  const card = fullCard()
  const before = card.records.length
  const statsBefore = Number(card.stats.forgotten) || 0
  const ret = memory.compactCard(card, { injectMaxChars: 800, warnChars: 800 }, { now: NOW, archive: failArchive })
  eq(card.records.length, before, '④a 记录数与「失败前」一致，一条都没少')
  eq(Number(card.stats.forgotten) || 0, statsBefore, '④b stats.forgotten 只算真删掉的（这里应为 0）')
  // 返回值仍含 touched：被降档的记录是真实变化，maintain 靠 >0 决定是否存盘。
  // 若把返回值改成「只算真删掉的」，降档就永远不落盘 —— 见 REPORT §6.6。
  ok(ret > 0, `④c 返回值保留降档计数 ${ret}（不是删除数，理由见 REPORT）`)
}

// ---------------------------------------------------------------------------
console.log('⑤ 恒成功 archiver · 四处行为与改动前一致')
// ---------------------------------------------------------------------------
{
  const d = decayCard(3)
  const dr = memory.applyDecay(d, {}, NOW, { force: true, archive: okArchive })
  eq(d.records.length, 0, '⑤a applyDecay 归档成功后才删')
  eq(dr.forgotten.length, 3, '⑤b forgotten 只含成功项')
  eq(Number(d.stats.forgotten) || 0, 3, '⑤c stats.forgotten 加的是成功条数')

  const f = memory.createCard('global', NOW)
  f.records.push(makeRecord(7, 'clear'))
  const fr = memory.forgetRecord(f, 'r01-7', okArchive, NOW + 1000)
  eq(fr.ok, true, '⑤d forgetRecord 成功返回 ok:true')
  eq(f.records.length, 0, '⑤e 成功才 splice')

  const c = memory.createCard('global', NOW)
  c.records.push(makeRecord(3, 'forgotten'))
  c.records.push(makeRecord(4, 'clear'))
  const cr = memory.compactCard(c, { warnChars: 100000, injectMaxChars: 20000 }, { now: NOW, archive: okArchive })
  eq(cr, 1, '⑤f compactCard 清理 forgotten 返回真删条数')
  eq(c.records.length, 1, '⑤g 只删了那一条 forgotten')

  const b = fullCard()
  const br = memory.compactCard(b, { injectMaxChars: 800, warnChars: 800 }, { now: NOW, archive: okArchive })
  ok(br > 0, '⑤h 超预算压缩照常工作')
  ok(b.records.length < 60, `⑤i 确实腾出了空间（剩 ${b.records.length} 条）`)
}

// ---------------------------------------------------------------------------
console.log('⑥ ADV-4 · 归档成功一半（第 2 条失败）')
// ---------------------------------------------------------------------------
{
  const card = decayCard(3)
  const seen = []
  const half = (record) => {
    seen.push(record.id)
    return record.id !== 'r01-1' // 第 2 条（索引 1）失败
  }
  const report = memory.applyDecay(card, {}, NOW, { force: true, archive: half })
  eq(seen.length, 3, '⑥a 三条都尝试归档了')
  eq(card.records.map((r) => r.id), ['r01-1'], '⑥b 第 2 条留下，第 1、3 条删掉')
  eq(Number(card.stats.forgotten) || 0, 2, '⑥c 统计 = 2 条成功，不是 3 也不是 0')
  eq(report.forgotten.length, 2, '⑥d 返回只含成功项')
}

// ---------------------------------------------------------------------------
console.log('⑦ 连续 3 次归档失败 · 记录数收敛')
// ---------------------------------------------------------------------------
{
  const card = fullCard()
  const before = card.records.length
  for (let i = 0; i < 3; i += 1) {
    memory.compactCard(card, { injectMaxChars: 800, warnChars: 800 }, { now: NOW + i, archive: failArchive })
  }
  eq(card.records.length, before, '⑦ 连续失败不会每次少几条')
}

// ---------------------------------------------------------------------------
console.log('⑧ 归档失败 + 写盘失败 · 不许报成功')
// ---------------------------------------------------------------------------
{
  const card = decayCard(2)
  const before = card.records.length
  memory.applyDecay(card, {}, NOW, { force: true, archive: failArchive })
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: 'ENOSPC (injected)' }))
  let saved
  try {
    saved = saveCard(join(sandbox, 'agents', 'memory', 'global.json'), card)
  } finally {
    __setAtomicWriteFailureForTest(null)
  }
  eq(saved.ok, false, '⑧a 写盘失败明确返回 ok:false')
  eq(card.records.length, before, '⑧b 归档失败的记忆仍在内存里（没有静默丢）')
  eq(card.rev, 0, '⑧c 写盘失败时 rev 回退，没有「rev 变了但盘上没变」')
}

// ---------------------------------------------------------------------------
console.log('⑨ 归档失败留可检索日志（不带记忆正文）')
// ---------------------------------------------------------------------------
{
  let log = ''
  try { log = readFileSync(join(sandbox, 'agents', 'soul.log'), 'utf8') } catch { /* 没写出来下面的断言会红 */ }
  ok(/归档失败 \d+ 条（applyDecay\/decay）/.test(log), '⑨a 日志带条数与原因类别')
  ok(log.includes('保留在卡里等待下次重试') === true, '⑨b 日志说明后续动作')
  ok(log.includes('第 0 条用来验证归档回滚') === false, '⑨c 日志没有打记忆正文')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) process.exit(1)
