/**
 * 接口权限测试：node tests/api-auth.test.js，退出码 0 = 全过。
 *
 * 2026-11-04 修 ⑤：原来只挡 Origin，不带 Origin 的请求一律放行 ——
 * 本机任何进程都能 POST /persona 改注入的人格、POST /notes/save 覆盖笔记。
 * 而最敏感的私密日记反倒做了回环校验，权限模型是反的。
 *
 * 这里只测判据本身（纯函数）。整体行为靠 POST /api/soul/* 的手工验证。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-api-auth-test-'))

const { isLoopbackRequest, shouldAllowApiRequest } = await import('../lib/api.js')

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

const reqFrom = (remoteAddress) => ({ socket: { remoteAddress } })

console.log('回环地址判定：')
{
  eq(isLoopbackRequest(reqFrom('127.0.0.1')), true, '127.0.0.1 算回环')
  eq(isLoopbackRequest(reqFrom('::1')), true, '::1 算回环')
  eq(isLoopbackRequest(reqFrom('::ffff:127.0.0.1')), true, 'IPv4-mapped 的 ::ffff:127.0.0.1 也算')
  eq(isLoopbackRequest(reqFrom('192.168.1.5')), false, '局域网地址不算')
  eq(isLoopbackRequest(reqFrom('10.0.0.7')), false, '内网地址不算')
  eq(isLoopbackRequest(reqFrom(undefined)), false, '拿不到地址时按「不是回环」处理（宁严不松）')
  eq(isLoopbackRequest({}), false, '连 socket 都没有也不放行')
}

console.log('\n放行判据（默认配置）：')
{
  eq(shouldAllowApiRequest(reqFrom('127.0.0.1'), {}), true, '本机请求放行（设置页靠这条）')
  eq(shouldAllowApiRequest(reqFrom('192.168.1.5'), {}), false, '非回环被拒')
  eq(shouldAllowApiRequest(reqFrom('192.168.1.5'), undefined), false, 'config 拿不到时也按默认严处理')
  eq(shouldAllowApiRequest(reqFrom('192.168.1.5'), { apiLoopbackOnly: true }), false, '显式开启时被拒')
}

console.log('\n逃生口（apiLoopbackOnly: false）：')
{
  // 2026-11-06 修 R4：逃生口改由启动环境控制。
  // 配置文件可被手改 / 备份还原 / 别的进程写入，残留一个 false 就等于把边界永久关掉，
  // 所以「配置里写 false」单独不再生效，必须同时有 DSH_SOUL_ALLOW_REMOTE_API=1。
  eq(shouldAllowApiRequest(reqFrom('192.168.1.5'), { apiLoopbackOnly: false }), false, '只有配置 false 不放行')
  eq(shouldAllowApiRequest(reqFrom(undefined), { apiLoopbackOnly: false }), false, '拿不到地址也不因配置放行')
  process.env.DSH_SOUL_ALLOW_REMOTE_API = '1'
  eq(shouldAllowApiRequest(reqFrom('192.168.1.5'), { apiLoopbackOnly: false }), true, '环境变量 + 配置 false 才放行')
  delete process.env.DSH_SOUL_ALLOW_REMOTE_API
}

console.log('\n收尾：')
{
  rmSync(process.env.DSH_HOME, { recursive: true, force: true })
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
