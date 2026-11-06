/**
 * 装配证词测试（2026-11-02）：node tests/attest.test.js
 *
 * 守的是「不许再假成功」这条线：
 *   ① 四段都在 → full；少一段 → partial；全不在 → absent；
 *   ② 「在但在但没字」和「压根不在」必须分开报（blank vs missing）——
 *      前者是 text() 返回了空串，后者是注册/过滤掉了，修法完全不同；
 *   ③ complete 冻结（sections 被压成单段）要被记下来，但不能污染
 *      「soul 有没有进去」的结论 —— soul 走 contexts，不受它影响；
 *   ④ 异常入参不许抛（诊断把自己搞崩比没有诊断更糟）；
 *   ⑤ 历史是环形的，不会无限涨；
 *   ⑥ observed=false 只表示「没观测到」，不能和「没注入」混为一谈。
 *
 * 数据落在临时 DSH_HOME，不碰真实的 ~/.dsh。
 */
import { mkdirSync, mkdtempSync } from 'node:fs'
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

const sandbox = mkdtempSync(join(tmpdir(), 'soul-attest-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

const { recordAssembly, attestationState, __resetAttestationForTest } = await import('../lib/attest.js')

/** 造一次装配结果：contexts 里放谁由入参决定。 */
function assemblyOf(contexts, sections = [{ name: 'persona:prefix', text: 'x' }, { name: 'doctrine', text: 'y' }]) {
  return { sections, contexts, tools: [], variables: {} }
}
function ctxItem(name, text) {
  return { name, text, interpolate: false }
}
const agentContext = (id = 'sess-1') => ({ agent: { session: { header: { id, cwd: 'D:\\proj' } } } })

console.log('四段齐全（2026-11-04 加了 soul:notes）：')
{
  __resetAttestationForTest()
  const snap = recordAssembly(
    assemblyOf([
      ctxItem('soul:persona', '我是糖糖'),
      ctxItem('soul:memory', '记得树树'),
      ctxItem('soul:notes', '写过笔记'),
      ctxItem('soul:purpose', '惦记着')
    ]),
    agentContext()
  )
  eq(snap.verdict, 'full', '四段都在且非空 → full')
  eq(snap.totalChars, 4 + 4 + 4 + 3, '字符数是四段之和')
  eq(snap.sessionId, 'sess-1', '记下了 sessionId')
  eq(snap.cwd, 'D:\\proj', '记下了 cwd')
  eq(snap.collapsed, false, '多段 section 不算 complete 冻结')
  eq(snap.items.map((i) => i.state), ['present', 'present', 'present', 'present'], '四条都是 present')
}

console.log('少一段 / 空串 / 全缺席：')
{
  __resetAttestationForTest()
  const partial = recordAssembly(
    assemblyOf([ctxItem('soul:persona', '我是糖糖'), ctxItem('soul:purpose', '惦记着')]),
    agentContext()
  )
  eq(partial.verdict, 'partial', '缺记忆 → partial')
  eq(partial.items.find((i) => i.name === 'soul:memory').state, 'missing', '缺的那段报 missing')

  __resetAttestationForTest()
  const blank = recordAssembly(
    assemblyOf([ctxItem('soul:persona', '我是糖糖'), ctxItem('soul:memory', ''), ctxItem('soul:purpose', '惦记着')]),
    agentContext()
  )
  eq(blank.verdict, 'partial', '空串也算没进去')
  eq(blank.items.find((i) => i.name === 'soul:memory').state, 'blank', '空串报 blank，不报 missing')

  __resetAttestationForTest()
  const absent = recordAssembly(assemblyOf([ctxItem('other:thing', '无关')]), agentContext())
  eq(absent.verdict, 'absent', '一段都不在 → absent')
  eq(absent.totalChars, 0, 'absent 时总字符 0')
}

console.log('complete 冻结：')
{
  __resetAttestationForTest()
  // 内置段被压成单段，但 soul 的 contexts 仍在 —— 这正是要证明的那件事
  const snap = recordAssembly(
    assemblyOf(
      [
        ctxItem('soul:persona', '我是糖糖'), ctxItem('soul:memory', '记得树树'),
        ctxItem('soul:notes', '写过笔记'), ctxItem('soul:purpose', '惦记着')
      ],
      [{ name: 'minimal:persona', text: 'You are a helpful software engineer assistant.' }]
    ),
    agentContext()
  )
  eq(snap.collapsed, true, 'sections 只剩一段且不是 soul → 判定为 complete 冻结')
  eq(snap.verdict, 'full', 'complete 冻结不影响 soul 走 contexts 的结论')
}

console.log('异常入参不许抛：')
{
  __resetAttestationForTest()
  eq(recordAssembly(null, agentContext()), null, 'assembly 为 null 返回 null 不抛')
  eq(recordAssembly(undefined, agentContext()), null, 'assembly 为 undefined 返回 null 不抛')
  const noCtx = recordAssembly(assemblyOf([]), undefined)
  eq(noCtx.sessionId, '', '没有 context 时 sessionId 为空串')
  eq(noCtx.verdict, 'absent', '没有 context 时结论是 absent')
  const weird = recordAssembly({ sections: 'nope', contexts: [null, 42, { name: 'soul:persona', text: 123 }] }, agentContext())
  eq(weird.items.find((i) => i.name === 'soul:persona').state, 'blank', 'text 不是字符串时按空串处理')
  ok(recordAssembly(assemblyOf([ctxItem('soul:persona', 'x')]), agentContext()) !== null, '普通入参仍然返回快照')
}

console.log('历史环形：')
{
  __resetAttestationForTest()
  for (let i = 0; i < 30; i += 1) {
    recordAssembly(assemblyOf([ctxItem('soul:persona', 'a')]), agentContext(`sess-${i}`))
  }
  const state = attestationState({ includeHistory: true })
  eq(state.history.length, 20, '历史最多留 20 条（显式要才给）')
  // 2026-11-06 审计 P2-14：sessionId 换成短哈希摘要，不再是宿主内部 id
  ok(typeof state.last.sessionRef === 'string' && state.last.sessionRef.length === 8, 'last 只回 sessionRef 短哈希')
  eq(state.last.sessionId, undefined, '不再回原始 sessionId')
  eq(attestationState().history.length, 0, '默认不回历史（少一个枚举面）')
  eq(state.observed, true, '观测到过就是 true')
}

console.log('observed 的语义：')
{
  __resetAttestationForTest()
  const state = attestationState()
  eq(state.observed, false, '一条都没有时 observed=false')
  eq(state.last, null, 'last 为 null')
  eq(state.watched.map((w) => w.name), ['soul:persona', 'soul:memory', 'soul:notes', 'soul:purpose'], 'watched 是那四段（笔记段不能被漏掉）')
}

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed > 0) process.exitCode = 1
