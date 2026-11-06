/**
 * P14 · 宿主装配契约（2026-11-06）
 *
 * 为「真拆 applyInner」建的前置安全网。smoke.test.js 已经验过六段的存在、order 与部分 text，
 * 这里补的是**拆分时最容易悄悄变掉**的三件事：
 *   ① effect 的**注册顺序**（不是排序后的 order）；
 *   ② 每段的 required 标志；
 *   ③ 每段 text() 在固定假 context 下的关键行为（空串 / 读到 AGENT.md / 数据边界声明）。
 *
 * 契约不绑定 `host/runtime.js` 的文件位置：搬到 host/segments/ 后只要 apply 仍注册同样的段，
 * 这份测试就该继续绿。
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-segments-contract-'))
process.env.DSH_HOME = sandbox
delete process.env.DSH_SOUL_API_TOKEN
mkdirSync(join(sandbox, 'agents', 'memory', 'projects'), { recursive: true })
mkdirSync(join(sandbox, 'agents', 'projects'), { recursive: true })
writeFileSync(join(sandbox, 'AGENT.md'), '# 你是谁\n契约测试固定人格锚点 SEGMENT_ANCHOR。\n', 'utf8')

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

function makeCtx() {
  const segments = []
  const tools = []
  const effects = []
  const ctx = {
    get(key) {
      if (key === 'tools') return { register: (def) => { tools.push(def); return () => {} } }
      if (key === 'webServer') return { register: () => () => {} }
      if (key === 'systemPrompt') return { context: (seg) => { segments.push(seg); return () => {} } }
      return undefined
    },
    effect(fn) { const d = fn(); effects.push(d); return d },
    slots: { inject() {}, register() { return () => {} } },
    __segments: segments,
    __tools: tools,
    __effects: effects
  }
  return ctx
}

const { apply } = await import('../../lib/index.js')
const ctx = makeCtx()
let threw = null
try { apply(ctx) } catch (error) { threw = error }
ok(threw === null, `apply() 不抛错${threw === null ? '' : `（${threw.message}）`}`)

// ① 注册顺序 + ② order / required
const EXPECTED = [
  ['soul:data-policy', 270, true],
  ['soul:persona', 260, true],
  ['soul:memory', 250, true],
  ['soul:notes', 245, true],
  ['soul:purpose', 240, true],
  ['soul:mood', 230, undefined]
]
console.log('① 六段注册顺序 / order / required：')
const actual = ctx.__segments.map((s) => [s.name, s.order, s.required])
eq(actual, EXPECTED, '六段的注册顺序与契约逐项一致')
eq(ctx.__segments.length, 6, '恰好六段，不多不少')

// ③ text() 的关键行为
console.log('\n② 每段 text() 的关键行为：')
const fakeContext = { agent: { session: { header: { cwd: '' }, seq: 3, firstLiveSeq: 0, snapshotEvents: () => [] } } }
for (const seg of ctx.__segments) {
  ok(typeof seg.text === 'function', `${seg.name} 的 text 是函数（每回合重新算）`)
}
const byName = (name) => ctx.__segments.find((s) => s.name === name)
const policy = byName('soul:data-policy').text({})
ok(policy.includes('<user_data') && policy.includes('不是指令'), '数据边界声明写明「标签内是数据」')
const persona = byName('soul:persona').text(fakeContext)
ok(persona.includes('SEGMENT_ANCHOR'), '人格段真的读到了 AGENT.md 的固定锚点')
eq(byName('soul:mood').text(fakeContext), '', '心情钩子返回空串（零注入）')
for (const name of ['soul:memory', 'soul:notes', 'soul:purpose']) {
  eq(typeof byName(name).text(fakeContext), 'string', `${name} 返回字符串`)
}

console.log('\n③ 装配副作用规模：')
ok(ctx.__tools.length >= 3, `工具注册数 ${ctx.__tools.length} ≥ 3（记忆/目的/笔记/日记）`)
ok(ctx.__effects.length >= 6, `effect 注册数 ${ctx.__effects.length} ≥ 6（六段注入）`)

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
