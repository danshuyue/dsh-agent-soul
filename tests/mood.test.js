/**
 * 心情模块测试：node tests/mood.test.js
 *
 * 心情是从 dsh-feiyu-mood 移植进来的判断内核，砍掉了每回合注入与挂饰。
 * 这里把「解析容错、判定值只吃 1/3、双半衰期衰减、平复记账、
 * 每轮钩子幂等挂载」这些容易悄悄坏掉的行为钉死 —— 坏了会表现成
 * 「心情乱跳」或者「面板数字永远不动」，都属于难排查的那类。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DIMS,
  MOOD_STEP_DIVISOR,
  TIMELINE_CAP,
  applyDelta,
  blankMoodState,
  decayMood,
  judgeMood,
  normMoodState,
  normReason,
  normalizeMoodConfig,
  observeAgent,
  observedCount,
  parseDelta,
  unobserveAll
} from '../lib/mood.js'

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

const settle = () => new Promise((r) => setTimeout(r, 30))

// --------------------------------------------------------------------------
// parseDelta：模型输出的宽容解析
// --------------------------------------------------------------------------
console.log('判定结果解析：')
{
  const plain = parseDelta('{"moodDelta":5,"dims":{"happy":3},"reason":"树树夸我了","confidence":80}')
  ok(plain !== null, '裸 JSON 解析得出来')
  eq(plain.moodDelta, 5, 'moodDelta 对')
  eq(plain.dims.happy, 3, 'dims 对')
  eq(plain.confidence, 80, 'confidence 对')

  const wrapped = parseDelta('```json\n{"moodDelta":-2,"dims":{"sad":4},"reason":"被凶了","confidence":60}\n```')
  ok(wrapped !== null, 'markdown 包裹也解析得出来')
  eq(wrapped.moodDelta, -2, '包裹里的 moodDelta 对')

  const noisy = parseDelta('好的，这是结果：{"moodDelta":2,"reason":"还行"} 谢谢')
  ok(noisy !== null, '前后杂字不影响')
  eq(noisy.moodDelta, 2, '杂字里的 moodDelta 对')

  eq(parseDelta('这不是 JSON'), null, '纯胡话返回 null')
  eq(parseDelta(''), null, '空串返回 null')

  const clamped = parseDelta('{"moodDelta":50,"dims":{"happy":99,"sad":-30},"confidence":999}')
  eq(clamped.moodDelta, 10, 'moodDelta 收进 ±10')
  eq(clamped.dims.happy, 10, 'dims 上限 10')
  eq(clamped.dims.sad, -10, 'dims 下限 -10')
  eq(clamped.confidence, 100, 'confidence 收进 0-100')

  const bare = parseDelta('{"moodDelta":1}')
  eq(bare.confidence, 70, '没给 confidence 时默认 70')
  eq(bare.dims.happy, 0, '没给 dims 时七情全是 0')
  eq(Object.keys(bare.dims).length, DIMS.length, '七情键齐全')
}

console.log('代词收拢：')
{
  eq(normReason('她说很开心', '树树'), '树树说很开心', '单个代词紧跟说话动词 → 换成称呼')
  eq(normReason('她说她说', '树树'), '她说她说', '一句里两个代词 → 不动（认不准就不美化）')
  eq(normReason('妈妈说她很开心', '树树'), '妈妈说她很开心', '有别人当主语 → 不动')
  eq(normReason('她说很开心', ''), '她说很开心', '没给称呼 → 原样')
}

// --------------------------------------------------------------------------
// applyDelta：心情慢动（1/3）、七情即时、时间线
// --------------------------------------------------------------------------
console.log('判定落账：')
{
  eq(MOOD_STEP_DIVISOR, 3, '心情只吃判定值的 1/3')

  const s = blankMoodState(70)
  applyDelta(s, { moodDelta: 6, dims: { happy: 4 }, reason: '开心的一轮', confidence: 90 })
  eq(s.mood, 72, '判定 +6 → 心情只挪 2 格')
  eq(s.dims.happy, 4, '七情即时全额动')
  eq(s.timeline.length, 1, '记了一条时间线')
  eq(s.timeline[0].delta, 2, '时间线上记的是实际挪动的格数')
  eq(s.lastNotedMood, 72, '记过的基准跟着挪')

  const floored = blankMoodState(62)
  applyDelta(floored, { moodDelta: -10, dims: {}, reason: '跌到底了', confidence: 80 }, { floor: 60 })
  eq(floored.mood, 60, '低不过心情底线')

  const capped = blankMoodState(70)
  capped.timeline = Array.from({ length: TIMELINE_CAP }, (_, i) => ({ i }))
  applyDelta(capped, { moodDelta: 1, dims: {}, reason: '挤进来一条', confidence: 50 })
  eq(capped.timeline.length, TIMELINE_CAP, `时间线封顶 ${TIMELINE_CAP} 条`)
  eq(capped.timeline[capped.timeline.length - 1].reason, '挤进来一条', '挤掉的是最老的')
}

// --------------------------------------------------------------------------
// decayMood：心情向基线回落（半衰期），七情向 0 散（90 分钟）
// --------------------------------------------------------------------------
console.log('时间衰减：')
{
  const now = Date.now()
  const HOUR = 60 * 60 * 1000

  const half = blankMoodState(70)
  half.mood = 100
  half.lastNotedMood = 100
  half.lastDecayAt = now - 12 * HOUR
  decayMood(half, 70, now, 12)
  ok(Math.abs(half.mood - 85) < 0.01, `12 小时（半衰期）正好回落一半（${half.mood.toFixed(2)} ≈ 85）`)

  const dim = blankMoodState(70)
  dim.dims.happy = 100
  dim.lastDecayAt = now - 90 * 60 * 1000
  decayMood(dim, 70, now, 12)
  ok(Math.abs(dim.dims.happy - 50) < 0.01, `七情 90 分钟散一半（${dim.dims.happy.toFixed(2)} ≈ 50）`)

  const fresh = blankMoodState(70)
  fresh.mood = 100
  fresh.lastDecayAt = now - 30 * 1000
  decayMood(fresh, 70, now, 12)
  eq(fresh.mood, 100, '不足 1 分钟不算衰减（轮询再密也不抖）')

  // 6 小时 = 半衰期的一半 → 走掉差距的 1-2^(-0.5) ≈ 29.3%：100→70 的差距 30，落 8.8 格 ≈ 91.2
  const noted = blankMoodState(70)
  noted.mood = 100
  noted.lastNotedMood = 100
  noted.lastDecayAt = now - 6 * HOUR
  decayMood(noted, 70, now, 12)
  ok(Math.abs(noted.mood - 91.2) < 0.1, `6 小时衰减后心情回落（${noted.mood.toFixed(2)} ≈ 91.2）`)
  eq(noted.kind, 'decay', '距记过的基准走了 3 格以上 → 记一条平复')
  eq(noted.timeline.length, 1, '平复也进时间线')
  eq(noted.timeline[0].kind, 'decay', '平复条目带标记')
  ok(Math.abs(noted.lastNotedMood - noted.mood) < 0.01, '基准跟上，不重复记')

  // 只挪了 1 格多 → 不记平复（阈值 3 格，免得时间线全是废话）
  const quiet = blankMoodState(70)
  quiet.mood = 72
  quiet.lastNotedMood = 70
  quiet.lastDecayAt = now - 6 * HOUR
  decayMood(quiet, 70, now, 12)
  ok(Math.abs(quiet.mood - 70) > 0.1 && Math.abs(quiet.mood - 70) < 3, `小回落不记账（${quiet.mood.toFixed(2)}）`)
  eq(quiet.kind, '', '没记平复')
}

// --------------------------------------------------------------------------
// normMoodState / normalizeMoodConfig：容错与收紧
// --------------------------------------------------------------------------
console.log('状态与配置规整：')
{
  const blank = normMoodState(null, 70)
  eq(blank.mood, 70, '空状态回基线')
  eq(blank.timeline.length, 0, '空状态没时间线')

  const broken = normMoodState({ mood: 250, dims: { happy: -5, bogus: 9 }, lastConfidence: 999, timeline: Array.from({ length: 250 }, (_, i) => ({ i, reason: 'x' })) }, 70)
  eq(broken.mood, 100, '越界心情收进 0-100')
  eq(broken.dims.happy, 0, '负七情收进 0-100')
  eq(broken.dims.bogus, undefined, '不认识的七情键不带进来')
  eq(broken.lastConfidence, 100, 'confidence 收进 0-100')
  eq(broken.timeline.length, TIMELINE_CAP, `时间线读进来也截到 ${TIMELINE_CAP}`)

  const dft = normalizeMoodConfig({})
  eq(dft.moodEnabled, true, '心情默认开着')
  eq(dft.moodBase, 70, '基线默认 70')
  eq(dft.moodDecayHalfHours, 12, '半衰期默认 12 小时')

  const tight = normalizeMoodConfig({ moodBase: 5, moodFloor: 200, moodSigMood: 0, moodSelfName: '  小糖  ', moodEnabled: false })
  eq(tight.moodBase, 30, '基线收紧到 30-100')
  eq(tight.moodFloor, 100, '底线收紧到 0-100')
  eq(tight.moodSigMood, 1, '显著阈值收紧到 1-30')
  eq(tight.moodSelfName, '小糖', '称呼去空白')
  eq(tight.moodEnabled, false, '显式关掉能关')
}

// --------------------------------------------------------------------------
// store 门面：沙箱读写（绝不碰真实 ~/.dsh）
// --------------------------------------------------------------------------
console.log('状态落盘（沙箱）：')
{
  const sandbox = mkdtempSync(join(tmpdir(), 'soul-mood-'))
  process.env.DSH_HOME = sandbox
  mkdirSync(join(sandbox, 'agents', 'projects'), { recursive: true })

  const store = await import('../lib/store.js')
  store.resetCaches()
  const cwd = ''

  const first = store.moodState(cwd)
  eq(first.mood, 70, '没存过时从空白起步（70 基线）')
  eq(first.timeline.length, 0, '没存过时没时间线（不迁 feiyu-mood 历史）')

  store.applyMoodDelta(cwd, { moodDelta: 6, dims: { happy: 3 }, reason: '树树来了', confidence: 90 })
  const after = store.moodState(cwd)
  eq(after.mood, 72, '落账后心情挪 2 格（1/3 口径在门面里也成立）')
  eq(after.dims.happy, 3, '七情落账')
  eq(after.timeline.length, 1, '落盘带上时间线')

  const stats = store.moodStats(cwd)
  eq(stats.mood, 72, 'stats 心情对')
  eq(stats.timelineCount, 1, 'stats 时间线条数对')

  store.resetMood(cwd)
  eq(store.moodState(cwd).mood, 70, '重置回空白')

  // 衰减：造一份 6 小时前的心情，看它自己平复
  const aged = blankMoodState(70)
  aged.mood = 100
  aged.lastNotedMood = 100
  aged.lastDecayAt = Date.now() - 6 * 60 * 60 * 1000
  store.saveMoodState(cwd, aged)
  store.decayMoodFor(cwd)
  const decayed = store.moodState(cwd)
  ok(decayed.mood < 100 && decayed.mood > 70, `手动衰减把心情往基线磨（${decayed.mood.toFixed(1)}）`)
  ok(Math.abs(decayed.mood - 91.2) < 1, '幅度约等于 6 小时（半衰期一半）的账')

  rmSync(sandbox, { recursive: true, force: true })
  delete process.env.DSH_HOME
  store.resetCaches()
}

// --------------------------------------------------------------------------
// observeAgent：每轮钩子（幂等挂载 + 判断链）
// --------------------------------------------------------------------------
console.log('每轮判断钩子：')

function fakeAgent(sessionEvents = []) {
  const handlers = {}
  return {
    ctx: {
      on(evt, fn) {
        ;(handlers[evt] = handlers[evt] || []).push(fn)
        return () => {
          const arr = handlers[evt] || []
          const i = arr.indexOf(fn)
          if (i >= 0) arr.splice(i, 1)
        }
      }
    },
    session: { snapshotEvents: () => sessionEvents },
    emit(evt, payload) {
      for (const fn of (handlers[evt] || []).slice()) fn(payload)
    },
    handlerCount(evt) {
      return (handlers[evt] || []).length
    }
  }
}

function fakeLlm(replyJson) {
  const calls = []
  return {
    calls,
    async *stream(req) {
      calls.push(req)
      yield { type: 'text-delta', text: replyJson }
    }
  }
}

{
  // 没有事件总线的 agent：记警告，不挂载
  const notes = []
  observeAgent({ ctx: null }, { llm: null, config: () => ({}), note: (k, m) => notes.push([k, m]) })
  eq(observedCount(), 0, '没 ctx 的 agent 不挂载')
  ok(notes.length > 0, '留了警告')

  // 幂等：挂两次只挂一套钩子
  const agent = fakeAgent()
  const cfgBase = {
    moodEnabled: true,
    moodSigMood: 3,
    moodSigDim: 5,
    moodJudgeProvider: 'test',
    moodJudgeModel: 'fake',
    moodSelfName: '小糖',
    moodOwnerName: '树树',
    applyMoodDelta: () => {}
  }
  const llm = fakeLlm('{"moodDelta":0,"dims":{},"reason":"","confidence":50}')
  observeAgent(agent, { llm, config: () => cfgBase, note: () => {} })
  observeAgent(agent, { llm, config: () => cfgBase, note: () => {} })
  eq(observedCount(), 1, '同一个 agent 只挂一次')
  eq(agent.handlerCount('agent/inbox/inserted'), 1, 'inbox 钩子只挂一条')
  eq(agent.handlerCount('agent/turn-stopping'), 1, 'turn-stopping 钩子只挂一条')

  // 拆干净
  unobserveAll()
  eq(observedCount(), 0, 'unobserveAll 清空挂载')
  eq(agent.handlerCount('agent/turn-stopping'), 0, '钩子真的摘掉了')

  // 正常一轮：收话 → 判定 → 落账
  {
    const deltas = []
    const llm2 = fakeLlm('{"moodDelta":6,"dims":{"happy":6},"reason":"树树夸我了","confidence":90}')
    const agent2 = fakeAgent()
    observeAgent(agent2, {
      llm: llm2,
      config: () => ({ ...cfgBase, applyMoodDelta: (d, opts) => deltas.push({ d, opts }) }),
      note: () => {}
    })
    agent2.emit('agent/inbox/inserted', { content: '你好呀', source: { kind: 'user' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    eq(deltas.length, 1, '一轮判一次')
    eq(deltas[0].d.moodDelta, 6, '判定值传到了落账回调')
    eq(deltas[0].opts.minor, false, '显著变化不算小波动')
    ok(llm2.calls.length === 1, 'llm 只调一次')
    ok(llm2.calls[0].messages[0].content[0].text.includes('你好呀'), '对方的话进了判断材料')
    unobserveAll()
  }

  // 小波动标注：变化低于阈值
  {
    const deltas = []
    const llm2 = fakeLlm('{"moodDelta":2,"dims":{"happy":2},"reason":"小小开心","confidence":60}')
    const agent2 = fakeAgent()
    observeAgent(agent2, {
      llm: llm2,
      config: () => ({ ...cfgBase, applyMoodDelta: (d, opts) => deltas.push({ d, opts }) }),
      note: () => {}
    })
    agent2.emit('agent/inbox/inserted', { content: '嗯嗯', source: { kind: 'user' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    eq(deltas.length, 1, '小变化也落账')
    eq(deltas[0].opts.minor, true, '低于阈值标成小波动')
    unobserveAll()
  }

  // 一点变化都没有的回合不记账
  {
    const deltas = []
    const llm2 = fakeLlm('{"moodDelta":1,"dims":{},"reason":"","confidence":50}')
    const agent2 = fakeAgent()
    observeAgent(agent2, {
      llm: llm2,
      config: () => ({ ...cfgBase, applyMoodDelta: (d, opts) => deltas.push({ d, opts }) }),
      note: () => {}
    })
    agent2.emit('agent/inbox/inserted', { content: '哦', source: { kind: 'user' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    eq(deltas.length, 0, '挪不动格的回合不记账')
    unobserveAll()
  }

  // 心情关掉 → 不判
  {
    const deltas = []
    const llm2 = fakeLlm('{"moodDelta":6,"dims":{"happy":6},"reason":"不该被看到","confidence":90}')
    const agent2 = fakeAgent()
    observeAgent(agent2, {
      llm: llm2,
      config: () => ({ ...cfgBase, moodEnabled: false, applyMoodDelta: (d, opts) => deltas.push({ d, opts }) }),
      note: () => {}
    })
    agent2.emit('agent/inbox/inserted', { content: '说话', source: { kind: 'user' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    eq(deltas.length, 0, '心情关着就不判')
    eq(llm2.calls.length, 0, 'llm 都不叫')
    unobserveAll()
  }

  // 宿主注入的上下文不算「对方说话」
  {
    const deltas = []
    const llm2 = fakeLlm('{"moodDelta":6,"dims":{},"reason":"不该被看到","confidence":90}')
    const agent2 = fakeAgent()
    observeAgent(agent2, {
      llm: llm2,
      config: () => ({ ...cfgBase, applyMoodDelta: (d, opts) => deltas.push({ d, opts }) }),
      note: () => {}
    })
    agent2.emit('agent/inbox/inserted', { content: 'runtime 塞的', source: { kind: 'runtime-context' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    eq(deltas.length, 0, '注入上下文不触发判断')
    unobserveAll()
  }

  // work 口径：定时任务只判她自己的话
  {
    const llm2 = fakeLlm('{"moodDelta":4,"dims":{"worry":3},"reason":"活没干完","confidence":80}')
    const agent2 = fakeAgent()
    observeAgent(agent2, { llm: llm2, config: () => cfgBase, note: () => {} })
    agent2.emit('agent/inbox/inserted', { content: '到点了该干活', source: { kind: 'bili-duty-scan' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    const userMsg = llm2.calls[0].messages[0].content[0].text
    ok(userMsg.includes('定时任务'), 'work 口径的提示进去了')
    ok(userMsg.includes('不是'), 'work 口径强调不是对方在说话')
    unobserveAll()
  }

  // talk 口径：自己搭话只判开口那股劲
  {
    const llm2 = fakeLlm('{"moodDelta":3,"dims":{"sweet":2},"reason":"想找树树","confidence":70}')
    const agent2 = fakeAgent()
    observeAgent(agent2, { llm: llm2, config: () => cfgBase, note: () => {} })
    agent2.emit('agent/inbox/inserted', { content: '该主动说话了', source: { kind: 'speak-up' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    const userMsg = llm2.calls[0].messages[0].content[0].text
    ok(userMsg.includes('搭话'), 'talk 口径的提示进去了')
    unobserveAll()
  }

  // llm 报错 → 不落账，不炸
  {
    const deltas = []
    const badLlm = {
      calls: [],
      async *stream() {
        throw new Error('模型挂了')
      }
    }
    const agent2 = fakeAgent()
    observeAgent(agent2, {
      llm: badLlm,
      config: () => ({ ...cfgBase, applyMoodDelta: (d, opts) => deltas.push({ d, opts }) }),
      note: () => {}
    })
    agent2.emit('agent/inbox/inserted', { content: '说话', source: { kind: 'user' } })
    agent2.emit('agent/turn-stopping')
    await settle()
    eq(deltas.length, 0, '模型挂了不落账')
    unobserveAll()
  }
}

// judgeMood 直接调用的边界
{
  eq(await judgeMood(null, null, 'x', 'y', '', {}), null, '没有 llm 服务返回 null')
  eq(await judgeMood({ stream: () => {} }, null, 'x', 'y', '', {}), null, '没有模型目标返回 null')
  const errLlm = {
    async *stream() {
      yield { type: 'finish', reason: { kind: 'error' } }
    }
  }
  eq(await judgeMood(errLlm, { options: { provider: 'p', model: 'm' } }, 'x', 'y', '', {}), null, 'finish 报错返回 null')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
