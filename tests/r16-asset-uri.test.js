/**
 * R16 回归：坏 URI 不能把宿主带崩（2026-11-06）。
 *
 * registerAssets 的 handler 是同步的，`decodeURIComponent('%')` 会抛 URIError。
 * 修之前这个异常直接穿出去 —— 对宿主来说就是一次未捕获异常。
 * 这里用假 ctx 拿到真实 handler，喂一个坏转义，断言它返回 404 而不是抛。
 */
import { registerAssets, ASSET_PREFIX } from '../lib/api.js'

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}`) }
}

let handler = null
const fakeCtx = {
  get: () => undefined,
  webServer: {
    register: (spec) => { handler = spec.handler; return () => {} }
  }
}

console.log('注册表情资源：')
{
  const dispose = registerAssets(fakeCtx)
  ok(typeof handler === 'function', '拿到了真实 handler')
  ok(typeof dispose === 'function' || dispose === undefined, 'register 返回了可用的 dispose')
}

function callHandler(path) {
  let status = 0
  let body = ''
  const res = {
    writeHead: (code) => { status = code },
    end: (chunk) => { body = String(chunk ?? '') }
  }
  // 2026-11-06 审计 P1-1：静态路由现在也要过 Host 白名单 + 回环，假请求得带上 Host。
  handler({ url: path, method: 'GET', headers: { host: '127.0.0.1:57241' }, socket: { remoteAddress: '127.0.0.1' } }, res)
  return { status, body }
}

console.log('坏转义：')
{
  let threw = null
  let result = null
  try {
    result = callHandler(`${ASSET_PREFIX}/%`)
  } catch (error) {
    threw = error
  }
  ok(threw === null, `没有抛异常（${threw ? threw.constructor.name : 'ok'}）`)
  ok(result?.status === 404, `返回 404（实际 ${result?.status}）`)
}

console.log('正常转义仍然可用：')
{
  let threw = null
  let result = null
  try {
    result = callHandler(`${ASSET_PREFIX}/nope.png`)
  } catch (error) {
    threw = error
  }
  ok(threw === null, '没有抛异常')
  ok(result?.status === 404, `不存在的图仍是 404（实际 ${result?.status}）`)
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
