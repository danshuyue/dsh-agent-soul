/**
 * R01 · T3 card.rev 观测回归：node tests/r01-card-rev.test.js
 *
 * 规则（03 答复 §4.1）：一个 rev 增量 = 一次成功持久化。
 *   createCard → 0；mergeCards → max(a,b)（不 +1）；写盘成功 → +1；
 *   写盘失败 → 回退到写盘前的值；老卡没有字段 → 读作 0。
 *
 * REDGREEN：把 card-io.js 里 `card.rev = beforeRev + 1` 临时删掉，
 * ① / ⑦ 会变红；恢复后全绿。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r01-rev-'))
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
const { globalMemoryPath, __setAtomicWriteFailureForTest, ensureDirs } = await import('../lib/paths.js')
const { cardCache } = await import('../lib/state/cache.js')
const { saveGlobalCard } = await import('../lib/state/cards.js')
const { __resetNoteThrottleForTest } = await import('../lib/env.js')
ensureDirs()

const NOW = Date.parse('2026-11-06T12:00:00Z')
const logPath = join(sandbox, 'agents', 'soul.log')
const readLog = () => { try { return readFileSync(logPath, 'utf8') } catch { return '' } }
const diskRev = () => JSON.parse(readFileSync(globalMemoryPath(), 'utf8')).rev
const writeDisk = (card, file = globalMemoryPath()) => writeFileSync(file, `${JSON.stringify(card, null, 2)}\n`, 'utf8')
const rec = (id) => ({
  id, text: `记录 ${id}：用来验证 rev 的测试记忆，内容写长一点`, title: id,
  importance: 30, kind: 'event', clarity: 'clear', tags: [],
  createdAt: new Date(NOW).toISOString(), lastSeenAt: new Date(NOW).toISOString(),
  recallCount: 0, pinned: false, isInitial: false, source: 'test', scope: 'global'
})
/** 造一次「盘上被别的进程改过」的场景，逼 saveCardMerged 走合并分支。 */
function forceMerge(ours, disk) {
  writeDisk(disk)
  cardCache.set('global', { stamp: 1, value: ours }) // 故意与真实 mtime 不同
}

// ---------------------------------------------------------------------------
console.log('① 新建卡 rev=0；写一次盘 +1；再写 +1')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'agents', 'memory', 'plain.json')
  const card = memory.createCard('global', NOW)
  eq(card.rev, 0, '①a 新卡 rev === 0')
  eq(memory.saveCard(file, card).ok, true, '①b 第一次写盘成功')
  eq(card.rev, 1, '①c 内存 rev === 1')
  eq(JSON.parse(readFileSync(file, 'utf8')).rev, 1, '①d 盘上 rev === 1')
  eq(memory.saveCard(file, card).ok, true, '①e 第二次写盘成功')
  eq(card.rev, 2, '①f 内存 rev === 2')
  eq(JSON.parse(readFileSync(file, 'utf8')).rev, 2, '①g 盘上 rev === 2')
}

// ---------------------------------------------------------------------------
console.log('② 写盘失败 → rev 不递增')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'agents', 'memory', 'fail.json')
  const card = memory.createCard('global', NOW)
  __resetNoteThrottleForTest()
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: 'ENOSPC (injected)' }))
  let saved
  try { saved = memory.saveCard(file, card) } finally { __setAtomicWriteFailureForTest(null) }
  eq(saved.ok, false, '②a 明确返回失败')
  eq(card.rev, 0, '②b rev 回退到写盘前的值（没有「rev 变了但盘上没变」）')
  ok(readLog().includes('rev 已回退到 0') === true, '②c 日志写清了回退值')
}

// ---------------------------------------------------------------------------
console.log('③ / ⑦ 合并 + 写盘成功：rev === max(disk, ours) + 1，日志含两个旧值')
// ---------------------------------------------------------------------------
{
  const disk = { ...memory.createCard('global', NOW), rev: 7, records: [rec('disk-1')] }
  const ours = { ...memory.createCard('global', NOW), rev: 5, records: [rec('ours-1')] }
  forceMerge(ours, disk)
  const result = saveGlobalCard(ours)
  eq(result.ok, true, '③a 写盘成功')
  eq(result.card.rev, 8, '③b 新 rev === max(7,5) + 1（严格等于，不是 9 也不是 7）')
  eq(diskRev(), 8, '③c 盘上 rev === 8')
  ok(result.card.records.length >= 2, '③d 合并结果没被 rev 改动（并集仍在）')
  const log = readLog()
  ok(log.includes('盘上 rev=7 比内存 rev=5 新') === true, '③e 日志同时出现两个旧值')
  // 2026-11-06 R03 顺手修：原来断言的是「整个日志里不含 "77"」——
  // 只要别的日志行（`启动 pid=…`、随机 id、时间戳）里恰好有 77，这条就会假红。
  // 改成只看 rev 相关的那一行。
  const revLines = log.split('\n').filter((line) => line.includes('盘上 rev='))
  ok(revLines.length > 0 && revLines.every((line) => !line.includes('rev=77')),
    '③f 没有字符串拼接出来的 "77"（只看 rev 相关的日志行）')
}

