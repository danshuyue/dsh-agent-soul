/**
 * 冒烟测试：node tests/smoke.test.js
 *
 * 用一个假的宿主 ctx 跑一遍 apply()，验证：
 *   ① 三段注入 + 心情钩子都注册上了，且 text() 真的返回内容；
 *   ② 两个工具都注册上了，schema 是「编译好的 JSON Schema」而不是 DSL；
 *   ③ 工具 execute 真能跑通（写一条记忆 → 读回来）；
 *   ④ 数据落在临时的 DSH_HOME 里，不碰真实的 ~/.dsh。
 *
 * 这一步的意义：真装进 DSH 要重启那台桌面，而重启前无法知道 apply 会不会在
 * 某个 ctx 服务上炸掉。这里用一个最小可用的假 ctx 提前把雷排掉。
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// 临时的 DSH_HOME：所有文件都写这里
const sandbox = mkdtempSync(join(tmpdir(), 'soul-smoke-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })
mkdirSync(join(sandbox, 'agents', 'projects'), { recursive: true })
writeFileSync(join(sandbox, 'AGENT.md'), '# 你是谁\n你是一个工程搭子，说话干脆。\n', 'utf8')

/** 假宿主：只实现插件真正用到的那几个方法。 */
function makeCtx() {
  const contextSegments = []
  const tools = []
  const apiRoutes = []
  const effects = []
  const slots = []

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
    slots: {
      inject(name, factory) { slots.push({ name, factory }) },
      register(definition, component) { slots.push({ definition, component }); return () => {} },
    },
    __contextSegments: contextSegments,
    __tools: tools,
    __apiRoutes: apiRoutes,
    __effects: effects,
    __slots: slots,
  }
  return ctx
}

const mod = await import('../lib/index.js')

console.log('插件导出：')
eq(mod.name, 'dsh-agent-soul', 'name 与 package.json 一致（目录名/name/patch 三处必须相同）')
ok(Array.isArray(mod.inject) && mod.inject.includes('systemPrompt'), 'inject 声明了 systemPrompt')
ok(mod.inject.includes('tools'), 'inject 声明了 tools')

console.log('apply：')
const ctx = makeCtx()
let threw = null
try {
  mod.apply(ctx)
} catch (error) {
  threw = error
}
ok(threw === null, `apply 没抛错${threw === null ? '' : `（${threw.message}）`}`)

console.log('注入段：')
{
  const segments = ctx.__contextSegments
  // 2026-11-04：多了第五段 soul:notes（笔记索引，order 245）。
  // 它刻意单独成段而不是拼进记忆段 —— 记忆段有粘性机制（话题没变就交回上次那段文本），
  // 笔记拼进去会出现「索引变了但注入还是旧的」，很难查。
  eq(segments.length, 5, '注册了五段（心情钩子 / 目的 / 笔记 / 记忆 / 人格）')
  const orders = segments.map((s) => s.order).sort((a, b) => a - b)
  eq(orders, [230, 240, 245, 250, 260], 'order 是 230 / 240 / 245 / 250 / 260（心情钩子 → 目的 → 笔记 → 记忆 → 人格）')
  const names = segments.map((s) => s.name)
  ok(names.includes('soul:persona'), '有人格段')
  ok(names.includes('soul:memory'), '有记忆段')
  ok(names.includes('soul:purpose'), '有目的段')
  ok(names.includes('soul:mood'), '有心情钩子段（空串，零注入）')
  ok(names.includes('soul:notes'), '有笔记索引段')

  const fakeContext = { agent: { session: { header: { cwd: '' }, seq: 3, firstLiveSeq: 0, snapshotEvents: () => [] } } }
  for (const segment of segments) {
    ok(typeof segment.text === 'function', `${segment.name} 的 text 是函数（每回合重新算）`)
  }
  const personaText = segments.find((s) => s.name === 'soul:persona').text(fakeContext)
  ok(personaText.includes('工程搭子'), '人格段真的读到了 AGENT.md')

  const memoryText = segments.find((s) => s.name === 'soul:memory').text(fakeContext)
  eq(typeof memoryText, 'string', '记忆段返回字符串（空卡时为空串，不塞空壳）')

  const purposeText = segments.find((s) => s.name === 'soul:purpose').text(fakeContext)
  eq(typeof purposeText, 'string', '目的段返回字符串')

  const moodText = segments.find((s) => s.name === 'soul:mood').text(fakeContext)
  eq(moodText, '', '心情钩子返回空串（不注入任何东西）')
}

