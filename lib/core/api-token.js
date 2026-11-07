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
import { note, serviceOf } from '../env.js'

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
 *
 * ── 2026-11-07 修 R6（使用方报的线上故障）──
 *
 * 这个白名单在 nginx 反代 + 公网域名/IP 下会把**整页**挡死：浏览器发的 Host 是
 * 公网权威（如 110.41.147.33），和 localhost/127.0.0.1 都对不上，于是
 * `/api/soul/*` 全量 403 —— 连免令牌的 `/session` 也过不去，前端拿不到 token，
 * 「灵魂」八个标签全空。
 *
 * 根因是同一个进程里有**两套 fence**：宿主认 `--trusted-host`，插件只认自己的白名单。
 * 现在优先复用宿主的判定（`ctx.connection.requestRejection`，官方文档原话
 * 「Apply Connection's Host/Origin checks to another Web route」），
 * 插件白名单退化成「宿主没有该服务时的兜底」。
 *
 * @param {object} req Node 的 http.IncomingMessage
 * @returns {boolean}
 */
export function allowedHostList() {
  return String(process.env.DSH_SOUL_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '')
}

function hostNameOf(raw) {
  let host = String(raw ?? '').trim().toLowerCase()
  if (host === '') return ''
  // 去掉端口：`127.0.0.1:57241` / `[::1]:57241` / `localhost`
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    host = end === -1 ? host : host.slice(0, end + 1)
  } else {
    const colon = host.lastIndexOf(':')
    if (colon !== -1 && host.indexOf(':') === colon) host = host.slice(0, colon)
  }
  // FQDN 写法允许尾点：`localhost.`
  if (host.endsWith('.')) host = host.slice(0, -1)
  return host
}

export function isLoopbackHostName(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1'
}

export function isAllowedApiHost(req) {
  const raw = headerValue(req, 'host').trim().toLowerCase()
  // HTTP/1.1 必须带 Host；没有就当不可信
  if (raw === '') return false
  const host = hostNameOf(raw)
  if (isLoopbackHostName(host)) return true
  const extra = allowedHostList()
  return extra.includes(host) || extra.includes(raw)
}

/** 一次性的「API 正被非本机 Host 访问」提示，避免每请求刷日志。 */
let remoteHostNoted = false

function connectionService(ctx) {
  try {
    if (ctx !== null && ctx !== undefined && typeof ctx.get === 'function') {
      const service = ctx.get('connection')
      if (service !== null && service !== undefined) return service
    }
  } catch { /* 取不到就当没有 */ }
  try {
    return ctx?.connection ?? null
  } catch {
    return null
  }
}

/**
 * 这一请求的 Host 是否可信 —— **以宿主为准**，插件白名单兜底。
 *
 * @returns {Promise<{ ok: boolean, source: string, host: string, allowed: string[], status: number }>}
 *   source: 'loopback' | 'host-trusted' | 'whitelist' | 'host-rejected' | 'unknown-host'
 */
export async function checkHostTrust(req, ctx) {
  const raw = headerValue(req, 'host').trim()
  const host = hostNameOf(raw)
  const allowed = allowedHostList()
  const base = { host: raw, allowed, status: 403 }

  if (isLoopbackHostName(host)) return { ...base, ok: true, source: 'loopback' }

  // ① 宿主自己的信任判定（和 --trusted-host 保持一致）
  const connection = connectionService(ctx)
  if (connection !== null && typeof connection.requestRejection === 'function') {
    try {
      const verdict = await connection.requestRejection(req)
      if (verdict === null || verdict === undefined || verdict === false) {
        return { ...base, ok: true, source: 'host-trusted' }
      }
      const status = Number(verdict?.status ?? verdict?.statusCode ?? 0)
      // 401 = 宿主侧未登录，**不代表这个 Host 不受信**（使用方实测：宿主对公网 Host
      // 打 /api/ 返回的就是 401，说明 fence 过了、只缺登录）。这种情况放行到插件
      // 自己的 x-soul-token 校验；只有 403 才是真不受信。
      if (status === 401) {
        return { ...base, ok: true, source: 'host-unauthenticated' }
      }
      return { ...base, ok: false, source: 'host-rejected', status: status === 0 ? 403 : status }
    } catch (error) {
      // 宿主判定不可用（老版本 / 方法签名不同 / 抛错）：退回插件白名单，别因此整站 403
      note('api', `宿主的 Host 判定不可用，改用插件白名单：${error instanceof Error ? error.message : error}`)
    }
  }

  // ② 插件白名单（显式配置 = 用户已经明确同意这个 Host）
  if (allowed.includes(host) || allowed.includes(raw.toLowerCase())) {
    return { ...base, ok: true, source: 'whitelist' }
  }
  return { ...base, ok: false, source: 'unknown-host', status: 403 }
}

/**
 * 非本机 Host 被放行时提醒一次：这时候 API 已经**能从外部访问**了，
 * 上游有没有鉴权（nginx auth_basic / IP 白名单 / 固定令牌）只有用户知道。
 */
export function noteRemoteHostOnce(source, host) {
  if (remoteHostNoted) return
  remoteHostNoted = true
  note('api', `⚠️ 接口正被非本机 Host 访问（${host}，来源=${source}）——请确认上游已有鉴权，或改用 DSH_SOUL_API_TOKEN 固定令牌`)
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
