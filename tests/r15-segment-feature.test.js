/**
 * R15 · soul:memory 段的特征测试（2026-11-09，#28 拆分前置）
 *
 * 目的：把 segment-memory.js 里 text() 当前**实际表现**钉住，作为
 * 「拆成 runToneForTurn / collectDiaryMaterial / budgetPlanFor / computeRecallText
 *   四个函数」重构的安全网。拆完这份测试必须一条不改就全绿。
 *
 * 断言的都是现状（不是理想）：
 *   ① enabled:false → 注入空串，且日记素材**也不**记（整个插件关掉才彻底不做）
 *   ② memoryEnabled:false → 注入空串，但日记素材**照记**（修 ③ 的语义）
 *   ③ 首轮 → 整卡 + 最近区，整体包在 untrusted 边界内且闭合标签完整
 *   ④ 有回声的一轮 → 回声在最前、边界闭合、总长不破 injectMaxChars 预算
 *
 * harness 照抄 sticky.test.js / echo.test.js（假宿主 + 可变事件盒）。
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r15-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })
writeFileSync(join(sandbox, 'AGENT.md'), '# 你是谁\n测试用搭子。\n', 'utf8')

const memory = await import('../lib/memory.js')
const store = await import('../lib/store.js')
const paths = await import('../lib/paths.js')
const mod = await import('../lib/index.js')

function makeCtx() {
  const contextSegments = []
  const tools = []
  const ctx = {
    get(key) {
      if (key === 'tools') return { register: (definition) => { tools.push(definition); return () => {} } }
      if (key === 'webServer') return { register: () => {} }
      if (key === 'systemPrompt') return { context: (segment) => { contextSegments.push(segment); return () => {} } }
      return undefined
    },
    effect(fn) { return fn() },
    slots: { inject() {}, register() { return () => {} } },
    __contextSegments: contextSegments,
    __tools: tools
  }
  return ctx
}

function makeAgent(id, box, seqOffset = 0) {
  return {
    session: {
      header: { id, cwd: '' },
      firstLiveSeq: 0,
      get seq() {
        const base = box.events.length === 0 ? 0 : box.events[box.events.length - 1].seq
        return base + seqOffset
      },
      snapshotEvents: (from, to) => {
        if (from === undefined) return box.events.slice()
        return box.events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
      }
    }
  }
}
function userEvent(seq, text) {
  return { type: 'user/message', seq, data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } }
}
function assistantEvent(seq, text) {
  return { type: 'assistant/message', seq, data: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model' } } }
}
function talkingBox(firstText, lastText) {
  return { events: [userEvent(1, firstText), assistantEvent(2, '嗯，我在。'), userEvent(3, lastText)] }
}

/** 递归统计 diary conversations 目录下所有 .jsonl 的字节总量（素材是否落盘的可观测面）。 */
function conversationsBytes() {
  const root = paths.diaryConversationsDir()
  let total = 0
  const walk = (dir) => {
    let list = []
    try { list = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of list) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else { try { total += statSync(full).size } catch { /* 读不到就算 0 */ } }
    }
  }
  walk(root)
  return total
}

store.saveGlobalCard(memory.normalizeCard({
  scope: 'global',
  records: [{ text: '树树想明年打蓝桥杯嵌入式赛道，主控用 STM32', kind: 'preference', importance: 72 }]
}))

const ctx = makeCtx()
mod.apply(ctx)
const memorySegment = ctx.__contextSegments.find((s) => s.name === 'soul:memory')
ok(memorySegment !== undefined, 'soul:memory 段注册上了')
const textOf = (agent) => memorySegment.text({ agent })

store.saveConfig({ enabled: true, memoryEnabled: true, memoryRecall: true })

console.log('① enabled:false → 空注入，日记素材也不记（整个插件关掉才彻底不做）')
{
  mod.__resetForTest?.()
  store.saveConfig({ enabled: false })
  const before = conversationsBytes()
  const agent = makeAgent('session-r15-a', talkingBox('聊点啥', '蓝桥杯要用什么主控'))
  const text = textOf(agent)
  eq(text, '', 'enabled:false → 注入空串')
  eq(conversationsBytes(), before, '对话流水零增长（插件全关时素材也不记）')
  store.saveConfig({ enabled: true })
}

console.log('② memoryEnabled:false → 空注入，但日记素材照记')
{
  mod.__resetForTest?.()
  store.saveConfig({ memoryEnabled: false })
  const box = talkingBox('聊点别的', '今天天气不错')
  const agent = makeAgent('session-r15-b', box)
  const text = textOf(agent)
  eq(text, '', 'memoryEnabled:false → 注入空串')
  // collectForDiary 首调只建游标；再追加一轮事件，第二次装配时才落盘
  const before = conversationsBytes()
  box.events.push(assistantEvent(4, '是呀，挺暖和的。'), userEvent(5, '出去走走？'))
  textOf(agent)
  ok(conversationsBytes() > before, `对话流水增长了（素材与记忆开关解耦；${before} → ${conversationsBytes()} 字节）`)
  store.saveConfig({ memoryEnabled: true })
}

console.log('③ 首轮 → 整卡 + 最近区，untrusted 边界闭合')
{
  mod.__resetForTest?.()
  const box = { events: [userEvent(1, '蓝桥杯嵌入式赛道怎么报名')] }
  const agent = makeAgent('session-r15-c', box)
  const text = textOf(agent)
  ok(text !== '', '首轮注入非空')
  ok(text.includes('蓝桥杯嵌入式赛道'), '整卡内容在注入里')
  ok(text.includes('<untrusted_data'), '整段包在 untrusted_data 边界里')
  // 现状断言：开闭标签数量一致（不出现切在标签中间的半截）
  const closes = (text.match(/<\/untrusted_data/g) ?? []).length
  const opens = (text.match(/<untrusted_data/g) ?? []).length
  eq(opens, closes, `开闭标签数量一致（开 ${opens} / 闭 ${closes}）`)
}

console.log('④ 有回声的一轮 → 回声在最前、边界闭合、不破 injectMaxChars 预算')
{
  mod.__resetForTest?.()
  const { pushEcho } = await import('../lib/core/echo.js')
  const { takeEcho } = await import('../lib/core/echo.js')
  const cfg = store.loadConfig()
  const box = talkingBox('今天想聊聊比赛', '蓝桥杯嵌入式赛道要报什么组')
  const agent = makeAgent('session-r15-d', box, 2000)
  // 先装配一轮（建立粘性状态），再塞一条回声 + 推进一步（memo 按 (sessionId, seq) 缓存）
  textOf(agent)
  const longEcho = '刚记下的那条信息比较长：'.padEnd(120, '回')
  pushEcho('session-r15-d', longEcho)
  box.events.push(assistantEvent(4, '好，我记下了。'))
  const text = textOf(agent)
  ok(text.startsWith('## 刚记下的'), '回声段在注入最前面')
  ok(text.includes('刚记下的那条信息比较长'), '回声内容在场')
  const closes = (text.match(/<\/untrusted_data/g) ?? []).length
  const opens = (text.match(/<untrusted_data/g) ?? []).length
  eq(opens, closes, '回声 + 召回的边界标签全部闭合')
  ok(text.length <= Number(cfg.injectMaxChars) + 200, `总长 ${text.length} ≤ injectMaxChars(${cfg.injectMaxChars}) + 固定开销余量`)
  void takeEcho
}

/** 粗略提取「## 刚记下的」段长度（只用于日志展示，断言不依赖它）。 */
function renderEchoLen(text) {
  const at = text.indexOf('## 刚记下的')
  return at < 0 ? 0 : text.length - at
}
void renderEchoLen

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
