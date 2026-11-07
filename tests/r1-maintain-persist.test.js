/**
 * R1 回归：maintain() 的压缩结果必须真的落盘（2026-11-06）。
 *
 * 修之前：targets 的 save 闭包是 `() => saveGlobalCard(globalCard())`。
 * applyDecay 存过一次盘后缓存被清，闭包里那次 globalCard() 重读拿到**磁盘上的旧对象**，
 * compactCard 改的那个对象被丢掉 —— 结果「归档写了一条、日志说压缩了 N 条、磁盘上还在」。
 *
 * 这个用例就是照这个过程造的：让 status 到 full 触发 compactCard，然后**从磁盘重新读**，
 * 断言磁盘上的记录确实变少了，且不存在「归档了却还在盘上」的记录。
 */
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'soul-r1-'))
process.env.DSH_HOME = home

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}`) }
}

const { addRecord } = await import('../lib/memory.js')
const store = await import('../lib/store.js')
const paths = await import('../lib/paths.js')

// atomicWrite 不会替你建父目录，先把记忆目录造出来
mkdirSync(paths.memoryDir(), { recursive: true })

console.log('造一张到顶的卡：')
{
  const card = store.globalCard()
  for (let i = 0; i < 40; i += 1) {
    addRecord(card, {
      text: `第 ${i} 条测试记忆，用来把卡撑到容量上限，内容重复但不完全一样 ${'x'.repeat(120)}`,
      importance: 30,
      kind: 'event'
    }, { maxRecords: 40 }, Date.now() - i * 1000)
  }
  ok(card.records.length === 40, `卡里 40 条（实际 ${card.records.length}）`)
  const saved = store.saveGlobalCard(card)
  ok(saved?.ok === true, '初次落盘成功')
}

console.log('跑一次 maintain（autoCompact 开）：')
{
  const before = JSON.parse(readFileSync(paths.globalMemoryPath(), 'utf8'))
  const beforeCount = before.records.length
  const report = store.maintain('', { autoCompact: true, maxRecords: 40, warnChars: 200, injectMaxChars: 400 })
  const compacted = report.compacted.find((x) => x.scope === 'global')
  ok(report.errors.length === 0, `维护无错误（${JSON.stringify(report.errors)}）`)
  ok(compacted !== undefined || report.decayed.length > 0, '维护真的做了事（压缩或衰减）')

  // 关键断言：从磁盘重读，而不是看内存
  const after = JSON.parse(readFileSync(paths.globalMemoryPath(), 'utf8'))
  const afterCount = after.records.length
  console.log(`    磁盘记录：${beforeCount} → ${afterCount}`)
  ok(afterCount <= beforeCount, `磁盘记录没有变多（${beforeCount} → ${afterCount}）`)

  // 归档里出现过的记录，不能还留在盘上（这正是修之前的现象）
  const archivePath = `${paths.memoryDir()}/archive.jsonl`
  if (existsSync(archivePath)) {
    const archived = readFileSync(archivePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
    const archivedIds = new Set(archived.map((row) => row.record?.id).filter(Boolean))
    const stillOnDisk = after.records.filter((r) => archivedIds.has(r.id))
    ok(stillOnDisk.length === 0, `归档过的记录不在盘上（仍在盘上：${stillOnDisk.length}）`)
  } else {
    // 2026-11-07 R12：这条原来是 ok(true) —— 前置条件没成立（压根没产生归档）
    // 却被当成通过。一个「验证归档」的用例在没归档时沉默，等于没测。
    ok(false, '预期这次压缩应当产生归档，但 archive.jsonl 不存在（前置条件没成立）')
  }
}

console.log('清理：')
{
  try { rmSync(home, { recursive: true, force: true }) } catch { /* 清不掉就算了 */ }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
