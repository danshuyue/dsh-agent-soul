/**
 * R05 · P2-3：密钥那条路上的同步冻结
 *
 * 现状：`secrets.js` 用 `execFileSync` 调 PowerShell 做 DPAPI 加解密。
 * 同步调用本身在插件形态下可以接受（一次进程只做一次，之后有 CACHE），
 * 但**超时**原来是 20 秒：那 20 秒里宿主事件循环完全停住，而 `POST /secret`
 * 可以被反复触发 —— 等于每次都能冻 20 秒。
 *
 * 修法三条：
 *   ① 超时压到 6 秒（正常 0.3～0.8 秒）；
 *   ② 超时/起不来之后熔断 30 秒，这期间直接快速失败，不再起进程；
 *   ③ DPAPI 自己解不开（数据问题）不熔断，否则用户重装密钥会被干等。
 *
 * 这份测试在**所有平台**都能跑：它验的是常量和熔断判据，
 * 不依赖真的 PowerShell。（非 Windows 上根本不会走到这条路。）
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r05-secrets-'))
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

const { ensureDirs } = await imp('paths.js')
ensureDirs()
const secrets = await imp('core/secrets.js')

// ---------------------------------------------------------------------------
console.log('① 超时上限：不能再是 20 秒')
// ---------------------------------------------------------------------------
{
  ok(Number.isFinite(secrets.SHELL_TIMEOUT_MS), 'SHELL_TIMEOUT_MS 是有限数')
  ok(secrets.SHELL_TIMEOUT_MS <= 10_000, `超时 ${secrets.SHELL_TIMEOUT_MS}ms <= 10s（原来的 20s 会冻住宿主）`)
  ok(secrets.SHELL_TIMEOUT_MS >= 3_000, `超时 ${secrets.SHELL_TIMEOUT_MS}ms >= 3s（慢机器上 DPAPI 也要够用）`)
  ok(secrets.SHELL_BREAKER_MS >= 10_000, `熔断期 ${secrets.SHELL_BREAKER_MS}ms >= 10s（太短等于没有）`)
  ok(secrets.SHELL_BREAKER_MS <= 300_000, `熔断期 ${secrets.SHELL_BREAKER_MS}ms <= 5min（不能一坏就半小时不可用）`)
}

// ---------------------------------------------------------------------------
console.log('② 熔断判据：环境问题要熔断，数据问题不要')
// ---------------------------------------------------------------------------
{
  const timeoutErr = Object.assign(new Error('spawnSync powershell ETIMEDOUT'), { code: 'ETIMEDOUT' })
  const killed = new Error('Command failed: timeout'); killed.signal = 'SIGTERM'
  const noPath = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })
  const denied = Object.assign(new Error('spawn EACCES'), { code: 'EACCES' })
  // DPAPI 解不开：PowerShell 正常退出、只是 exit code 非 0
  const badData = Object.assign(new Error('Unprotect failed'), { code: 1, status: 1 })

  eq(secrets.shouldTripBreaker(timeoutErr), true, '超时 → 熔断')
  eq(secrets.shouldTripBreaker(killed), true, '被信号杀掉 → 熔断')
  eq(secrets.shouldTripBreaker(noPath), true, '起不来（ENOENT）→ 熔断')
  eq(secrets.shouldTripBreaker(denied), true, '没权限（EACCES）→ 熔断')
  eq(secrets.shouldTripBreaker(badData), false, 'DPAPI 自己解不开 → 不熔断（否则重装密钥要干等 30 秒）')
  eq(secrets.shouldTripBreaker(null), false, 'null → 不熔断')
}

// ---------------------------------------------------------------------------
console.log('③ 非 Windows 不受影响（别人机器上不会因为这条改动出问题）')
// ---------------------------------------------------------------------------
if (process.platform !== 'win32') {
  const saved = secrets.saveSecret('r05-plain', 'sk-plain-value')
  eq(saved.ok, true, '非 Windows 保存成功')
  eq(saved.encrypted, false, '明确标记没有系统级加密')
  eq(secrets.loadSecret('r05-plain'), 'sk-plain-value', '读回来一致')
  // 把环境变量指到一个假 PowerShell 也不该有影响：这条路上根本不调它
  process.env.DSH_SOUL_POWERSHELL = join(sandbox, 'not-a-real-powershell.exe')
  eq(secrets.loadSecret('r05-plain'), 'sk-plain-value', '设了 DSH_SOUL_POWERSHELL 也不影响非 Windows')
  delete process.env.DSH_SOUL_POWERSHELL
} else {
  console.log('  （Windows：走 DPAPI，实际调用由 r02-secrets-shell.test.js 覆盖）')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
