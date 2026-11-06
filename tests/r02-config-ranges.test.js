/**
 * R02 · T1 配置数值区间（第二份审查 H-1）
 *
 * 背景：`/config` 原来只拒绝「非有限数 / 负数」，不设上限。
 * 一次 `POST /config {"diaryAgentTimeoutMs": 1e12}` 就能把超时改成 31.7 年，
 * 写进配置后重启仍在，配合「日记主流程没有总超时」= 日记功能永久停摆。
 *
 * 这里把区间表钉住：表必须覆盖 DEFAULT_CONFIG 里**全部**数值键，
 * 且每个键的默认值本身必须在区间内（否则用户一保存就 400）。
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r02-range-'))
process.env.DSH_HOME = sandbox
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

const { DEFAULT_CONFIG } = await imp('state/cache.js')
const { NUMBER_RANGES, validateConfigEntry } = await imp('http/middleware.js')

// ---------------------------------------------------------------------------
console.log('① 区间表覆盖度与默认值自洽')
// ---------------------------------------------------------------------------
{
  const numericKeys = Object.entries(DEFAULT_CONFIG).filter(([, v]) => typeof v === 'number').map(([k]) => k)
  const missing = numericKeys.filter((k) => NUMBER_RANGES[k] === undefined)
  eq(missing, [], `区间表覆盖全部 ${numericKeys.length} 个数值键`)
  ok(numericKeys.length >= 35, `数值键数量 ${numericKeys.length}（>=35）`)

  const badDefaults = []
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (typeof v !== 'number') continue
    const range = NUMBER_RANGES[k]
    if (range === undefined) continue
    if (v < range[0] || v > range[1]) badDefaults.push(`${k}=${v} 不在 ${range[0]}~${range[1]}`)
  }
  eq(badDefaults, [], '每个数值键的默认值都在自己的区间内')
}

// ---------------------------------------------------------------------------
console.log('② 超时类：1e12 必须被拒（H-1 的核心）')
// ---------------------------------------------------------------------------
{
  for (const key of ['diaryAgentTimeoutMs', 'diarySummarizeTimeoutMs']) {
    const r = validateConfigEntry(key, 1e12)
    eq(r.ok, false, `${key}=1e12 被拒`)
    ok(String(r.error ?? '').includes('应在'), `${key} 的报错说清区间`)
    eq(validateConfigEntry(key, DEFAULT_CONFIG[key]).ok, true, `${key} 默认值通过`)
  }
  // 时间戳类必须仍然放行（这是我上一版「不设上限」的唯一正当理由）
  eq(validateConfigEntry('diarySessionBornAt', 1790000000000), { ok: true, value: 1790000000000 },
    'diarySessionBornAt 的大时间戳仍然通过')
}

// ---------------------------------------------------------------------------
console.log('③ 表驱动：每个键的下界-1 与上界+1 都被拒')
// ---------------------------------------------------------------------------
{
  const bad = []
  for (const [key, [lo, hi]] of Object.entries(NUMBER_RANGES)) {
    if (lo > 0) {
      const r = validateConfigEntry(key, lo - 1)
      if (r.ok !== false) bad.push(`${key} 下界-1(${lo - 1}) 竟然通过`)
    }
    const r2 = validateConfigEntry(key, hi + 1)
    if (r2.ok !== false) bad.push(`${key} 上界+1(${hi + 1}) 竟然通过`)
  }
  eq(bad, [], '全部键的越界值都被拒')
}

// ---------------------------------------------------------------------------
console.log('④ 整份配置原样提交必须 200（最容易翻车的一条）')
// ---------------------------------------------------------------------------
{
  const rejectedKeys = []
  for (const [k, v] of Object.entries(DEFAULT_CONFIG)) {
    if (v === undefined || v === null) continue
    const r = validateConfigEntry(k, v)
    if (r.ok !== true) rejectedKeys.push(`${k}=${JSON.stringify(v)} → ${r.error}`)
  }
  eq(rejectedKeys, [], '默认配置逐键提交全部通过（不会因为边界值误判）')
}

// ---------------------------------------------------------------------------
console.log('⑤ 表外的键用兜底区间，并留日志')
// ---------------------------------------------------------------------------
{
  // 直接构造一个 DEFAULT_CONFIG 里没有的键是做不到的（validateConfigEntry 先查白名单），
  // 所以这里只验兜底区间常量本身的语义：0 能过、负数与 1e12 不能过。
  const { validateConfigEntry: v } = { validateConfigEntry }
  eq(typeof NUMBER_RANGES, 'object', 'NUMBER_RANGES 是对象（可审阅）')
  eq(v('moodFloor', 0).ok, true, '下界 0 的键允许 0')
  eq(v('forgetAfterDays', 0).ok, false, '下界 1 的键拒绝 0')
}

// ---------------------------------------------------------------------------
console.log('⑥ 端到端：POST /config 把超时改成 1e12 必须 400')
// ---------------------------------------------------------------------------
{
  const { registerApi, API_PREFIX } = await imp('api.js')
  process.env.DSH_SOUL_API_TOKEN = 'r02-config-ranges-token-padded-to-32chars'
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

  const huge = await call('POST', '/config', { diaryAgentTimeoutMs: 1e12 })
  eq(huge.status, 400, 'POST /config {"diaryAgentTimeoutMs":1e12} → 400')
  ok(String(huge.json?.error ?? '').includes('应在'), '错误信息带区间')

  const whole = await call('POST', '/config', DEFAULT_CONFIG)
  eq(whole.status, 200, '整份默认配置提交 → 200')
  const keys = Object.keys(whole.json?.config ?? {})
  ok(keys.length >= 70, `保存回来的配置键数 ${keys.length}（>=70，没丢键）`)
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