// 2026-11-04：① 心情语气那条链原来是死的（index.js 调 moodState 却没导入它，
// 每轮抛 ReferenceError 又被裸 catch 吞掉），tone.test.js 直接测 takeTone，
// 绕过了调用点，所以一直测不出来。这一段走真实注入路径。
console.log('心情语气：真的能经 soul:memory 的 text() 走到投递（2026-11-04）：')
{
  const store = await import('../lib/store.js')
  const tone = await import('../lib/tone.js')

  tone.__resetToneForTest()
  const moodFile = store.resetMood('')
  moodFile.mood = 60 // 基准 70、阈值 8 → delta=-10 判 'low'
  store.saveMoodState('', moodFile)

  const sent = []
  const agent = {
    session: {
      header: { id: 'tone-session', cwd: '', seq: 3, firstLiveSeq: 0 },
      snapshotEvents: () => []
    },
    inbox: { append: (message) => { sent.push(message) } }
  }
  const memorySegment = ctx.__contextSegments.find((x) => x.name === 'soul:memory')
  ok(memorySegment !== undefined, '找到 soul:memory 段')

  // every 默认 7：pending 从 0 累到 7 要 8 轮才发一条
  for (let i = 0; i < 8; i += 1) memorySegment.text({ agent })

  eq(sent.length >= 1, true, '连跑 8 轮后投出了一条语气消息（改之前一条都投不出来）')
  eq(sent[0]?.source?.kind, 'soul-tone', '消息来源标记为 soul-tone')
  eq(typeof sent[0]?.id, 'string', '消息带了 id（inbox 需要）')

  const logText = existsSync(join(sandbox, 'agents', 'soul.log'))
    ? readFileSync(join(sandbox, 'agents', 'soul.log'), 'utf8')
    : ''
  ok(logText.includes('语气注入'), '日志里留下了「语气注入：low」')
  ok(!logText.includes('读心情失败'), '没有「读心情失败」（说明 moodState 这次真的导入成功了）')

  tone.__resetToneForTest()
  store.resetMood('')
}

// 2026-11-04 修 ③：collectForDiary 原来在 tick 里，被 memoryEnabled 的早退挡住了。
// 关掉记忆 → conversations/*.jsonl 不再增长 → 那天日记只能写成「今天没有对话」。
console.log('关掉记忆不能连带停掉日记素材（2026-11-04 修 ③）：')
{
  const store = await import('../lib/store.js')
  const diary = await import('../lib/diary.js')
  const paths = await import('../lib/paths.js')

  store.saveConfig({ memoryEnabled: false })

  const events = []
  const session = {
    header: { id: 'diary-material-test', cwd: '' },
    seq: 3,
    firstLiveSeq: 0,
    snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
  }
  const agent = { session, inbox: { append: () => {} } }
  const memorySegment = ctx.__contextSegments.find((x) => x.name === 'soul:memory')

  // 第一次只把游标推到当前位置（design：不回扫历史）
  memorySegment.text({ agent })

  // 之后来了一条真人消息
  // 事件必须带 payload.content —— collectForDiary 通过 messageContentOf(event) 取正文，
  // 只写 event.content 是取不到的（那是另一个字段）
  events.push({ seq: 4, type: 'user/message', payload: { content: [{ type: 'text', text: '今天把日记改成让我自己写了' }] } })
  session.seq = 4
  memorySegment.text({ agent })

  const file = paths.diaryJsonlPath(diary.todayKey(Date.now()))
  const collected = existsSync(file) ? readFileSync(file, 'utf8') : ''
  ok(collected.includes('日记改成让我自己写'), 'memoryEnabled=false 时对话仍然被收进 JSONL')
  eq(memorySegment.text({ agent }), '', '同一轮记忆段返回空串（记忆确实没注入）')

  store.saveConfig({ memoryEnabled: true })
}

