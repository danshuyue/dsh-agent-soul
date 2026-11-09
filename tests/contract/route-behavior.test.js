/**
 * P14 · HTTP 路由行为契约（2026-11-06）
 *
 * 为「真拆 registerApi」建的前置安全网。现有门禁只钉外部导出 / 依赖图 / 记忆渲染，
 * 抓不住「某个路由的状态码变了」「少注册了一个分支」。这里补两层：
 *
 *   ① 行为层：用假 req/res 真打 27 个分支 + 4 条中间件链，钉住 status 与 ok。
 *      每个 case 都设计成尽早返回（缺参数 / 非法值），不触发 spawn、LLM 与真实用户数据。
 *      `/pick` 会弹系统文件夹框，故意不跑，交给 ② 覆盖。
 *   ② 结构层：递归扫描 lib/ 全部模块收集 `route === '…' && req.method === '…'`，
 *      钉住 28 条分支清单。搬文件到 routes/ 后仍然收得齐，但漏分支 / 改 method 会红。
 *
 * 基线是**内联硬编码**的：想改状态码就必须显式改这个文件的契约表，PR 里看得见。
 */
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-route-contract-'))
process.env.DSH_SOUL_API_TOKEN = 'soul-route-contract-token-padded-to-32-c'
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

const { registerApi, API_PREFIX } = await import('../../lib/api.js')
const { ensureDirs } = await import('../../lib/paths.js')
ensureDirs()

let handler = null
registerApi({ webServer: { register(spec) { handler = spec.handler; return () => {} } } })
ok(typeof handler === 'function', 'registerApi 注册了 handler')

function fakeReq(method, url, body, headers = {}, remoteAddress = '127.0.0.1') {
  const listeners = new Map()
  const req = {
    method,
    url,
    headers: {
      host: '127.0.0.1:53397',
      'x-soul-token': process.env.DSH_SOUL_API_TOKEN,
      ...headers
    },
    socket: { remoteAddress },
    on(event, cb) {
      if (!listeners.has(event)) listeners.set(event, [])
      listeners.get(event).push(cb)
      return req
    },
    destroy() {}
  }
  process.nextTick(() => {
    const fire = (event, value) => (listeners.get(event) ?? []).forEach((cb) => cb(value))
    if (body !== undefined) fire('data', Buffer.from(JSON.stringify(body), 'utf8'))
    fire('end')
  })
  return req
}
function fakeRes() {
  const out = { status: 0, body: '' }
  return {
    writeHead(code) { out.status = code },
    end(chunk) { if (chunk !== undefined && chunk !== null) out.body += String(chunk) },
    result: out
  }
}
async function call(method, path, body, headers, remoteAddress) {
  const res = fakeRes()
  await handler(fakeReq(method, `${API_PREFIX}${path}`, body, headers, remoteAddress), res)
  let payload = {}
  try { payload = JSON.parse(res.result.body || '{}') } catch { /* 非 JSON 响应 */ }
  return { status: res.result.status, ok: payload.ok }
}

