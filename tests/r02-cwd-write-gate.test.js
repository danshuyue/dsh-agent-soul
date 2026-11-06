/**
 * R02 · T3 写侧 cwd 收口（第二份审查 M-5）
 *
 * 这条测试就是把《07》§1.6 的 PoC **反过来**写成断言。
 *
 * 修复前的链路（实测成立）：
 *   GET  /state?cwd=<外部目录>        → rejected-unowned   ✓ R01 是真的
 *   POST /register {cwd:<外部目录>}   → 200
 *   GET  /state?cwd=<外部目录>        → path + preview 泄露 ✗
 *
 * 根因：`isOwnedCwd` 的条件①就是「命中已登记工作区」，而 `/register` 无条件信任
 * `body.cwd` —— 归属校验被自己喂饱了。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r02-cwdg-home-'))
const outside = mkdtempSync(join(tmpdir(), 'soul-r02-cwdg-out-'))
process.env.DSH_HOME = sandbox
process.env.DSH_SOUL_API_TOKEN = 'r02-cwd-write-gate-token-padded-32c'
delete process.env.DSH_SOUL_ALLOW_REMOTE_API

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

// 受害目录：一个「不该被读」的 AGENT.md，且必须在 DSH_HOME 之外
writeFileSync(join(outside, 'AGENT.md'), 'WRITE_GATE_SECRET_不该被读到\n', 'utf8')
mkdirSync(join(sandbox, 'agents', 'projects'), { recursive: true })

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const { registerApi, API_PREFIX } = await imp('api.js')
const { listWorkspaces } = await imp('core/registry.js')
const { setFallbackCwd } = await imp('tool.js')

let handler = null
registerApi({ webServer: { register(spec) { handler = spec.handler; return () => {} } } })

function fakeReq(method, url, body) {
  const listeners = new Map()
  const req = {
    method, url,
    headers: { host: '127.0.0.1:53397', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN },
    socket: { remoteAddress: '127.0.0.1' },
    on(e, cb) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); return req },
    destroy() {}
  }
  process.nextTick(() => {
    const fire = (e, v) => (listeners.get(e) ?? []).forEach((cb) => cb(v))
    if (body !== undefined) fire('data', Buffer.from(JSON.stringify(body), 'utf8'))
    fire('end')
  })
  return req
}
function fakeRes() {
  const out = { status: 0, body: '' }
  return { writeHead(c) { out.status = c }, end(c) { if (c != null) out.body += String(c) }, result: out }
}
async function call(method, p, body) {
  const res = fakeRes()
  await handler(fakeReq(method, `${API_PREFIX}${p}`, body), res)
  let json = null
  try { json = JSON.parse(res.result.body) } catch { /* 非 JSON */ }
  return { status: res.result.status, json }
}
const stateOf = async (cwd) => call('GET', `/state?cwd=${encodeURIComponent(cwd)}`)

// ---------------------------------------------------------------------------
console.log('① 未登记 + DSH_HOME 外 → /register 必须拒，且登记表不动')
// ---------------------------------------------------------------------------
{
  const before = listWorkspaces().length
  const reg = await call('POST', '/register', { cwd: outside })
  eq(reg.status, 400, 'POST /register {cwd: 外部目录} → 400')
  ok(String(reg.json?.error ?? '').includes('选择文件夹'), '错误文案指向「选择文件夹」这条正路')
  eq(reg.json?.cwdSource, 'rejected-unowned', 'cwdSource 说明是归属问题')
  eq(listWorkspaces().length, before, '登记表没有被写进任何东西')
  eq(listWorkspaces().some((w) => w.cwd === outside), false, '外部目录确实不在登记表里')
}

// ---------------------------------------------------------------------------
console.log('② 被拒之后仍然读不到（PoC 的核心断言）')
// ---------------------------------------------------------------------------
{
  const st = await stateOf(outside)
  eq(st.json?.workspace?.cwdSource, 'rejected-unowned', 'GET /state 仍是 rejected-unowned')
  eq(st.json?.persona?.preview, '', 'preview 为空')
  ok(!String(st.json?.persona?.preview ?? '').includes('WRITE_GATE_SECRET'), '没有泄露 AGENT.md 正文')
}

// ---------------------------------------------------------------------------
console.log('③ 宿主给的目录（模拟当前会话）→ 可以登记，登记后能读')
// ---------------------------------------------------------------------------
{
  setFallbackCwd(outside)
  const reg = await call('POST', '/register', { cwd: outside })
  eq(reg.status, 200, '宿主给的目录 POST /register → 200')
  const st = await stateOf(outside)
  eq(st.json?.workspace?.cwdSource, 'path', '登记后 cwdSource = path')
  ok(String(st.json?.persona?.preview ?? '').includes('WRITE_GATE_SECRET'), '登记后能读到（这是设计内的功能）')
}

// ---------------------------------------------------------------------------
console.log('④ 已登记目录的写操作保持可用（回归）')
// ---------------------------------------------------------------------------
{
  const written = await call('POST', '/memory', { scope: 'project', cwd: outside, action: 'write', text: 'R02 写侧收口回归用的一条记忆' })
  eq(written.status, 200, 'POST /memory 写入 → 200（已登记目录的写操作没被收口弄坏）')
  const persona = await call('POST', '/persona', { kind: 'project', cwd: outside, text: '# 测试\n项目人格' })
  eq(persona.status, 200, 'POST /persona 项目人格 → 200（已登记）')
}

// ---------------------------------------------------------------------------
console.log('⑤ 换一个没登记的目录 → 写接口全部不认')
// ---------------------------------------------------------------------------
{
  const another = mkdtempSync(join(tmpdir(), 'soul-r02-cwdg-other-'))
  writeFileSync(join(another, 'AGENT.md'), 'OTHER_SECRET\n', 'utf8')
  const persona = await call('POST', '/persona', { kind: 'project', cwd: another, text: '# x' })
  eq(persona.status, 400, 'POST /persona 未登记目录 → 400')
  eq(persona.json?.cwdSource, 'rejected-unowned', 'cwdSource 一致')

  const reg = await call('POST', '/register', { cwd: another })
  eq(reg.status, 400, 'POST /register 未登记目录 → 400')

  const st = await stateOf(another)
  eq(st.json?.workspace?.cwdSource, 'rejected-unowned', 'GET /state 仍然拒绝')
  rmSync(another, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
console.log('⑥ DSH_HOME 内目录：不需要登记就能读（条件②是有意的放行）')
// ---------------------------------------------------------------------------
{
  const inside = join(sandbox, 'inside-dir')
  mkdirSync(inside, { recursive: true })
  writeFileSync(join(inside, 'AGENT.md'), 'INSIDE_OK\n', 'utf8')
  const st = await stateOf(inside)
  eq(st.json?.workspace?.cwdSource, 'path', 'DSH_HOME 内目录直接放行')
  ok(String(st.json?.persona?.preview ?? '').includes('INSIDE_OK'), '能读到')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
rmSync(outside, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