console.log('工具：')
{
  // 2026-11-04：第三个工具 soul_note（笔记）。
  // 没有塞进 soul_memory 的 action，是因为记忆已经有五个 action，再混进「记一条」
  // 和「写一篇」两种语义，模型会反复拿不准 —— 那种混淆比多付几百字符划算多了。
  eq(ctx.__tools.length, 4, '注册了四个工具（记忆 / 惦记的事 / 笔记 / 日记）')
  const memoryTool = ctx.__tools.find((t) => t.name === 'soul_memory')
  const goalTool = ctx.__tools.find((t) => t.name === 'soul_goal')
  const noteTool = ctx.__tools.find((t) => t.name === 'soul_note')
  ok(memoryTool !== undefined, 'soul_memory 在')
  ok(goalTool !== undefined, 'soul_goal 在')
  ok(noteTool !== undefined, 'soul_note 在')
  ok(Array.isArray(noteTool?.parameters?.properties?.action?.enum), 'soul_note 的 action 是枚举（schema 是编译好的 JSON Schema）')
  // 2026-11-04：第四个工具 soul_diary —— 日记改成她自己写之后，她需要一个能落盘的入口。
  const diaryTool = ctx.__tools.find((t) => t.name === 'soul_diary')
  ok(diaryTool !== undefined, 'soul_diary 在（让她能自己写日记）')

  for (const tool of ctx.__tools) {
    ok(typeof tool.description === 'string' && tool.description.length > 10, `${tool.name} 有描述（决定模型会不会用）`)
    eq(tool.parameters.type, 'object', `${tool.name} 的 parameters 是编译好的 JSON Schema`)
    ok(Array.isArray(tool.parameters.required), `${tool.name} 的 required 是数组（不是写在属性里）`)
    ok(tool.output !== undefined && typeof tool.output.render === 'function', `${tool.name} 声明了 output.render`)
    ok(tool.parameters.additionalProperties === false, `${tool.name} 关掉了额外属性（少幻觉）`)
  }

  // 真的跑一次写入 → 读回
  const writeResult = await memoryTool.execute({
    action: 'write',
    text: '树树的目标是嵌入式工程师，偏软件方向',
    scope: 'global'
  })
  ok(writeResult.ok === true, `写入记忆成功${writeResult.ok ? '' : `（${writeResult.message}）`}`)

  const listResult = await memoryTool.execute({ action: 'list' })
  ok(Array.isArray(listResult.items) && listResult.items.length >= 1, '写进去之后 list 能查到')

  const recallResult = await memoryTool.execute({ action: 'recall', query: '嵌入式' })
  ok(Array.isArray(recallResult.items) && recallResult.items.length >= 1, 'recall 按关键词能搜到')

  const goalAdd = await goalTool.execute({ action: 'add', text: '把中断优先级搞明白', kind: 'question' })
  ok(goalAdd.ok === true, '加目标成功')
  const goalList = await goalTool.execute({ action: 'list' })
  ok(Array.isArray(goalList.items) && goalList.items.length >= 1, '目标能列出来')

  const bad = await memoryTool.execute({ action: '不存在的动作' })
  eq(bad.ok, false, '不认识的 action 返回 ok:false 而不是抛错')
}

console.log('记忆真的进了卡：')
{
  const memoryText = ctx.__contextSegments.find((s) => s.name === 'soul:memory').text({ agent: null })
  ok(memoryText.includes('嵌入式工程师'), '刚写的那条出现在注入文本里')
  ok(memoryText.includes('【记忆卡'), '带记忆卡标题')
}

console.log('子会话短路（2026-10-30：origin=subagent 不该注入整卡、不该提取）：')
{
  const memorySeg = ctx.__contextSegments.find((s) => s.name === 'soul:memory')
  const moodSeg = ctx.__contextSegments.find((s) => s.name === 'soul:mood')

  let seq = 0
  const events = []
  // 真机形状：header.origin 是 DSH 唯一允许的 'subagent' 标记
  // （校验见 dsh-session/lib/types/index.js 的 validateSessionHeader）
  const agent = {
    session: {
      header: { id: 'session-subagent', origin: 'subagent', cwd: '' },
      get seq() { return seq },
      firstLiveSeq: 0,
      snapshotEvents: (from, to) => events.filter((e) => e.seq >= from && (to === undefined || e.seq < to))
    }
  }

  memorySeg.text({ agent })   // 第一次只推游标
  events.push({
    type: 'user/message',
    seq: 1,
    data: {
      content: [{ type: 'text', text: '我是烟台大学机器人工程专业大二的学生' }],
      source: { kind: 'user' },
      role: 'user'
    }
  })
  seq = 1

  eq(memorySeg.text({ agent }), '', '子会话不注入记忆整卡')
  eq(moodSeg.text({ agent }), '', '子会话不跑心情判定（返回空串）')

  const cardFile = join(sandbox, 'agents', 'memory', 'global.json')
  const cardText = existsSync(cardFile) ? readFileSync(cardFile, 'utf8') : ''
  ok(!cardText.includes('烟台大学机器人工程专业大二'), '子会话说过的话没有被写进记忆卡')

  const projectDir = join(sandbox, 'agents', 'memory', 'projects')
  const wroteProject = existsSync(projectDir)
    && readdirSync(projectDir).some((name) => readFileSync(join(projectDir, name), 'utf8').includes('烟台大学机器人工程专业大二'))
  ok(wroteProject === false, '也没有写进任何项目卡')
}

