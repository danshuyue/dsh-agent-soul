/**
 * 记忆写入回声测试（2026-11-04）：node tests/echo.test.js
 *
 * 守六件事（对应这次改造的验收点）：
 *   ① 写入成功后，**同一会话下一轮**注入里含「## 刚记下的」和该条文本；
 *   ② 再下一轮不再出现（一次性，取过就清空）；
 *   ③ 回声存在时粘性召回失效（同 query 也重新渲染，能看见新写的那条）；
 *   ④ 拿不到 sessionId 时不留回声（不能用全局 key 兜底）；
 *   ⑤ 每会话超过 3 条 / 600 字时丢最旧的，单条超长先截断；
 *   ⑥ memoryRecall:false 下回声仍然出现（写回执不是召回）。
 *
 * 为什么必须走真的 `soul:memory` 段和真的 `soul_memory` 工具：
 *   回声是「工具执行时写、下一轮装配时读」的跨 step 状态，单独测缓冲证明不了
 *   「下一轮真的看得见」。数据全部落在临时 DSH_HOME，不碰真实的 ~/.dsh。
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

const sandbox = mkdtempSync(join(tmpdir(), 'soul-echo-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })
writeFileSync(join(sandbox, 'AGENT.md'), '# 你是谁\n测试用搭子。\n', 'utf8')

const store = await import('../lib/store.js')
const mod = await import('../lib/index.js')
const echo = await import('../lib/echo.js')

/** 假宿主：只实现插件真正用到的那几个方法（照抄 sticky.test.js）。 */
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
    __tools: tools,
    __effects: effects
  }
  return ctx
}

/**
 * 假 agent：跟 sticky.test.js 同款。
 * seqOffset 用来把不同用例的轮次键错开，避免命中 memoPerStep 的缓存。
 */
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

/** 已经在对话中的会话：两条真人消息 → 不是首轮。 */
function talkingBox(firstText, lastText) {
  return { events: [userEvent(1, firstText), assistantEvent(2, '嗯，我在。'), userEvent(3, lastText)] }
}

/** 工具 execute 的 context：跟真宿主同源，session.header.id / cwd。 */
function toolContext(agent) {
  return { agent }
}

const ctx = makeCtx()
mod.apply(ctx)
const memorySegment = ctx.__contextSegments.find((segment) => segment.name === 'soul:memory')
const memoryTool = ctx.__tools.find((tool) => tool.name === 'soul_memory')
ok(memorySegment !== undefined, 'soul:memory 段注册上了')
ok(memoryTool !== undefined, 'soul_memory 工具注册上了')
const textOf = (agent) => memorySegment.text({ agent })

// 默认配置显式落一次，别让上一个测试留下的 DSH_HOME 影响（这里本来就是临时目录）。
store.saveConfig({ memoryRecall: true })

console.log('① 写入后下一轮注入含「刚记下的」与该条文本')
{
  mod.__resetForTest()
  const box = talkingBox('今天想聊点事', '随便说一句开场')
  const agent = makeAgent('session-echo-a', box, 1000)
  // 先装配一次（模拟工具调用之前的那一步），这一份里不该有回声。
  const before = textOf(agent)
  ok(before.includes('## 刚记下的') === false, '写入前的那一步没有回声')

  const recordText = '树树说下周三要交嵌入式的实验报告，记得提醒他'
  const ctxWithAgent = toolContext(agent)
  const written = await memoryTool.execute({ action: 'write', text: recordText }, ctxWithAgent)
  eq(written.ok, true, 'soul_memory write 成功')

  // 她回了话（工具调用会产生 assistant/message）→ 下一轮。
  box.events.push(assistantEvent(4, '好，我记下了。'))
  const next = textOf(agent)
  ok(next.includes('## 刚记下的'), '下一轮注入里出现了「## 刚记下的」')
  ok(next.includes('下周三要交嵌入式的实验报告'), '回执里就是刚写的那条文本')
  // 同一个 step 内装配两次必须逐字节相同（memo 不能第二次把回声吃掉）。
  eq(textOf(agent), next, '同一 step 第二次装配仍返回含回声的同一份文本')
}

console.log('② 再下一轮不再出现（一次性）')
{
  const box = talkingBox('今天想聊点事', '随便说一句开场')
  const agent = makeAgent('session-echo-b', box, 2000)
  const recordText = '树树喜欢把笔记写在纸上再拍照存档'
  await memoryTool.execute({ action: 'write', text: recordText }, toolContext(agent))
  box.events.push(assistantEvent(4, '好，我记下了。'))
  const first = textOf(agent)
  ok(first.includes('## 刚记下的'), '写入后的下一轮有回声')
  box.events.push(assistantEvent(5, '还有别的事吗？'))
  const second = textOf(agent)
  ok(second.includes('## 刚记下的') === false, '再下一轮回声已经消失')
  // 不能断言「正文完全不出现」：写进卡里的那条本来就可能被正常召回带出来，
  // 那属于召回，不属于回执。这里只守「回声小节不再出现」。
}

