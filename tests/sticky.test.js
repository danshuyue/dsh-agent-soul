/**
 * 粘性召回测试（2026-10-30）：node tests/sticky.test.js
 *
 * 守五件事（对应这次改造的验收点）：
 *   ① 同一 query 连续两次调用返回**字节相同**的字符串（DSH 才不会重复追加）；
 *   ② 换话题（Jaccard 低于 0.6）后文本必须**不同**；
 *   ③ 空 query（纯注入 / 装配早于事件落库）沿用上次文本；
 *   ④ 没有历史时空 query 退回整卡（不死锁在空串上）；
 *   ⑤ 每会话状态表有上限，淘汰不能把别的会话的记忆串进来。
 *
 * 为什么必须走真的 `soul:memory` 段来测：粘性判定写在 text() 里，
 * 单独的纯函数测试证明不了「同一轮装配拿到的是同一段文本」。
 * 数据全部落在临时 DSH_HOME，不碰真实的 ~/.dsh。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const sandbox = mkdtempSync(join(tmpdir(), 'soul-sticky-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })
writeFileSync(join(sandbox, 'AGENT.md'), '# 你是谁\n测试用搭子。\n', 'utf8')

const memory = await import('../lib/memory.js')
const store = await import('../lib/store.js')
const mod = await import('../lib/index.js')

/** 假宿主：只实现插件真正用到的那几个方法（照抄 smoke.test.js）。 */
function makeCtx() {
  const contextSegments = []
  const tools = []
  const apiRoutes = []
  const effects = []
  const ctx = {
    get(key) {
      if (key === 'tools') return { register: (definition) => { tools.push(definition); return () => {} } }
      if (key === 'webServer') return { register: (route) => { apiRoutes.push(route); return () => {} } }
      if (key === 'systemPrompt') return { context: (segment) => { contextSegments.push(segment); return () => {} } }
      return undefined
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
    slots: { inject() {}, register() { return () => {} } },
    __contextSegments: contextSegments,
    __effects: effects
  }
  return ctx
}

/** 造一张卡：走 addRecord，保证 clarity/kind/pinned 跟真机同一条路径。 */
function cardOf(scope, specs) {
  const cfg = memory.normalizeConfig({})
  const card = memory.createCard(scope)
  for (const spec of specs) {
    const result = memory.addRecord(card, { text: spec.text, source: 'test', ...spec }, cfg, Date.now())
    if (spec.pinned === true) memory.setPinned(card, result.record.id, true)
    if (spec.isInitial === true) result.record.isInitial = true
  }
  return card
}

/**
 * 假 agent：事件放在一个可变盒子里，测试中途能整批换掉（模拟「这一轮只有注入」）。
 * seq 取最后一条事件的 seq，跟真 DSH 的 session.seq 口径一致。
 */
function makeAgent(id, box) {
  return {
    session: {
      header: { id, cwd: '' },
      firstLiveSeq: 0,
      get seq() {
        return box.events.length === 0 ? 0 : box.events[box.events.length - 1].seq
      },
      snapshotEvents: (from, to) => box.events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }
}

function userEvent(seq, text) {
  return { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function assistantEvent(seq, text) {
  return { type: 'assistant/message', seq, data: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } }
}
function injectionEvent(seq, text) {
  return { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'runtime-context' } } }
}

/** 一个「已经在对话中」的会话：两条真人消息 → isFirstTurnOfSession 为 false。 */
function talkingBox(firstText, lastText) {
  return { events: [userEvent(1, firstText), assistantEvent(2, '嗯，我在。'), userEvent(3, lastText)] }
}

// ---- 数据：两个话题，各自有一条能命中的记忆 ----
store.saveGlobalCard(cardOf('global', [
  {
    text: '树树想明年打蓝桥杯嵌入式赛道，主控用 STM32，赛题要三人一组',
    kind: 'preference',
    importance: 72
  },
  {
    text: '树树喜欢喝冰美式，不加糖也不加奶，夏天一天两杯',
    kind: 'preference',
    importance: 66
  },
  {
    text: '树树的目标是嵌入式工程师',
    kind: 'fact',
    importance: 80,
    isInitial: true
  }
]))

const ctx = makeCtx()
mod.apply(ctx)
const memorySegment = ctx.__contextSegments.find((s) => s.name === 'soul:memory')
ok(memorySegment !== undefined, 'soul:memory 段注册上了')
const textOf = (agent) => memorySegment.text({ agent })

console.log('① 同一话题连续两次装配：字节完全一致（2026-10-30）')
const sessionA = makeAgent('session-sticky-a', talkingBox('今天想聊聊比赛', '蓝桥杯嵌入式赛道要报什么组'))
const textA1 = textOf(sessionA)
const textA2 = textOf(sessionA)
ok(textA1 !== '', '第一次就召回了内容（不是空串，否则这条测试没意义）')
eq(textA2, textA1, '同一 query 第二次返回的字符串与第一次逐字节相同')
ok(textA1 === textA2, '=== 比较也相同（不只是 JSON 相等）')

console.log('② 换话题（Jaccard 低）：文本必须变')
{
  const box = talkingBox('今天想聊聊比赛', '蓝桥杯嵌入式赛道要报什么组')
  const session = makeAgent('session-sticky-b', box)
  const before = textOf(session)
  ok(before.includes('蓝桥杯'), '换话题前贴的是蓝桥杯')
  // 同一会话里，用户忽然说起喝的东西：词集合几乎不重合
  box.events.push(assistantEvent(4, '嵌入式组。'), userEvent(5, '对了，冰美式今天不加糖'))
  const after = textOf(session)
  ok(after !== before, '换话题后重新拼了一次（文本不同）')
  ok(after.includes('冰美式'), '新文本贴的是新话题（冰美式）')
  ok(after.includes('蓝桥杯') === false, '旧话题的那条没有继续挂着')
}

console.log('③ 空 query：沿用上次文本，不重算')
{
  const box = talkingBox('先问个问题', '树树想打蓝桥杯嵌入式赛道')
  const session = makeAgent('session-sticky-c', box)
  const first = textOf(session)
  ok(first !== '', '先有一次有效召回')
  // 这一轮只有注入消息（source.kind 不是 user）→ currentUserText 返回空串。
  // 但事件还留在 200 条的窗口里，所以 isFirstTurnOfSession 仍判定「不是第一轮」。
  box.events = [injectionEvent(4, 'Current time: 2026-10-30'), injectionEvent(5, '（主动搭话·距上次说话 3 小时）')]
  const second = textOf(session)
  eq(second, first, '空 query 拿到的是上次那段文本（字节一致）')
}

console.log('④ 没有历史 + 空 query：退回整卡，不死锁在空串上')
{
  // 两条真人消息放在窗口之外（seq 1/2），当前窗口只剩注入 → query 为空、又不是第一轮
  const box = {
    events: [
      userEvent(1, '很久以前的对话一'),
      userEvent(2, '很久以前的对话二'),
      injectionEvent(399, 'Current time: 2026-10-30'),
      injectionEvent(400, '（定时任务·距上次说话 8 小时）')
    ]
  }
  const session = makeAgent('session-sticky-d', box)
  const text = textOf(session)
  ok(text.includes('【记忆卡'), '没有上次文本 → 整卡（带记忆卡标题）')
  ok(text.includes('蓝桥杯'), '整卡里有记忆内容')
}

console.log('⑤ 状态表上限 + 不串会话（2026-10-30）')
{
  // A 的话题是蓝桥杯；填满 32+ 个会话来触发 LRU 淘汰，再看新会话会不会拿到 A 的文本
  const boxA = talkingBox('聊技术', '蓝桥杯嵌入式赛道怎么准备')
  const sessionA2 = makeAgent('session-sticky-lru-a', boxA)
  const textBlue = textOf(sessionA2)
  ok(textBlue.includes('蓝桥杯'), 'A 会话召回到了蓝桥杯那条')

  for (let i = 0; i < 40; i += 1) {
    const box = talkingBox('随便聊聊', `冰美式第 ${i} 次，还是不加糖`)
    textOf(makeAgent(`session-sticky-fill-${i}`, box))
  }
  const stats = mod.__stickyStatsForTest()
  eq(stats.size <= stats.max, true, `状态表不超过上限（${stats.size} / ${stats.max}）`)

  // A 已被淘汰（40 个填充会话足够把它挤出去）：同一个 query 再问，必须重新按自己的卡算
  const again = textOf(makeAgent('session-sticky-lru-a', talkingBox('聊技术', '冰美式还是不加糖吧')))
  ok(again !== textBlue, '淘汰后不再拿旧文本，而是重新算了一次')
  ok(again.includes('冰美式'), '重算贴的是这一轮的话题')

  // 新会话（表里没有它的状态）必须按自己的 query 算，不能捡别人的文本
  const fresh = textOf(makeAgent('session-sticky-lru-z', talkingBox('随便聊聊', '冰美式不加糖')))
  ok(fresh.includes('冰美式'), '新会话拿到了和自己话题相关的记忆')
  ok(fresh.includes('蓝桥杯') === false, '新会话没有捡到别的会话的蓝桥杯文本')
}

console.log('⑥ 相关区瘦身：默认 3 条、每条截到 48 字（2026-10-30）')
{
  eq(memory.normalizeConfig({}).memoryRecallTopK, 3, 'memoryRecallTopK 默认 3')
  const now = Date.now()
  const card = memory.createCard('global')
  for (let i = 0; i < 6; i += 1) {
    memory.addRecord(card, {
      text: `蓝桥杯嵌入式赛道第 ${i} 条备忘：把 STM32 的定时器、中断、串口全过一遍，再按四小时限时做一套赛题`,
      source: 'test',
      kind: 'preference',
      importance: 70
    }, memory.normalizeConfig({}), now)
  }
  const block = memory.renderRecalledBlock([card], { config: memory.normalizeConfig({}), query: '蓝桥杯嵌入式赛道怎么准备', now })
  const related = block.split('## 和这句话有关的\n')[1]?.split('\n\n')[0] ?? ''
  const lines = related.split('\n').filter((line) => line.startsWith('- '))
  ok(lines.length > 0 && lines.length <= 3, `相关区默认最多 3 条（实际 ${lines.length} 条）`)
  ok(lines.every((line) => line.length <= 48), '每条相关记忆不超过 48 字')
  ok(lines.every((line) => line.endsWith('…')), '超长的以 … 结尾（不是硬切）')
}

console.log('清理：')
{
  for (const effect of ctx.__effects) {
    if (typeof effect === 'function') {
      try { effect() } catch { /* 清理失败不算测试失败 */ }
    }
  }
  mod.__resetForTest()
  eq(mod.__stickyStatsForTest().size, 0, '__resetForTest 清空了粘性状态表')
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