console.log('kind 一路落到记录里（2026-10-30）：')
{
  const store = await import('../lib/store.js')
  const cwd = join(sandbox, 'kind-project')
  // 2026-10-30：落库加了硬闸（任务/进度丢弃 + 按 kind 分档门槛 42/70），
  // 所以这里的分值必须跟着门槛走：fact 43 仍然远低于全局提升线 62，
  // 照样能验证「fact 低分也进全局卡」；feeling 90 验证高分通道。
  // 第二条原来带「今天」—— 那是时间锚点，新规则下会被拒收，换掉。
  const report = store.writeAutoMemories(cwd, [
    { text: '树树的专业是机器人工程（kind 测试 A）', kind: 'fact', importance: 43 },
    { text: '树树心情一直不错（kind 测试 B）', kind: 'feeling', importance: 90 },
    { text: '树树偏好夜里写代码（kind 测试 C）', kind: 'preference', importance: 50 }
  ])
  eq(report.written, 3, '三条都写进了项目卡')
  eq(report.promoted, 2, 'fact（低分也算）+ 高分那两条进全局卡')

  const project = store.projectCard(cwd)
  const kinds = project.records.map((r) => r.kind).sort()
  eq(kinds, ['fact', 'feeling', 'preference'], '项目卡里每条都带着自己的 kind')

  const globalKinds = store.globalCard().records.filter((r) => r.text.includes('kind 测试')).map((r) => r.kind).sort()
  eq(globalKinds, ['fact', 'feeling'], '提升到全局卡的那两条也带着 kind')
}


console.log('API：')
{
  // 两组：JSON 接口 + 心情表情图（缺了图，设置页的心情卡会空一块）
  eq(ctx.__apiRoutes.length, 2, '注册了两组 HTTP 路由')
  const route = ctx.__apiRoutes.find((r) => r.path === '/api/soul')
  ok(route !== undefined, '设置页接口路径正确')
  ok(typeof route.handler === 'function', '有 handler')
  const assets = ctx.__apiRoutes.find((r) => r.path === '/dsh-agent-soul')
  ok(assets !== undefined, '表情图路由注册了')
  ok(typeof assets.handler === 'function', '表情图有 handler')
}

console.log('幂等（重复 apply 不该炸）：')
{
  const ctx2 = makeCtx()
  let again = null
  try {
    mod.apply(ctx2)
  } catch (error) {
    again = error
  }
  ok(again === null, `第二次 apply 也没抛错${again === null ? '' : `（${again.message}）`}`)
}

console.log('清理：')
{
  for (const effect of ctx.__effects) {
    if (typeof effect === 'function') {
      try { effect() } catch { /* 清理失败不算测试失败 */ }
    }
  }
  ok(true, 'disposer 可调用')
  rmSync(sandbox, { recursive: true, force: true })
}

console.log('\n全局：没有漏导入（2026-11-04）：')
{
  // ① 那个 bug 的形态是「调了没导入的函数 → ReferenceError → 被裸 catch 吞掉」。
  // 这种错语法检查发现不了，单测也测不到（除非覆盖调用点）。
  // 这里把整个 apply + text() 跑下来的日志翻一遍：任何 `x is not defined`
  // 都说明某条链上有东西在静默失败。
  const logFile = join(sandbox, 'agents', 'soul.log')
  const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''
  const undefinedHits = logText.split('\n').filter((line) => /is not defined|is not a function/.test(line))
  eq(undefinedHits.length, 0, `日志里没有「未定义/不是函数」类错误${undefinedHits.length > 0 ? `：${undefinedHits[0].slice(0, 120)}` : ''}`)
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
