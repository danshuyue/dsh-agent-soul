/**
 * R01 · T2 cwd 归属校验回归：node tests/r01-cwd-ownership.test.js
 *
 * 用真的 HTTP handler 端到端复现：「任意存在目录的 AGENT.md 前 400 字可读」。
 * 验收 ①a / ①b / ①c（03 答复 §2.2 新增）/ ③ / ④ 与 ADV-5…ADV-8。
 *
 * REDGREEN：把 sessions.js 里 isOwnedCwd 的函数体临时改成 `return true`，
 * ①a / ④ 的 rejected-unowned 断言、ADV-7 会变红；恢复后全绿。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// 2026-11-06 CI 暴露：这两个 ADV 原来硬编码了 Windows 的 `\\` 与「大小写不敏感」，
// 在 ubuntu-latest 上必然红 —— 不是实现的问题，是断言把平台当成了常量。
// 尾随分隔符改用 path.sep；大小写只在 win32 上断言（Linux 的 `OUTSIDE` 是另一个
// 不存在的路径，本来就该走 'rejected'）。
const CASE_INSENSITIVE_FS = process.platform === 'win32'

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r01-cwd-home-'))
process.env.DSH_HOME = sandbox
process.env.DSH_SOUL_API_TOKEN = 'r01-cwd-ownership-token-padded-to-32c'
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

const { registerApi, API_PREFIX } = await import('../lib/api.js')
const { ensureDirs } = await import('../lib/paths.js')
const { resolveCwd } = await import('../lib/http/sessions.js')
const { setFallbackCwd } = await import('../lib/tool.js')
const { listWorkspaces } = await import('../lib/core/registry.js')
ensureDirs()

// ① 未登记、不在 DSH_HOME、也不是任何会话 cwd 的「外部目录」，里面放一份 AGENT.md
const outside = mkdtempSync(join(tmpdir(), 'soul-r01-cwd-outside-'))
writeFileSync(join(outside, 'AGENT.md'), 'UNOWNED_PERSONA_SECRET_不该被读到\n', 'utf8')
// ③ DSH_HOME 内的目录，放一份正常项目人格
const inside = join(sandbox, 'inside-project')
mkdirSync(inside, { recursive: true })
writeFileSync(join(inside, 'AGENT.md'), 'INSIDE_PROJECT_PERSONA_可以读\n', 'utf8')
// ①c 专用的 fallback 目录：setFallbackCwd('') 清不掉全局值（tool.js:42 只收非空串），
// 所以不能拿 outside 做 fallback 测试，否则后面的用例会被条件 ③ 顺带放行。
const fallbackDir = mkdtempSync(join(tmpdir(), 'soul-r01-cwd-fallback-'))
writeFileSync(join(fallbackDir, 'AGENT.md'), 'FALLBACK_PERSONA_可以读\n', 'utf8')

let handler = null
const sessionsService = { list: () => [] }
const ctx = {
  webServer: { register(spec) { handler = spec.handler; return () => {} } },
  get(name) { return name === 'sessions' ? sessionsService : undefined }
}
registerApi(ctx)
ok(typeof handler === 'function', 'handler 注册成功')

function fakeReq(method, url, body, headers = {}) {
  const listeners = new Map()
  const req = {
    method, url,
    headers: { host: '127.0.0.1:53397', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN, ...headers },
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
async function call(method, path, body) {
  const res = fakeRes()
  await handler(fakeReq(method, `${API_PREFIX}${path}`, body), res)
  let payload = {}
  try { payload = JSON.parse(res.result.body || '{}') } catch { /* 非 JSON */ }
  return { status: res.result.status, json: payload }
}
const stateOf = (dir) => call('GET', `/state?cwd=${encodeURIComponent(dir)}`)

