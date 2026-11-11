/**
 * 四段系统提示的渲染缓存（2026-11-11）
 *
 * 守的核心不是「省了多少 CPU」，而是两件事：
 *   ① **非刷新轮次返回上次的文本，不是空串** —— 修掉人格段「15 轮里 14 轮没身份」；
 *   ② 写入之后下一轮立刻能看见（记忆写入回声不能被缓存吃掉）。
 *
 * 单元部分直接打 segment-cache 的契约；最后一段走真实的 soul:memory / soul:persona
 * 段，证明接线没接错。数据全部落在临时 DSH_HOME，不碰真实的 ~/.dsh。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'soul-segcache-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })
mkdirSync(join(sandbox, 'agents', 'projects'), { recursive: true })

const cache = await import('../lib/host/runtime/segment-cache.js')
const {
  renderCached,
  invalidateSegment,
  invalidateAll,
  __resetSegmentCacheForTest,
  __segmentCacheStatsForTest,
  SEGMENT_CACHE_MAX_ENTRIES,
  fileSignature
} = cache

/** 假宿主：seq 在顶层、snapshotEvents(from,to) 半开区间（跟真 DSH 同形状）。 */
function makeAgent(id, events) {
  return {
    session: {
      header: { id, cwd: '' },
      firstLiveSeq: 0,
      get seq() {
        return events.length === 0 ? 0 : events[events.length - 1].seq
      },
      snapshotEvents: (from, to) => {
        if (from === undefined) return events.slice()
        return events.filter((event) => event.seq >= from && (to === undefined || event.seq < to))
      }
    }
  }
}
function userEvent(seq, text = '随便说一句') {
  return { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function assistantEvent(seq, text = '嗯。') {
  return { type: 'assistant/message', seq, data: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } }
}

console.log('① 同内容连续调用两次：compute 只跑一次')
{
  __resetSegmentCacheForTest()
  const events = []
  const agent = makeAgent('cache-unit-a', events)
  let calls = 0
  const compute = () => `文本-${++calls}`
  const first = renderCached(agent, 'notes', compute, { sig: 'same', everyTurns: 7 })
  const second = renderCached(agent, 'notes', compute, { sig: 'same', everyTurns: 7 })
  eq(first, '文本-1', '第一次拿到 compute 的结果')
  eq(second, '文本-1', '第二次直接命中缓存')
  eq(calls, 1, 'compute 只被调用一次')
}

console.log('② 超过 everyTurns 之后重算')
{
  __resetSegmentCacheForTest()
  const events = [userEvent(1)]
  const agent = makeAgent('cache-unit-b', events)
  let calls = 0
  const compute = () => `t${++calls}`
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 2 }), 't1', '第一轮 t1')
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 2 }), 't1', '同一轮仍是 t1')
  events.push(userEvent(2))
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 2 }), 't1', '过 1 轮还在有效期内（t1）')
  events.push(userEvent(3))
  eq(renderCached(agent, 'notes', compute, { sig: 's', everyTurns: 2 }), 't2', '过 2 轮（= everyTurns）后重算')
  eq(calls, 2, 'compute 一共跑了两次')
}

console.log('③ sig 变化立刻重算')
{
  __resetSegmentCacheForTest()
  const agent = makeAgent('cache-unit-c', [])
  let calls = 0
  const compute = () => `v${++calls}`
  eq(renderCached(agent, 'purpose', compute, { sig: 'a', everyTurns: 99 }), 'v1', 'sig=a → v1')
  eq(renderCached(agent, 'purpose', compute, { sig: 'a', everyTurns: 99 }), 'v1', 'sig 不变 → 命中')
  eq(renderCached(agent, 'purpose', compute, { sig: 'b', everyTurns: 99 }), 'v2', 'sig 一变立刻重算')
  eq(calls, 2, 'compute 两次')
}

