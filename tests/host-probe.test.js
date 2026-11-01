/**
 * host-probe.test.js —— 宿主形状变了必须喊出来（2026-11-01，审计 C7）
 *
 * 这个文件守的是当年那次**静默失效**：正文其实在 data.content，
 * 代码写成 data.message.content，可选链一路吃到 undefined ——
 * 扫描在跑、候选恒 0、日志一句不报。
 *
 * 所以自检的判据是「能不能真的抠出文字」，不是「函数在不在」。
 */
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-host-'))
process.env.DSH_HOME = sandbox
mkdirSync(join(sandbox, 'agents'), { recursive: true })

const host = await import('../lib/host.js')

let pass = 0
let fail = 0
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) } else { fail += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  ok(JSON.stringify(actual) === JSON.stringify(expected), `${name}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`)
}

const msg = (text, extra = {}) => ({
  type: 'user/message',
  seq: 1,
  data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user', ...extra }
})

console.log('\n① 正文抽取：三种宿主写法都要认')
{
  eq(host.firstTextOf(msg('现在在 data.content')), '现在在 data.content', '现在：data.content')
  eq(host.firstTextOf({ data: { message: { content: [{ type: 'text', text: '老格式' }] } } }), '老格式', '老格式：data.message.content')
  eq(host.firstTextOf({ payload: { content: 'payload 写法' } }), 'payload 写法', '别的宿主：payload.content')
  eq(host.firstTextOf({ data: { content: [{ type: 'reasoning', text: '只是想想' }] } }), '', 'reasoning 不算正文')
  eq(host.firstTextOf(null), '', '空事件不炸')
}

console.log('\n② 子会话识别：只认明确的子会话标记')
{
  eq(host.isSubagentAgent({ session: { header: { origin: 'subagent' } } }), true, 'origin')
  eq(host.isSubagentAgent({ session: { header: { agentKind: 'subagent' } } }), true, 'agentKind')
  // ⚠️ fork 出来的主会话也可能带 parentSessionId。判成子会话 → 整场不注入记忆（静默失忆），
  // 所以这条判据**故意不认** parentSessionId。
  eq(host.isSubagentAgent({ session: { header: { parentSessionId: 'parent-1' } } }), false,
    '只有 parentSessionId 不算子会话（fork 出来的主会话会被误判成失忆）')
  eq(host.isSubagentAgent({ session: { header: { origin: 'user' } } }), false, '普通会话不算')
  eq(host.isSubagentAgent({}), false, '拿不到 header 不算')
}

const agentWith = (events) => ({
  session: {
    header: { id: 'session-probe' },
    seq: events.length,
    snapshotEvents: () => events
  }
})

console.log('\n③ 形状正常 → 自检通过')
{
  const r = host.probeHost(agentWith([msg('随便说点什么'), msg('再说一句')]))
  eq(r.ok, true, '通过')
  eq(r.checks.filter((c) => c.ok !== true).length, 0, '没有失败项')
}

console.log('\n④ 有事件但一条正文都抠不出来 → 必须判失败')
{
  // 这就是当年那次事故的形状：函数在、事件在、正文位置变了
  const broken = [
    { type: 'user/message', seq: 1, data: { messageContent: [{ type: 'text', text: '藏在别处' }] } },
    { type: 'assistant/message', seq: 2, data: { blocks: [{ type: 'text', text: '也藏在别处' }] } }
  ]
  const r = host.probeHost(agentWith(broken))
  eq(r.ok, false, '判失败')
  const names = r.checks.filter((c) => !c.ok).map((c) => c.name)
  ok(names.includes('事件正文可解析'), '点名「事件正文可解析」')
}

console.log('\n⑤ 没有 snapshotEvents → 判失败（而不是当成"没有事件"）')
{
  const r = host.probeHost({ session: { header: { id: 'x' } } })
  eq(r.ok, false, '判失败')
  ok(r.checks.some((c) => c.name === 'session.snapshotEvents' && !c.ok), '点名 snapshotEvents')
}

console.log('\n⑥ 失败要落盘给设置页看，恢复正常后红灯要撤掉')
{
  host.__resetHostProbeForTest()
  const file = host.HOST_PROBE_FILE()
  const r1 = host.probeHostOnce(agentWith([{ type: 'user/message', seq: 1, data: {} }]))
  eq(r1.ok, false, '第一次自检失败')
  ok(existsSync(file), '落了 host-probe.json')
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  ok(Array.isArray(saved.failed) && saved.failed.length > 0, '文件里有失败项')
  eq(host.hostProbeState() !== null, true, 'hostProbeState 读得到')

  // 同一个会话不重复自检（不刷屏）
  eq(host.probeHostOnce(agentWith([{ type: 'user/message', seq: 1, data: {} }])), null, '同一会话只查一次')

  // 换一个正常会话：红灯要撤
  host.__resetHostProbeForTest()
  const r2 = host.probeHostOnce({ session: { header: { id: 'ok-session' }, snapshotEvents: () => [msg('正常')] } })
  eq(r2.ok, true, '正常会话通过')
  eq(host.hostProbeState(), null, '旧的红灯被撤掉')
  rmSync(file, { force: true })
}

console.log('\n⑦ 自检必须用「真正在用的那个抽取函数」')
{
  // 宿主形状好、host.js 的容错抽取也抠得出字，但**实际提取那套**抠不出来 ——
  // 这种"两边分叉"正是当年查不出来的原因，自检必须跟着提取走。
  const good = agentWith([msg('正文在这儿')])
  eq(host.probeHost(good).ok, true, '默认抽取函数下通过')
  const diverged = host.probeHost(good, { extractText: () => '' })
  eq(diverged.ok, false, '换了会返回空串的抽取函数 → 判失败')
  ok(diverged.checks.some((c) => c.name === '事件正文可解析' && !c.ok), '点名的是同一条')
}

console.log(`\n结果：${pass} 过 / ${fail} 败`)
process.exit(fail === 0 ? 0 : 1)