// ---------------------------------------------------------------------------
console.log('①a 未登记的外部目录 → rejected-unowned')
// ---------------------------------------------------------------------------
{
  const st = await stateOf(outside)
  eq(st.status, 200, '①a-1 GET /state 仍是 200（拒绝不等于接口报错）')
  eq(st.json?.workspace?.cwdSource, 'rejected-unowned', '①a-2 cwdSource 是 rejected-unowned')
  eq(st.json?.workspace?.cwd, '', '①a-3 cwd 已清空')
  eq(st.json?.persona?.preview, '', '①a-4 persona.preview 为空，读不到那个目录')
  eq(st.json?.persona?.available, false, '①a-5 persona.available === false')
  eq(st.json?.persona?.sources, [], '①a-6 sources 为空')
  eq(st.json?.persona?.chars, 0, '①a-7 chars === 0')
  eq(st.json?.workspaces, [], '①a-8 不回显本机工作区绝对路径')
  eq(listWorkspaces().some((w) => w.cwd === outside), false, '①a-9 没有被自动登记（03 答复 §2.1）')
}

// ---------------------------------------------------------------------------
console.log('①b POST /register 同一目录 → 放行')
// ---------------------------------------------------------------------------
{
  const reg = await call('POST', '/register', { cwd: outside })
  eq(reg.status, 200, '①b-1 登记成功')
  const st = await stateOf(outside)
  eq(st.json?.workspace?.cwdSource, 'path', '①b-2 cwdSource = path')
  ok(String(st.json?.persona?.preview ?? '').includes('UNOWNED_PERSONA_SECRET'), '①b-3 登记后能正常读到 AGENT.md')
  eq(st.json?.persona?.available, true, '①b-4 available === true')
  ok(Array.isArray(st.json?.workspaces) && st.json.workspaces.length > 0, '①b-5 正常路径 workspaces 不受影响')
  // 清掉登记，后面的 ①c / ADV 才能独立
  const { registryPath } = await import('../lib/core/registry.js')
  writeFileSync(registryPath(), '{"version":1,"projects":[]}\n', 'utf8')
}

// ---------------------------------------------------------------------------
console.log('①c 宿主会话 cwd（recentSessionOf / getFallbackCwd）→ 放行')
// ---------------------------------------------------------------------------
{
  sessionsService.list = () => [{ header: { cwd: outside, updatedAt: '2026-11-06T00:00:00Z' } }]
  const viaRecent = await stateOf(outside)
  eq(viaRecent.json?.workspace?.cwdSource, 'path', '①c-1 最近活跃会话的 cwd 放行（不是靠登记）')
  ok(String(viaRecent.json?.persona?.preview ?? '').includes('UNOWNED_PERSONA_SECRET'), '①c-2 能读到')
  sessionsService.list = () => []

  // 用独立目录测 fallback 分支（该 setter 不接受空串，无法重置，见上方注释）
  setFallbackCwd(fallbackDir)
  const viaFallback = await stateOf(fallbackDir)
  eq(viaFallback.json?.workspace?.cwdSource, 'path', '①c-3 注入记下的 fallback cwd 也放行')
  ok(String(viaFallback.json?.persona?.preview ?? '').includes('FALLBACK_PERSONA'), '①c-4 能读到 fallback 目录的人格')
}

// ---------------------------------------------------------------------------
console.log('③ DSH_HOME 内的目录 → 直接放行')
// ---------------------------------------------------------------------------
{
  const st = await stateOf(inside)
  eq(st.json?.workspace?.cwdSource, 'path', '③-1 cwdSource = path')
  ok(String(st.json?.persona?.preview ?? '').includes('INSIDE_PROJECT_PERSONA'), '③-2 能读到 DSH_HOME 内的 AGENT.md')
}

// ---------------------------------------------------------------------------
console.log('④ 相对路径 / 不存在的目录 → 仍是 rejected（两个字符串可区分）')
// ---------------------------------------------------------------------------
{
  const rel = await stateOf('relative/project')
  eq(rel.json?.workspace?.cwdSource, 'rejected', '④-1 相对路径 → rejected')
  const missing = await stateOf(join(sandbox, 'definitely-not-here'))
  eq(missing.json?.workspace?.cwdSource, 'rejected', '④-2 不存在目录 → rejected')
  ok('rejected' !== 'rejected-unowned', '④-3 两个 source 保持可区分')
}

