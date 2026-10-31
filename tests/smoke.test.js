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
  eq(segments.length, 4, '注册了四段（心情钩子 / 目的 / 记忆 / 人格）')
  const orders = segments.map((s) => s.order).sort((a, b) => a - b)
  eq(orders, [230, 240, 250, 260], 'order 是 230 / 240 / 250 / 260（心情钩子 → 目的 → 记忆 → 人格）')
  const names = segments.map((s) => s.name)
  ok(names.includes('soul:persona'), '有人格段')
  ok(names.includes('soul:memory'), '有记忆段')
  ok(names.includes('soul:purpose'), '有目的段')
  ok(names.includes('soul:mood'), '有心情钩子段（空串，零注入）')

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

console.log('工具：')
{
  eq(ctx.__tools.length, 2, '注册了两个工具（合并 action，省 schema 成本）')
  const memoryTool = ctx.__tools.find((t) => t.name === 'soul_memory')
  const goalTool = ctx.__tools.find((t) => t.name === 'soul_goal')
  ok(memoryTool !== undefined, 'soul_memory 在')
  ok(goalTool !== undefined, 'soul_goal 在')

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

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
