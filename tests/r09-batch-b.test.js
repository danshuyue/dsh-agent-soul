/**
 * R9 · B 批性能止血（P2-10 / P2-1 / P2-2 / P2-5 / P2-8）
 *
 * 这一批的共同特征：**不改变任何对外行为**，只是少做无用功。
 * 所以测试的重点不是「结果对不对」，而是「该省的是不是真省了」，
 * 以及「省掉之后还能不能正确降级」。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r9-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, name + (same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`))
}

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const { trimMap, touchMap } = await imp('core/lru.js')

// ---------------------------------------------------------------------------
console.log('P2-10 · 有界 Map 只淘汰最旧的，不整体清空')
// ---------------------------------------------------------------------------
{
  const map = new Map()
  for (let i = 0; i < 5; i += 1) map.set(`k${i}`, i)
  const dropped = trimMap(map, 3)
  eq(dropped, 2, '超出 2 个就淘汰 2 个')
  eq([...map.keys()], ['k2', 'k3', 'k4'], '留下的是最新的三个（不是清空）')
  ok(map.has('k4'), '最新的没被误删')

  // touch 把 key 挪到队尾 → 它就不再是最旧的
  const map2 = new Map()
  for (let i = 0; i < 3; i += 1) map2.set(`k${i}`, i)
  eq(touchMap(map2, 'k0'), true, 'touch 一个存在的键返回 true')
  trimMap(map2, 2)
  eq(map2.has('k0'), true, '被 touch 过的键逃过淘汰')
  eq(map2.has('k1'), false, '真正最旧的 k1 被淘汰')
  eq(touchMap(map2, 'nope'), false, 'touch 不存在的键返回 false')
}

// ---------------------------------------------------------------------------
console.log('P2-1 · 日志：目录/权限只准备一次，但写盘与轮转照旧')
// ---------------------------------------------------------------------------
{
  const { appendLogLine, LOG_FILE } = await imp('env.js')
  ok(appendLogLine('[t] 第一行') === true, '第一次写入成功')
  ok(appendLogLine('[t] 第二行') === true, '第二次写入成功（不再重复 mkdir/chmod）')
  const content = readFileSync(LOG_FILE(), 'utf8')
  ok(content.includes('第一行') && content.includes('第二行'), '两行都在盘上')

  // 把目录删掉 → 下一次必须自愈（状态被重置）
  rmSync(dirname(LOG_FILE()), { recursive: true, force: true })
  ok(appendLogLine('[t] 目录被删之后') === true, '目录被删后能自己重建并写入')
  ok(readFileSync(LOG_FILE(), 'utf8').includes('目录被删之后'), '内容确实写进去了')
}

// ---------------------------------------------------------------------------
console.log('P2-2 · 只取尾部窗口，长轮自动退回全量')
// ---------------------------------------------------------------------------
{
  const turns = await imp('host/runtime/turns.js')
  const mkSession = (events, seq) => ({
    header: { id: 's-p2-2' },
    seq,
    snapshotEvents(from, to) {
      if (from === undefined) return events
      return events.filter((e) => e.seq >= from && e.seq < to)
    }
  })

  // 正常：窗口里能找到 assistant 消息
  const tailEvents = [
    { type: 'assistant/message', seq: 99 },
    { type: 'user/message', seq: 100, source: { kind: 'user' } }
  ]
  const normal = mkSession(tailEvents, 100)
  ok(turns.hasHumanInputThisTurn({ session: normal }) === true, '尾部窗口里找人话（正常路径）')

  // 超长轮：窗口内没有任何 assistant 消息 → 必须退回全量，不能误判成「没人说话」
  const longEvents = [
    { type: 'assistant/message', seq: 1 },
    ...Array.from({ length: 500 }, (_, i) => ({ type: 'tool/result', seq: i + 2 })),
    { type: 'user/message', seq: 600, source: { kind: 'user' } }
  ]
  const long = mkSession(longEvents, 600)
  ok(turns.hasHumanInputThisTurn({ session: long }) === true, '超长轮能降级到全量并判对')
}

// ---------------------------------------------------------------------------
console.log('P2-5 · readRecentChat 结果缓存与失效')
// ---------------------------------------------------------------------------
{
  const feed = await imp('diary/feed.js')
  const paths = await imp('paths.js')
  const dateStr = '2026-11-06'
  const file = paths.diaryJsonlPath(dateStr)
  mkdirSync(dirname(file), { recursive: true })
  const now = Date.now()
  writeFileSync(file, `${JSON.stringify({ t: now - 5000, role: 'user', text: '第一条' })}\n`, 'utf8')

  const first = feed.readRecentChat(dateStr, 3000, '树树')
  ok(first.includes('第一条'), '第一次读到内容')
  const second = feed.readRecentChat(dateStr, 3000, '树树')
  eq(second, first, '第二次结果一致（走缓存）')

  // 追加一行（size/mtime 变）→ 必须失效
  writeFileSync(file, `${JSON.stringify({ t: now - 5000, role: 'user', text: '第一条' })}\n${JSON.stringify({ t: now, role: 'assistant', text: '第二条新内容' })}\n`, 'utf8')
  const third = feed.readRecentChat(dateStr, 3000, '树树')
  ok(third.includes('第二条新内容'), '文件变了之后缓存失效，能读到新内容')
}

// ---------------------------------------------------------------------------
console.log('P2-8 · drives 没变就不写 purpose.json')
// ---------------------------------------------------------------------------
{
  const { maintain } = await imp('state/maintain.js')
  const store = await imp('store.js')
  // P2-1 那一段删过 agents 目录（测自愈），这里重新铺一次
  ensureDirs()
  const cfg = store.loadConfig()
  maintain('', cfg)
  const file = store.PURPOSE_FILE()
  ok(existsSync(file), '第一次维护写了 purpose.json')
  const before = statSync(file).mtimeMs

  await new Promise((r) => setTimeout(r, 30))
  maintain('', cfg)
  const after = statSync(file).mtimeMs
  eq(after, before, 'drives 没变时不再重复写盘（旧实现每回合都写）')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
