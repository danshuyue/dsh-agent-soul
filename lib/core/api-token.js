/**
 * api-token.js —— 设置页接口的会话令牌、来源校验与限流（S2 / P0-1 余下）。
 *
 * 为什么不是「一个写死在配置里的 token」：
 *   前端 bundle 是宿主从本地文件加载的（__ModuleLoader__），插件侧没有可信的
 *   运行时注入通道；任何写进仓库 / 配置文件的静态值，本机其它进程都能读到，
 *   等于把钥匙挂在门上。而 DSH_SOUL_API_TOKEN 这类启动环境值是给「宿主能注入
 *   globalThis.__SOUL_API_TOKEN__」的高级场景留的逃生口。
 *
 * 默认模式（ephemeral）：
 *   进程启动时生成 32 字节随机 token，只存在内存里。前端先 GET /session 拿它，
 *   之后每个请求带 x-soul-token。/session 的响应**不带任何 CORS 头**：跨源页面
 *   即使发得出这个 GET，浏览器也不让它的 JS 读到响应体，因此拿不到 token。
 *   这挡的是恶意网页 / sandbox iframe；本机任意进程仍可自己 GET 一次拿到，
 *   那属于 OS 权限层，纯插件侧无解（见报告 11.6），不假装已经解决。
 *
 * 校验用 sha256 摘要 + timingSafeEqual 定长比较，避免长度与时序侧信道。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { note } from '../env.js'

export const TOKEN_HEADER = 'x-soul-token'
export const SESSION_ROUTE = '/session'

/** 启动环境显式指定时进入 fixed 模式：/session 不再发放，前端需自带 token。 */
const ENV_TOKEN = 'DSH_SOUL_API_TOKEN'

let ephemeral = ''
const buckets = new Map()

/** 固定令牌的最短长度。32 字符 ≈ 128 bit 以上（十六进制）/ 更高（随机串），够扛离线猜。 */
export const MIN_FIXED_TOKEN_LENGTH = 32

/**
 * 2026-11-06 审计 P2-15：fixed 模式原来对长度**零校验** ——
 * `DSH_SOUL_API_TOKEN=123` 也能当令牌用，而它是这个接口唯一的口令。
 * 太短直接判为无效（等价于回到 ephemeral 模式），并在首次取用时留一行日志。
 */
let shortTokenWarned = false
function fixedToken() {
  const raw = process.env[ENV_TOKEN]
  if (typeof raw !== 'string') return ''
  const value = raw.trim()
  if (value === '') return ''
  if (value.length < MIN_FIXED_TOKEN_LENGTH) {
    if (!shortTokenWarned) {
      shortTokenWarned = true
      // 不打印令牌本身，只说长度
      note('api', `⚠️ ${ENV_TOKEN} 只有 ${value.length} 个字符（至少需要 ${MIN_FIXED_TOKEN_LENGTH}），已忽略并改用进程内临时令牌`)
    }
    return ''
  }
  return value
}

/** 当前进程认可的令牌。ephemeral 只生成一次，重启自然失效。 */
export function currentApiToken() {
  const fixed = fixedToken()
  if (fixed !== '') return fixed
  if (ephemeral === '') ephemeral = randomBytes(32).toString('hex')
  return ephemeral
}

export function apiTokenMode() {
  return fixedToken() === '' ? 'ephemeral' : 'fixed'
}

function digest(value) {
  return createHash('sha256').update(String(value), 'utf8').digest()
}

function headerValue(req, name) {
  const raw = req?.headers?.[name]
  if (Array.isArray(raw)) return String(raw[0] ?? '')
  return typeof raw === 'string' ? raw : ''
}

/**
 * Host 白名单（2026-11-06 修 R3）。
 *
 * 为什么要有它：`/session` 是唯一免令牌的端点，靠「跨源页面读不到响应体」保护。
 * 但 DNS rebinding 把这一层绕开了 —— 攻击者域名解析到 127.0.0.1 后，浏览器认为
 * 自己仍在同源，读到响应体，token 就到手了。实测本机宿主监听在 127.0.0.1:PORT
 * （netstat 确认），所以这条不是纸面风险。
 *
 * 判据是 Host 头：rebinding 场景下浏览器发的 Host 一定是攻击者域名。
 * 反向代理部署用 DSH_SOUL_ALLOWED_HOSTS 显式放行（逗号分隔），别把正常部署挡死。
 *
 * @param {object} req Node 的 http.IncomingMessage
 * @returns {boolean}
 */