console.log('③ 回声存在时粘性召回失效（同 query 也重新渲染）')
{
  mod.__resetForTest()
  const box = talkingBox('今天想聊点事', '还是刚才那个话题')
  const agent = makeAgent('session-echo-c', box, 3000)
  // 先让粘性状态建立起来：第一次装配之后，同 query 本该直接复用。
  const seed = textOf(agent)
  ok(seed.includes('## 刚记下的') === false, '先有一次不含回声的基础文本')

  await memoryTool.execute({ action: 'write', text: '第一条回声：树树想暑假去学游泳' }, toolContext(agent))
  box.events.push(assistantEvent(4, '记下了。'))
  const withFirst = textOf(agent)
  ok(withFirst.includes('第一条回声：树树想暑假去学游泳'), '第一次写入的回声出现了')

  // 同 query（Jaccard 应为 1.0），但又有新回声：若粘性仍复用就会退回基础文本、看不见第二条。
  await memoryTool.execute({ action: 'write', text: '第二条回声：树树说游泳要报早上七点的班' }, toolContext(agent))
  box.events.push(assistantEvent(5, '也记下了。'))
  const withSecond = textOf(agent)
  ok(withSecond.includes('## 刚记下的'), '第二条回声仍在（没有被粘性复用盖掉）')
  ok(withSecond.includes('第二条回声：树树说游泳要报早上七点的班'), '同 query 下仍重新渲染出了新写的那条')
  ok(withSecond !== withFirst, '有回声时没有返回上一次缓存的字符串')
}

console.log('④ 拿不到 sessionId 时不留回声')
{
  mod.__resetForTest()
  const box = talkingBox('今天想聊点事', '还是刚才那个话题')
  const agent = makeAgent('session-echo-d', box, 4000)
  textOf(agent)
  // 不带 context：真机上某些宿主拿不到会话信息，这时宁可没有回执，也不能拿全局 key。
  const written = await memoryTool.execute({ action: 'write', text: '这条没有会话 id，不该有回声' })
  eq(written.ok, true, '拿不到 sessionId 时写入本身仍然成功')
  eq(echo.__echoStatsForTest().size, 0, '回声缓冲里一个会话都没留下')
  box.events.push(assistantEvent(4, '记下了。'))
  const next = textOf(agent)
  ok(next.includes('## 刚记下的') === false, '下一轮注入里没有回声')
}

console.log('⑤ 超过 3 条 / 600 字时的截断与淘汰')
{
  mod.__resetForTest()
  const sid = 'session-echo-limits'
  // 四条 → 只留最近三条，最旧的那条被丢掉。
  for (const text of ['第一条', '第二条', '第三条', '第四条']) echo.pushEcho(sid, text)
  const kept = echo.takeEcho(sid)
  eq(kept.map((item) => item.text), ['第二条', '第三条', '第四条'], '每会话最多留 3 条（丢最旧的）')

  // 三条各 250 字 = 750 > 600：继续丢最旧的，总数压回 600 以内。
  for (const text of ['甲'.repeat(250), '乙'.repeat(250), '丙'.repeat(250)]) echo.pushEcho(sid, text)
  const capped = echo.takeEcho(sid)
  ok(capped.length <= 3, `总字数超限时条数也受 3 条约束（实际 ${capped.length} 条）`)
  const totalChars = capped.reduce((sum, item) => sum + item.text.length, 0)
  ok(totalChars <= 600, `总字数不超过 600（实际 ${totalChars}）`)
  eq(capped.map((item) => item.text[0]), ['乙', '丙'], '超出总字数时丢最旧的「甲」')

  // 单条自身超过 600：先截断，不能把整个会话的额度一次吃光。
  echo.pushEcho(sid, '丁'.repeat(700))
  const single = echo.takeEcho(sid)
  eq(single.length, 1, '单条超长仍然只有一条')
  eq(single[0].text.length, 600, '单条超长被截到 600 字')
  eq(echo.takeEcho(sid).length, 0, '取过一次就清空（一次性）')
}

console.log('⑥ memoryRecall:false 下回声仍然出现')
{
  mod.__resetForTest()
  store.saveConfig({ memoryRecall: false })
  try {
    const box = talkingBox('今天想聊点事', '还是刚才那个话题')
    const agent = makeAgent('session-echo-e', box, 5000)
    textOf(agent)
    await memoryTool.execute({ action: 'write', text: '关掉召回也不影响这条写回执' }, toolContext(agent))
    box.events.push(assistantEvent(4, '记下了。'))
    const next = textOf(agent)
    ok(next.includes('## 刚记下的'), 'memoryRecall:false 时回声仍然出现')
    ok(next.includes('关掉召回也不影响这条写回执'), '回声正文在')
    ok(next.includes('## 想起来了') === false, '召回确实关着（没有相关区）')
  } finally {
    store.saveConfig({ memoryRecall: true })
  }
}

console.log('⑦ 回声算进 injectMaxChars 预算')
{
  // 额外一条（不属于六条验收点，但「算进预算」是硬要求，不能只是看起来像）。
  mod.__resetForTest()
  store.saveConfig({ memoryRecall: true, injectMaxChars: 400 })
  try {
    const box = talkingBox('今天想聊点事', '预算很小的时候也要守住上限')
    const agent = makeAgent('session-echo-f', box, 6000)
    textOf(agent)
    await memoryTool.execute(
      { action: 'write', text: `预算测试：${'长'.repeat(200)}` },
      toolContext(agent)
    )
    box.events.push(assistantEvent(4, '记下了。'))
    const next = textOf(agent)
    ok(next.includes('## 刚记下的'), '小预算下回声仍然出现')
    ok(next.length <= 400, `回执 + 召回不超过 injectMaxChars（实际 ${next.length} / 400）`)
  } finally {
    store.saveConfig({ memoryRecall: true, injectMaxChars: 3200 })
  }
}

console.log('清理：')
{
  for (const effect of ctx.__effects) {
    if (typeof effect === 'function') {
      try { effect() } catch { /* 清理失败不算测试失败 */ }
    }
  }
  mod.__resetForTest()
  rmSync(sandbox, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