console.log('④ invalidateSegment 之后立刻重算，且只作废指定的段')
{
  __resetSegmentCacheForTest()
  const agent = makeAgent('cache-unit-d', [])
  let notesCalls = 0
  let memoryCalls = 0
  const notesCompute = () => `n${++notesCalls}`
  const memoryCompute = () => `m${++memoryCalls}`
  renderCached(agent, 'notes', notesCompute, { sig: 's', everyTurns: 99 })
  renderCached(agent, 'memory', memoryCompute, { sig: 's', everyTurns: 99 })
  renderCached(agent, 'notes', notesCompute, { sig: 's', everyTurns: 99 })
  renderCached(agent, 'memory', memoryCompute, { sig: 's', everyTurns: 99 })
  eq([notesCalls, memoryCalls], [1, 1], '两段都命中')

  eq(invalidateSegment('notes'), 1, '作废 notes 一个槽')
  eq(renderCached(agent, 'notes', notesCompute, { sig: 's', everyTurns: 99 }), 'n2', 'notes 重算')
  eq(renderCached(agent, 'memory', memoryCompute, { sig: 's', everyTurns: 99 }), 'm1', 'memory 不受影响')

  invalidateAll()
  eq(renderCached(agent, 'memory', memoryCompute, { sig: 's', everyTurns: 99 }), 'm2', 'invalidateAll 之后重算')
}

console.log('⑤ 非刷新轮次返回上次的文本，不是空串（本次的核心）')
{
  __resetSegmentCacheForTest()
  const events = [userEvent(1), assistantEvent(2), userEvent(3)]
  const agent = makeAgent('cache-unit-e', events)
  let calls = 0
  const first = renderCached(agent, 'persona', () => { calls += 1; return '我是糖糖，这是完整人格。' }, { sig: 'p', everyTurns: 15 })
  ok(first !== '', '首轮有内容')
  // 又过了两轮：远没到 15 轮，缓存必须交回原文
  events.push(userEvent(4), assistantEvent(5), userEvent(6))
  const second = renderCached(agent, 'persona', () => { calls += 1; return '这是重新拼出来的另一份。' }, { sig: 'p', everyTurns: 15 })
  eq(second, first, '非刷新轮次拿到的是上次那段原文（逐字节一致）')
  ok(second !== '', '非刷新轮次不是空串')
  eq(calls, 1, '没有重算')
}

console.log('⑥ 拿不到 sessionId：每次都算、不缓存')
{
  __resetSegmentCacheForTest()
  let calls = 0
  const compute = () => `x${++calls}`
  const anon = { session: { header: { cwd: '' }, seq: 2, snapshotEvents: () => [] } }
  eq(renderCached(anon, 'notes', compute, { sig: 's' }), 'x1', '无 id 第一次')
  eq(renderCached(anon, 'notes', compute, { sig: 's' }), 'x2', '无 id 第二次也重算')
  eq(renderCached(undefined, 'notes', compute, { sig: 's' }), 'x3', '连 agent 都没有也重算')
  eq(__segmentCacheStatsForTest().size, 0, '一个槽都没存')
}

console.log('⑦ 缓存 Map 有上限，超了淘汰最旧的而不是整体清空')
{
  __resetSegmentCacheForTest()
  for (let i = 0; i < SEGMENT_CACHE_MAX_ENTRIES + 30; i += 1) {
    renderCached(makeAgent(`cache-cap-${i}`, []), 'notes', () => `v${i}`, { sig: 's', everyTurns: 99 })
  }
  const stats = __segmentCacheStatsForTest()
  eq(stats.max, SEGMENT_CACHE_MAX_ENTRIES, `上限常量是 ${SEGMENT_CACHE_MAX_ENTRIES}`)
  eq(stats.size, SEGMENT_CACHE_MAX_ENTRIES, '超限后稳定在最大值（不是 clear 成 0）')
}

console.log('⑧ fileSignature：mtime / size 变了指纹就变')
{
  const file = join(sandbox, 'sig-probe.txt')
  writeFileSync(file, 'a', 'utf8')
  const s1 = fileSignature(file)
  ok(s1.includes(`${file}:`), '指纹里带上了文件路径')
  writeFileSync(file, 'a much longer body', 'utf8')
  ok(fileSignature(file) !== s1, '内容变长（size 变）→ 指纹变')
  ok(fileSignature(join(sandbox, 'does-not-exist')).includes('0:0'), '文件不存在时记 0:0，不抛')
}