export function isAllowedApiHost(req) {
  const raw = headerValue(req, 'host').trim().toLowerCase()
  // HTTP/1.1 必须带 Host；没有就当不可信
  if (raw === '') return false
  // 去掉端口：`127.0.0.1:57241` / `[::1]:57241` / `localhost`
  let host = raw
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    host = end === -1 ? host : host.slice(0, end + 1)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && host.indexOf(':') === colon) host = host.slice(0, colon)
  }
  // FQDN 写法允许尾点：`localhost.`
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') return true
  const extra = String(process.env.DSH_SOUL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
  return extra.includes(host) || extra.includes(raw)
}

/** 从 x-soul-token 或 Authorization: Bearer 取候选，定长比较。 */
export function verifyApiToken(req) {  const expected = currentApiToken()
  let candidate = headerValue(req, TOKEN_HEADER)
  if (candidate === '') {
    const auth = headerValue(req, 'authorization')
    const matched = /^Bearer\s+(.+)$/i.exec(auth)
    if (matched !== null) candidate = matched[1].trim()
  }
  if (candidate === '' || expected === '') return false
  return timingSafeEqual(digest(candidate), digest(expected))
}

/**
 * /session 是否发令牌。
 * - fixed 模式：不发（宿主自行把 token 交给页面）。
 * - cross-site 来源：不发。同源页面永远不会带这个头；sandbox iframe、
 *   恶意站点、file:// 跨源页面会带，拒掉它们不影响正常同源设置页。
 */
export function issueSessionToken(req) {
  if (apiTokenMode() === 'fixed') {
    return {
      ok: false,
      status: 403,
      error: '服务端启用了固定令牌（DSH_SOUL_API_TOKEN），请由宿主注入 globalThis.__SOUL_API_TOKEN__'
    }
  }
  const site = headerValue(req, 'sec-fetch-site').trim().toLowerCase()
  // 2026-11-07 第二份审查 P1-S3：原来写的是 `'samesite'`（无连字符），
  // 而 Fetch Metadata 的规范值是 `same-site` —— 于是「同站」这道闸从来没生效过，
  // 测试也只覆盖了 cross-site，拼错的值没人锚定。
  // 现在：cross-site 与 same-site（同站 ≠ 同源，比如 a.example.com 跨到 b.example.com）
  // 一律不发；只有 same-origin / none（地址栏直接打开）才发。
  if (site === 'cross-site' || site === 'same-site') {
    return { ok: false, status: 403, error: '跨站来源不发放会话令牌' }
  }
  return { ok: true, token: currentApiToken() }
}

/**
 * 简易令牌桶。key 一般是「类别 + remoteAddress」，桶数设上限防止内存无限增长。
 * @returns {boolean} true = 放行
 */
function allow(key, capacity, refillPerSec) {
  const now = Date.now()
  let bucket = buckets.get(key)
  if (bucket === undefined) {
    if (buckets.size > 1024) {
      for (const [oldKey, old] of buckets) {
        if (now - old.at > 60_000) buckets.delete(oldKey)
        if (buckets.size <= 512) break
      }
    }
    bucket = { tokens: capacity, at: now }
    buckets.set(key, bucket)
  }
  const elapsed = Math.max(0, now - bucket.at) / 1000
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsed * refillPerSec)
  bucket.at = now
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function peerOf(req) {
  return String(req?.socket?.remoteAddress ?? 'unknown')
}

/** 全接口限流：正常使用（首屏 + 各标签页轮询）远达不到这个量。 */
export function checkApiRateLimit(req) {
  return allow(`api:${peerOf(req)}`, 600, 10)
}

/** /session 单独收紧，避免被拿去当暴力入口。 */
export function checkSessionRateLimit(req) {
  return allow(`session:${peerOf(req)}`, 20, 0.3)
}

/** 仅供测试重置进程内状态。 */
export function __resetApiTokenForTest() {
  ephemeral = ''
  buckets.clear()
}