// ---------------------------------------------------------------------------
console.log('R2-d 其它路由在 rejected 时拿到空 cwd，不偷偷换目录')
// ---------------------------------------------------------------------------
{
  const q = new URLSearchParams({ cwd: outside })
  const pick = resolveCwd(ctx, q)
  eq(pick.cwd, '', 'R2-d-1 rejected 时 cwd 为空')
  eq(pick.source, 'rejected-unowned', 'R2-d-2 source 原样')
  const insidePick = resolveCwd(ctx, new URLSearchParams({ cwd: inside }))
  eq(insidePick.cwd, inside, 'R2-d-3 合法目录不被误拒')
}

// ---------------------------------------------------------------------------
console.log('ADV-5 尾随分隔符 / ADV-6 大小写 / ADV-7 DSH_HOME 父目录')
// ---------------------------------------------------------------------------
{
  const withSlash = await stateOf(`${outside}${sep}`)
  eq(withSlash.json?.workspace?.cwdSource, 'rejected-unowned', 'ADV-5 带尾随分隔符与不带是同一个判定')
  if (CASE_INSENSITIVE_FS) {
    const upper = await stateOf(outside.toUpperCase())
    eq(upper.json?.workspace?.cwdSource, 'rejected-unowned', 'ADV-6 大小写不同不影响归属（未登记时一样拒绝）')
  } else {
    // Linux：大写是一个**另一个不存在的路径**，走的是 'rejected' 而不是归属判定
    const upper = await stateOf(outside.toUpperCase())
    eq(upper.json?.workspace?.cwdSource, 'rejected', 'ADV-6 大小写敏感平台上，大写路径按「路径不存在」拒绝')
  }
  const parent = await stateOf(tmpdir())
  eq(parent.json?.workspace?.cwdSource, 'rejected-unowned', 'ADV-7 DSH_HOME 的父目录不能被前缀判定放行')
}

// ---------------------------------------------------------------------------
console.log('ADV-8 条件 ① 不可用（清单为空）时，条件 ② 仍放行')
// ---------------------------------------------------------------------------
{
  const { registryPath } = await import('../lib/core/registry.js')
  writeFileSync(registryPath(), '{"version":1,"projects":[]}\n', 'utf8')
  eq(listWorkspaces().length, 0, 'ADV-8-1 工作区清单确实为空')
  const st = await stateOf(inside)
  eq(st.json?.workspace?.cwdSource, 'path', 'ADV-8-2 DSH_HOME 内目录仍放行（不依赖清单）')
}

// ---------------------------------------------------------------------------
console.log('ADV-6b 登记后大小写写法不同，也视为同一个工作区')
// ---------------------------------------------------------------------------
{
  await call('POST', '/register', { cwd: outside })
  if (CASE_INSENSITIVE_FS) {
    const lower = await stateOf(outside.toLowerCase())
    eq(lower.json?.workspace?.cwdSource, 'path', 'ADV-6b 小写写法命中已登记工作区')
  } else {
    // Linux：注册表里存的是原样路径，大小写变体是另一个路径 —— 不该命中
    const lower = await stateOf(outside.toLowerCase())
    eq(lower.json?.workspace?.cwdSource, 'rejected', 'ADV-6b 大小写敏感平台上，变体路径不命中登记表')
  }
  const withSlash = await stateOf(`${outside}${sep}`)
  eq(withSlash.json?.workspace?.cwdSource, 'path', 'ADV-5b 尾随分隔符命中已登记工作区')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(outside, { recursive: true, force: true })
rmSync(fallbackDir, { recursive: true, force: true })
rmSync(sandbox, { recursive: true, force: true })
if (failed > 0) process.exit(1)