// ---------------------------------------------------------------------------
// 真实段接线：人格不空 + 记忆写入下一轮可见 + 回声不被缓存吃掉
// ---------------------------------------------------------------------------

console.log('⑨ 真实 soul:persona / soul:memory 段')
{
  __resetSegmentCacheForTest()
  writeFileSync(join(sandbox, 'AGENT.md'), '# 你是谁\n测试用搭子，名字叫糖糖。\n', 'utf8')

  const store = await import('../lib/store.js')
  const memoryMod = await import('../lib/memory.js')
  const mod = await import('../lib/index.js')
  const { pushEcho } = await import('../lib/core/echo.js')

  function makeCtx() {
    const segments = []
    const ctx = {
      get(key) {
        if (key === 'tools') return { register: () => () => {} }
        if (key === 'webServer') return { register: () => () => {} }
        if (key === 'systemPrompt') return { context: (segment) => { segments.push(segment); return () => {} } }
        return undefined
      },
      effect(fn) { return fn() },
      slots: { inject() {}, register() { return () => {} } },
      __segments: segments
    }
    return ctx
  }

  store.saveConfig({ enabled: true, memoryEnabled: true, memoryRecall: false, notesEnabled: false, purposeEnabled: false, diaryEnabled: false })
  store.saveGlobalCard(memoryMod.normalizeCard({ scope: 'global', records: [] }))

  const ctx = makeCtx()
  mod.apply(ctx)
  const personaSegment = ctx.__segments.find((s) => s.name === 'soul:persona')
  const memorySegment = ctx.__segments.find((s) => s.name === 'soul:memory')
  ok(personaSegment !== undefined && memorySegment !== undefined, '两段都注册上了')

  const sessionId = 'cache-integration-1'
  const events = [userEvent(1, '今天想聊聊比赛'), assistantEvent(2, '嗯，我在。'), userEvent(3, '蓝桥杯要用什么主控')]
  const agent = makeAgent(sessionId, events)

  // 人格：同一轮 / 非刷新轮次都不能变成空串
  const persona1 = personaSegment.text({ agent })
  ok(persona1 !== '', '人格段首轮非空')
  ok(persona1.includes('糖糖'), '人格段读到了 AGENT.md')
  events.push(userEvent(4))
  const persona2 = personaSegment.text({ agent })
  eq(persona2, persona1, '非刷新轮次的人格段与上次逐字节一致（不是空串）')
  ok(persona2 !== '', '非刷新轮次的人格段非空')

  // 记忆：先建立一次缓存，再写入，下一轮必须看得见
  const memory1 = memorySegment.text({ agent })
  ok(typeof memory1 === 'string', '记忆段返回字符串')
  const write = store.writeMemory({
    cwd: '',
    scope: 'global',
    input: { text: '缓存测试专用：她刚写下的这条一定要在下一轮出现', source: 'test' },
    config: store.loadConfig()
  })
  ok(write.ok === true, '写记忆成功')
  events.push(assistantEvent(5, '好，我记下了。'))
  const memory2 = memorySegment.text({ agent })
  ok(memory2.includes('缓存测试专用'), '写入后下一轮的注入里能看到新条目（缓存没吃掉它）')

  // 记忆写入回声：一次性、下一次装配必须出现，不能被缓存盖掉
  pushEcho(sessionId, '回声测试：刚记下的那条回执')
  events.push(assistantEvent(6, '记好了。'))
  const memory3 = memorySegment.text({ agent })
  ok(memory3.startsWith('## 刚记下的'), '有回声的一轮：回声段在最前面（绕开了缓存）')
  ok(memory3.includes('回声测试'), '回声内容在场')
  events.push(assistantEvent(7, '还有别的吗？'))
  const memory4 = memorySegment.text({ agent })
  ok(memory4.includes('回声测试') === false, '回声是一次性的，下一轮不再出现')
}

rmSync(sandbox, { recursive: true, force: true })
console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