// ---------------------------------------------------------------------------
// ① 行为基线：[method, path, body, 期望 status, 期望 ok]
// ---------------------------------------------------------------------------
const CASES = [
  ['GET', '/attestation', undefined, 200, true],
  ['GET', '/persona', undefined, 200, true],
  ['POST', '/persona', {}, 200, true],
  ['POST', '/open', { kind: 'project', cwd: '' }, 400, false],
  ['GET', '/state', undefined, 200, true],
  ['POST', '/config', { __unknown_key__: 1 }, 200, true],
  ['POST', '/secret', { name: 'soul_api_token', value: 'x' }, 400, false],
  ['GET', '/memory', undefined, 200, true],
  ['POST', '/memory', { action: '__none__' }, 400, false],
  ['POST', '/maintain', {}, 200, true],
  ['GET', '/mood', undefined, 200, true],
  ['POST', '/mood/reset', {}, 200, true],
  ['POST', '/mood/decay', {}, 200, true],
  ['POST', '/goal', { action: '__none__' }, 404, false],
  ['POST', '/register', {}, 400, false],
  ['GET', '/diary/list', undefined, 200, true],
  ['GET', '/diary/read', undefined, 400, false],
  ['GET', '/diary/private', undefined, 403, false],
  ['GET', '/diary/sessions', undefined, 200, true],
  ['POST', '/diary/bind', {}, 400, false],
  ['POST', '/diary/unbind', {}, 200, true],
  ['POST', '/diary', { date: 'not-a-date' }, 400, false],
  ['GET', '/notes/list', undefined, 200, true],
  ['GET', '/notes/read', undefined, 404, false],
  ['POST', '/notes/save', {}, 400, false],
  ['POST', '/notes/rename', {}, 400, false],
  ['POST', '/notes/delete', {}, 400, false]
]

console.log('① 27 个路由分支的状态码与 ok：')
for (const [method, path, body, status, okFlag] of CASES) {
  const r = await call(method, path, body)
  eq([r.status, r.ok], [status, okFlag], `${method} ${path} → ${status}`)
}

console.log('\n② 中间件链（顺序：Host → 回环 → 令牌 → 限流 → 路由）：')
{
  const chain = [
    ['无令牌', 'GET', '/state', { 'x-soul-token': '' }, '127.0.0.1', 401],
    ['跨源', 'GET', '/state', { origin: 'http://evil.example:9999' }, '127.0.0.1', 403],
    ['非法 Host', 'GET', '/state', { host: 'evil.example' }, '127.0.0.1', 403],
    ['非回环', 'GET', '/state', {}, '10.0.0.1', 403]
  ]
  for (const [label, method, path, headers, remote, expected] of chain) {
    const r = await call(method, path, undefined, headers, remote)
    eq(r.status, expected, `${label} → ${expected}`)
  }
}

// ---------------------------------------------------------------------------
// ③ 结构基线：递归扫描 lib/，不绑定 server.js 的文件位置
// ---------------------------------------------------------------------------
function walk(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix + entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'client') return []
      return walk(join(dir, entry.name), rel + '/')
    }
    return rel.endsWith('.js') && rel !== 'client.js' ? [rel] : []
  })
}
const ROUTE_RE = /route === '([^']+)'\s*&&\s*req\.method === '([A-Z]+)'/g
const found = new Set()
for (const rel of walk(join(root, 'lib'))) {
  const text = readFileSync(join(root, 'lib', rel), 'utf8')
  for (const m of text.matchAll(ROUTE_RE)) found.add(`${m[2]} ${m[1]}`)
}
const EXPECTED_ROUTES = [
  'GET /attestation', 'GET /persona', 'POST /persona', 'POST /open', 'GET /state',
  'POST /config', 'POST /secret', 'GET /memory', 'POST /memory', 'POST /maintain',
  'GET /mood', 'POST /mood/reset', 'POST /mood/decay', 'POST /goal', 'POST /register',
  'POST /pick', 'GET /diary/list', 'GET /diary/read', 'GET /diary/private',
  'GET /diary/sessions', 'POST /diary/bind', 'POST /diary/unbind', 'POST /diary',
  'GET /notes/list', 'GET /notes/read', 'POST /notes/save', 'POST /notes/rename',
  'POST /notes/delete',
  // 2026-11-09 R19 / ⑥：改写 / 删掉「昨天想对今天说的」
  'POST /diary/to-today',
  // 2026-11-07 R10 / P2-15：手动轮换会话令牌（要带当前令牌）
  'POST /session/rotate'
].sort()
console.log('\n③ 路由分支清单（含不跑的 /pick）：')
eq([...found].sort(), EXPECTED_ROUTES, `28 条分支齐全（实际 ${found.size} 条）`)

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
