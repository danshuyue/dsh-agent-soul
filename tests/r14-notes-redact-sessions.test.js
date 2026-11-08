/**
 * R14 · KNOWN-ISSUES 剩余四条（2026-11-09，按 HANDOFF v0.9.8 交接）
 *
 *   #20 notes reconcile 的 changed 判据按 slug 建 Map 比较（原来按索引对位，
 *       顺序一变就恒 changed → 反复写盘 / 笔记页误报「已变更」）
 *   #21 readNote 统一走 reconcile（原来 loadIndex，文件被外部改写后
 *       返回的 chars/summary 是索引里的旧值）
 *   #15 redact 卡号判定：Luhn + 发卡前缀 + 上下文词，订单号/雪花 ID 不再误抹
 *   #2  /diary/sessions 扫盘兜底加 60s TTL 缓存（TTL 内新建的目录不出现 → 证明走了缓存）
 */
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r14-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const notes = await imp('notes.js')
const { writeNote, listNotes, reconcile, readNote, __resetNotesCacheForTest } = notes
const paths = await imp('paths.js')
const { ensureDirs, notesDir, notesIndexPath } = paths
const signals = await imp('memory/signals.js')
const { redact } = signals
const sessionsMod = await imp('http/sessions.js')
const { listDiarySessions } = sessionsMod
const { sessionsRoot } = await imp('core/registry.js')

ensureDirs()

// ---------------------------------------------------------------------------
console.log('#20 · reconcile 的 changed 判据与索引顺序无关')
// ---------------------------------------------------------------------------
{
  writeNote({ title: '甲', content: '甲的内容'.repeat(10) })
  writeNote({ title: '乙', content: '乙的内容'.repeat(10) })
  writeNote({ title: '丙', content: '丙的内容'.repeat(10) })
  __resetNotesCacheForTest()
  reconcile() // 建立基线索引（顺序 = 目录序）

  // 手工把索引文件里的条目顺序打乱（模拟「另一处改动并发写了索引」）
  const file = notesIndexPath()
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.notes.reverse()
  const shuffled = `${JSON.stringify(raw, null, 2)}\n`
  writeFileSync(file, shuffled, 'utf8')
  __resetNotesCacheForTest()

  const sizeBefore = readFileSync(file, 'utf8').length
  const result = reconcile()
  const sizeAfter = readFileSync(file, 'utf8').length
  eq(result.notes.length, 3, 'reconcile 仍返回全部三篇')
  eq(sizeAfter, sizeBefore, '纯顺序差异不触发写盘（changed=false，原来恒 true 会重写）')
  ok(readFileSync(file, 'utf8') === shuffled, '索引文件内容逐字节未动')
}

// ---------------------------------------------------------------------------
console.log('#21 · readNote 读到的是与磁盘一致的条目')
// ---------------------------------------------------------------------------
{
  const text2 = '第二版正文，比第一版长不少。'.repeat(20)
  writeFileSync(join(notesDir(), 'r14-外部改写.md'), text2, 'utf8')
  __resetNotesCacheForTest()
  reconcile() // 索引记录此刻的 chars
  // 外部把文件整个改写（长度变了，mtime 变新）
  const text3 = `${text2}追加的一段让长度明显变化的内容。`
  writeFileSync(join(notesDir(), 'r14-外部改写.md'), text3, 'utf8')
  __resetNotesCacheForTest()

  const res = readNote('r14-外部改写')
  eq(res.ok, true, 'readNote 成功')
  eq(res.note?.chars, text3.length, `chars 与磁盘一致（loadIndex 版会返回旧值 ${text2.length}）`)
}

// ---------------------------------------------------------------------------
console.log('#15 · redact：Luhn + 前缀判卡号，订单号不再误抹')
// ---------------------------------------------------------------------------
{
  eq(redact('我的银行卡是 4111111111111111 谢谢'), '我的银行卡是 [卡号] 谢谢', 'Visa 测试号（过 Luhn、4 开头）→ 照抹')
  eq(redact('订单 4111111111111112 已经发货'), '订单 4111111111111112 已经发货', '差一位不过 Luhn → 不抹（原版见 16 位就抹）')
  eq(redact('工单号 1234567890123456789 待处理'), '工单号 1234567890123456789 待处理', '1 开头的 19 位雪花 ID → 不抹（原版误抹）')
  eq(redact('卡号 1234567890123456 记一下'), '卡号 [卡号] 记一下', '不过 Luhn 但前面紧挨「卡号」→ 兜底照抹')
  // 构造一张 6 开头、过 Luhn 的银联形态卡号（6222 60xx…，尾位已按 Luhn 校正）
  const unionpay = '6222600012341232'
  eq(redact(`刷这张 ${unionpay} 付款`), `刷这张 [卡号] 付款`, '6 开头过 Luhn → 抹')
}

// ---------------------------------------------------------------------------
console.log('#2 · 扫盘兜底 60s TTL：缓存内新建的会话目录不立即出现')
// ---------------------------------------------------------------------------
{
  const cwdDir = join(sessionsRoot(), 'r14-cwd')
  const sessA = join(cwdDir, 'sess-r14-a')
  mkdirSync(sessA, { recursive: true })
  const first = listDiarySessions({}) // 无 sessions 服务 → 走扫盘兜底
  ok(first.some((s) => s.id === 'sess-r14-a'), '第一次调用扫到已存在的会话')
  // TTL 内新建一个会话目录
  mkdirSync(join(cwdDir, 'sess-r14-b'), { recursive: true })
  const second = listDiarySessions({})
  ok(!second.some((s) => s.id === 'sess-r14-b'), '60 秒内的第二次调用走缓存，不重扫（原版会扫到）')
  ok(second.some((s) => s.id === 'sess-r14-a'), '缓存里的老会话仍在')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
