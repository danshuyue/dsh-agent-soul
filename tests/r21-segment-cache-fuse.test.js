/**
 * R21 · segment-cache 的保险丝（2026-11-12 审计 D1）
 *
 * 缺陷形状：`everyTurns` 用 `human - hit.turn` 判定，而 `human` 靠
 * `isFirstTurnOfSession` 推进 —— 它依赖 `session.snapshotEvents()`。
 * 宿主在压缩会话上**持续抛错**时 human 恒为 0，于是 `human - hit.turn` 恒为 0，
 * 缓存永不重算：21 轮里 compute 只跑 1 次，日志里一个字都没有。
 *
 * 修法：槽位记 `at`，命中再加一条 `now - at < maxAgeMs`（默认 30 分钟）。
 * 正常路径（human 在涨）永远轮不到它，只在退化场景兜底。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = join(import.meta.dirname ?? process.cwd(), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

let passed = 0
let failed = 0
const ok = (c, n, extra = '') => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}${extra ? `  ← ${extra}` : ''}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r21-fuse-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

const cache = await imp('host/runtime/segment-cache.js')
const { renderCached, __resetSegmentCacheForTest, SEGMENT_CACHE_MAX_AGE_MS } = cache
const turnsMod = await imp('host/runtime/turns.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假宿主：可以指定 snapshotEvents 恒抛（模拟压缩会话）。 */
function makeAgent(id, { alwaysThrow = false, events = [] } = {}) {
  return {
    session: {
      header: { id, cwd: '' },
      get seq() { return events.length === 0 ? 0 : events[events.length - 1].seq },
      snapshotEvents(from, to) {
        if (alwaysThrow) throw new Error('压缩会话快照恒抛（模拟）')
        if (from === undefined) return events.slice()
        return events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
      }
    },
    events
  }
}

console.log('① 保险丝常量与默认值')
{
  eq(SEGMENT_CACHE_MAX_AGE_MS, 30 * 60 * 1000, '默认 30 分钟')
}

console.log('② 正常路径：没有超时之前仍然命中（不许无谓打断 prefix cache）')
{
  __resetSegmentCacheForTest()
  const agent = makeAgent('fuse-normal')
  let calls = 0
  const compute = () => `v${++calls}`
  eq(renderCached(agent, 'persona', compute, { sig: 's', everyTurns: 15 }), 'v1', '第一次 v1')
  await sleep(30)
  eq(renderCached(agent, 'persona', compute, { sig: 's', everyTurns: 15 }), 'v1', '30ms 后仍命中（默认 30 分钟远没到）')
  eq(calls, 1, 'compute 只跑一次')
}

console.log('③ 保险丝到期：轮次没动也重算')
{
  __resetSegmentCacheForTest()
  const agent = makeAgent('fuse-expire')
  let calls = 0
  const compute = () => `v${++calls}`
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 999, maxAgeMs: 20 }), 'v1', '第一次 v1')
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 999, maxAgeMs: 20 }), 'v1', '还没到期 → 命中')
  await sleep(40)
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 999, maxAgeMs: 20 }), 'v2', '到期后重算（轮次一点没动）')
  eq(calls, 2, 'compute 两次')
}

console.log('④ 缺陷复现场景：快照恒抛 + human 推不动 → 靠保险丝自愈')
{
  __resetSegmentCacheForTest()
  const agent = makeAgent('fuse-stuck', { alwaysThrow: true })
  let calls = 0
  const compute = () => `v${++calls}`

  // everyTurns=2 本来该很快重算，但 human 恒 0 → 只有保险丝能救
  eq(renderCached(agent, 'purpose', compute, { sig: 'fixed', everyTurns: 2, maxAgeMs: 20 }), 'v1', '第一次 v1（human=0）')
  for (let i = 0; i < 5; i += 1) {
    agent.events.push({ type: 'user/message', seq: 100 + i, data: { source: { kind: 'user' } } })
    renderCached(agent, 'purpose', compute, { sig: 'fixed', everyTurns: 2, maxAgeMs: 20 })
  }
  eq(calls, 1, '5 轮之内：还是冻结的（这正是审计 D1 的现场）')
  await sleep(45)
  eq(renderCached(agent, 'purpose', compute, { sig: 'fixed', everyTurns: 2, maxAgeMs: 20 }), 'v2', '保险丝到期 → 强制重算，缓存不再永久冻结')
  eq(calls, 2, 'compute 两次')
}

console.log('⑤ maxAgeMs=0 表示关闭保险丝（回到旧行为，供测试/对照用）')
{
  __resetSegmentCacheForTest()
  const agent = makeAgent('fuse-off')
  let calls = 0
  const compute = () => `v${++calls}`
  renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 99, maxAgeMs: 0 })
  await sleep(20)
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 99, maxAgeMs: 0 }), 'v1', 'maxAgeMs=0 → 不看时间')
}

console.log('⑥ 死代码真的删了（shouldInjectPersona / personaInjectAtBySession）')
{
  eq(typeof turnsMod.shouldInjectPersona, 'undefined', 'turns.js 不再导出 shouldInjectPersona')
  const stateMod = await imp('host/runtime/state.js')
  eq(typeof stateMod.personaInjectAtBySession, 'undefined', 'state.js 不再导出 personaInjectAtBySession')
}

rmSync(sandbox, { recursive: true, force: true })
console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