// ---------------------------------------------------------------------------
console.log('④ 老卡（无 rev 字段）读作 0，写盘后 1')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'agents', 'memory', 'legacy.json')
  const legacy = memory.createCard('global', NOW)
  delete legacy.rev
  writeFileSync(file, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8')
  const loaded = memory.loadCard(file)
  eq(loaded.rev, 0, '④a 老卡读进来 rev === 0')
  eq(memory.saveCard(file, loaded).ok, true, '④b 写盘成功')
  eq(loaded.rev, 1, '④c 写盘后 rev === 1')
  eq(JSON.parse(readFileSync(file, 'utf8')).rev, 1, '④d 盘上 rev === 1')
}

// ---------------------------------------------------------------------------
console.log('⑤ mergeCards 本身不 +1（R05 之前只做观测）')
// ---------------------------------------------------------------------------
{
  const a = { ...memory.createCard('global', NOW), rev: 3, records: [rec('a-1')] }
  const b = { ...memory.createCard('global', NOW), rev: 9, records: [rec('b-1')] }
  const m = memory.mergeCards(a, b)
  eq(m.card.rev, 9, '⑤a mergeCards 取 max，不是 max+1')
  ok(m.card.records.length >= 2, '⑤b 没有按 rev 丢弃任何记录（不是 LWW）')
}

// ---------------------------------------------------------------------------
console.log('⑥ 合并 + 写盘失败：盘上 rev 不变，内存 rev 回退到 max(a,b)')
// ---------------------------------------------------------------------------
{
  const disk = { ...memory.createCard('global', NOW), rev: 7, records: [rec('disk-2')] }
  const ours = { ...memory.createCard('global', NOW), rev: 5, records: [rec('ours-2')] }
  forceMerge(ours, disk)
  __resetNoteThrottleForTest()
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: 'ENOSPC (injected)' }))
  let result
  try { result = saveGlobalCard(ours) } finally { __setAtomicWriteFailureForTest(null) }
  eq(result.ok, false, '⑥a 写盘失败明确返回 ok:false')
  eq(result.card.rev, 7, '⑥b 内存 rev 回退到合并后的 max(7,5)，不是 8 也不是 5')
  eq(diskRev(), 7, '⑥c 盘上 rev 仍是 7（没被写坏）')
  ok(readLog().includes('盘上 rev=7 比内存 rev=5 新') === true, '⑥d 合并观测日志照常留下')
}

// ---------------------------------------------------------------------------
console.log('ADV-9 disk.rev = 2^31 不溢出 / ADV-10 字符串 "7" 按数字处理')
// ---------------------------------------------------------------------------
{
  const huge = 2 ** 31
  const m = memory.mergeCards(
    { ...memory.createCard('global', NOW), rev: 1 },
    { ...memory.createCard('global', NOW), rev: huge }
  )
  eq(m.card.rev, huge, 'ADV-9a 合并后仍是 2^31，没有溢出成负数')
  const file = join(sandbox, 'agents', 'memory', 'huge.json')
  memory.saveCard(file, m.card)
  ok(Number.isSafeInteger(m.card.rev) && m.card.rev > 0, `ADV-9b 写盘后 +1 仍是安全正整数（${m.card.rev}）`)

  const disk = { ...memory.createCard('global', NOW), rev: '7', records: [rec('disk-3')] }
  const ours = { ...memory.createCard('global', NOW), rev: 5, records: [rec('ours-3')] }
  forceMerge(ours, disk)
  const r = saveGlobalCard(ours)
  eq(r.card.rev, 8, 'ADV-10a 字符串 "7" 按数字处理，max(7,5)+1 = 8')
  const log = readLog()
  ok(log.includes('盘上 rev=7 比内存 rev=5 新') === true, 'ADV-10b 日志里是 7，不是 "77"')
}

// ---------------------------------------------------------------------------
console.log('ADV-11 写盘失败后紧接着读盘：日志能说清内存与磁盘不一致')
// ---------------------------------------------------------------------------
{
  const file = join(sandbox, 'agents', 'memory', 'mismatch.json')
  const card = { ...memory.createCard('global', NOW), rev: 4 }
  writeDisk(card, file)
  const inMemory = { ...card, rev: 6 }
  __resetNoteThrottleForTest()
  __setAtomicWriteFailureForTest(() => ({ ok: false, error: 'EACCES (injected)' }))
  try { memory.saveCard(file, inMemory) } finally { __setAtomicWriteFailureForTest(null) }
  const onDisk = memory.loadCard(file)
  eq(inMemory.rev, 6, 'ADV-11a 内存 rev 回退到写盘前的 6')
  eq(onDisk.rev, 4, 'ADV-11b 磁盘 rev 仍是 4')
  ok(inMemory.rev !== onDisk.rev, 'ADV-11c 确实存在不一致（这正是要能被日志说明的情况）')
  ok(readLog().includes('rev 已回退到 6') === true, 'ADV-11d 失败日志带具体 rev 值')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) process.exit(1)
