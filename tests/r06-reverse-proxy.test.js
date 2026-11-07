/**
 * R6 · 反代部署下 `/api/soul/*` 全量 403（使用方报的线上故障）
 *
 * 现象：nginx 反代 + 公网 IP/域名，浏览器发的 Host 是公网权威，
 * 而插件只认 localhost / 127.0.0.1 / [::1] 和自己的白名单 → 连免令牌的 /session
 * 也被挡住 → 前端拿不到 token → 「灵魂」八个标签全空。
 *
 * 根因是同一个进程里两套 fence：宿主认 `--trusted-host`，插件不认。
 *
 * 这份测试钉住四件事：
 *   ① Host 判定**以宿主为准**：宿主说行就行（401 = 未登录，也放行到我们自己的令牌校验）
 *   ② 宿主没有这个服务时，插件白名单兜底（老部署不受影响）
 *   ③ 403 响应体里带实际 Host 与允许列表（别再让人猜）
 *   ④ Origin 与 Host 的端口比较：回环之间允许端口不同（反代常见形态）
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r6-host-'))
process.env.DSH_HOME = sandbox
process.env.DSH_SOUL_API_TOKEN = 'r6-host-trust-token-padded-to-32chars'
delete process.env.DSH_SOUL_ALLOWED_HOSTS
mkdirSync(join(sandbox, 'agents'), { recursive: true })

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

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const token = await imp('core/api-token.js')
const { registerApi, API_PREFIX } = await imp('api.js')

function fakeReq(method, url, headers) {
  const listeners = new Map()
  const req = {
    method, url,
    headers: { host: '127.0.0.1:53397', 'x-soul-token': process.env.DSH_SOUL_API_TOKEN, ...headers },
    socket: { remoteAddress: '127.0.0.1' },
    on(e, cb) { if (!listeners.has(e)) listeners.set(e, []); listeners.get(e).push(cb); return req },
    destroy() {}
  }
  process.nextTick(() => (listeners.get('end') ?? []).forEach((cb) => cb()))
  return req
}
function fakeRes() {
  const out = { status: 0, body: '' }
  return { writeHead(c) { out.status = c }, end(c) { if (c != null) out.body += String(c) }, result: out }
}
async function callWith(ctx, path, headers) {
  let handler = null
  registerApi({ ...ctx, webServer: { register(spec) { handler = spec.handler; return () => {} } } })
  const res = fakeRes()
  await handler(fakeReq('GET', `${API_PREFIX}${path}`, headers), res)
  let json = null
  try { json = JSON.parse(res.result.body) } catch { /* 非 JSON */ }
  return { status: res.result.status, json }
}

// ---------------------------------------------------------------------------
console.log('① 宿主说信 → 放行（即使 Host 是公网 IP）')
// ---------------------------------------------------------------------------
{
  const ctx = {
    get: (key) => (key === 'connection'
      ? { requestRejection: () => null } // null = 宿主认可
      : undefined)
  }
  const r = await callWith(ctx, '/state', { host: '110.41.147.33' })
  eq(r.status, 200, '公网 Host + 宿主认可 → 200（修复前是 403）')
}

// ---------------------------------------------------------------------------
console.log('② 宿主返回 401（未登录）→ 交给插件自己的令牌校验，不是 Host 不受信')
// ---------------------------------------------------------------------------
{
  const ctx = {
    get: (key) => (key === 'connection'
      ? { requestRejection: () => ({ status: 401 }) }
      : undefined)
  }
  const r = await callWith(ctx, '/state', { host: '110.41.147.33' })
  eq(r.status, 200, '401 不被当成 Host 不可信（否则又整页 403）')
}

// ---------------------------------------------------------------------------
console.log('③ 宿主明确 403 → 拒（这才是真不受信）')
// ---------------------------------------------------------------------------
{
  const ctx = {
    get: (key) => (key === 'connection'
      ? { requestRejection: () => ({ status: 403, message: 'host not trusted' }) }
      : undefined)
  }
  const r = await callWith(ctx, '/state', { host: 'evil.example' })
  eq(r.status, 403, '宿主拒绝 → 403')
  ok(String(r.json?.error ?? '').includes('Host'), '文案说清是 Host 问题')
}

// ---------------------------------------------------------------------------
console.log('④ 宿主没有 connection 服务 → 插件白名单兜底')
// ---------------------------------------------------------------------------
{
  const ctx = { get: () => undefined }
  const denied = await callWith(ctx, '/state', { host: '110.41.147.33' })
  eq(denied.status, 403, '无宿主服务且未配置白名单 → 403（保持原行为）')

  process.env.DSH_SOUL_ALLOWED_HOSTS = '110.41.147.33, example.com'
  const allowed = await callWith(ctx, '/state', { host: '110.41.147.33' })
  eq(allowed.status, 200, '配了 DSH_SOUL_ALLOWED_HOSTS → 200')
  eq(token.allowedHostList(), ['110.41.147.33', 'example.com'], '白名单解析正确')
  delete process.env.DSH_SOUL_ALLOWED_HOSTS
}

// ---------------------------------------------------------------------------
console.log('⑤ 403 响应体要带实际 Host 与允许列表（别再让人猜）')
// ---------------------------------------------------------------------------
{
  const ctx = { get: () => undefined }
  const r = await callWith(ctx, '/state', { host: '110.41.147.33' })
  eq(r.status, 403, '拒了')
  eq(r.json?.host, '110.41.147.33', '响应里有实际收到的 Host')
  ok(Array.isArray(r.json?.allowedHosts), '响应里有允许列表（数组）')
  ok(String(r.json?.hint ?? '').includes('DSH_SOUL_ALLOWED_HOSTS'), '给了可操作的提示')
  ok(String(r.json?.hint ?? '').includes('.env'), '点名 .env 这个坑（写进去 dsh 起不来）')
}

// ---------------------------------------------------------------------------
console.log('⑥ Host 解析：端口、IPv6、尾点')
// ---------------------------------------------------------------------------
{
  ok(token.isLoopbackHostName('localhost') === true, 'localhost 是回环')
  ok(token.isLoopbackHostName('[::1]') === true, '[::1] 是回环')
  ok(token.isLoopbackHostName('127.0.0.1') === true, '127.0.0.1 是回环')
  ok(token.isLoopbackHostName('evil.example') === false, '外部域名不是回环')
  // isAllowedApiHost 用 Host 头（含端口）
  const mk = (host) => ({ headers: { host } })
  eq(token.isAllowedApiHost(mk('127.0.0.1:57241')), true, '带端口的回环放行')
  eq(token.isAllowedApiHost(mk('[::1]:57241')), true, 'IPv6 带端口放行')
  eq(token.isAllowedApiHost(mk('localhost.')), true, 'FQDN 尾点放行')
  eq(token.isAllowedApiHost(mk('')), false, '没有 Host 拒绝')
}

// ---------------------------------------------------------------------------
console.log('⑦ 宿主判定抛错 → 不许把整站 403 掉，退回白名单')
// ---------------------------------------------------------------------------
{
  const ctx = {
    get: (key) => (key === 'connection'
      ? { requestRejection: () => { throw new Error('宿主内部错误') } }
      : undefined)
  }
  process.env.DSH_SOUL_ALLOWED_HOSTS = '110.41.147.33'
  const r = await callWith(ctx, '/state', { host: '110.41.147.33' })
  delete process.env.DSH_SOUL_ALLOWED_HOSTS
  eq(r.status, 200, '宿主判定抛错时用白名单兜底（不是 500 也不是整站 403）')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
