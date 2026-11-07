/**
 * 契约回归 · 密钥存储（2026-11-06 P10 从 _review-tmp 探针固化）
 *
 * 闭合旧报告 11.6 的「DPAPI 本机实测」项。Windows 上必须真的用 DPAPI
 * 加密落盘、明文不出现、子进程（全新内存）仍可解；非 Windows 平台走
 * base64 + 0600 降级，只断言读写/跨进程/环境变量覆盖，不假装加密。
 *
 * 全程临时 DSH_HOME，用完即删，不碰真实 ~/.dsh。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'soul-probe-secrets-'))
process.env.DSH_HOME = HOME
const PLAIN = 'sk-PROBE-PLAINTEXT-DO-NOT-LEAK-42'
const secretsUrl = pathToFileURL(join(root, 'lib', 'core', 'secrets.js')).href

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

const isWindows = process.platform === 'win32'

try {
  const secrets = await import(secretsUrl)
  const { saveSecret, loadSecret, secretPath, secretInfo, deleteSecret, __resetSecretsForTest } = secrets

  console.log(`\n① 保存（平台：${process.platform}）`)
  const saved = saveSecret('probe_secret', PLAIN)
  // 2026-11-07：断言里带上失败原因 —— 只在 CI 上失败过一次，而当时只看到「期望 true」
  // 完全不知道底层为什么没写成。诊断信息必须留在能看见的地方。
  eq(saved.ok, true, `saveSecret 成功${saved.ok === true ? '' : `（失败原因：${saved.error ?? '未给出'}）`}`)
  eq(saved.encrypted, isWindows, `encrypted 标记与平台一致（Windows=${isWindows}）`)
  if (saved.ok !== true) {
    console.error(`    诊断：DSH_HOME=${process.env.DSH_HOME} secretPath=${secretPath('probe_secret')}`)
  }
  const raw = readFileSync(secretPath('probe_secret'), 'utf8')
  ok(!raw.includes(PLAIN), '文件里不含明文')
  if (isWindows) ok(raw.startsWith('dpapi:'), 'Windows：密文带 dpapi: 前缀')
  else ok(raw.trim().length > 0, '非 Windows：降级为 base64 明文编码，仍有内容')

  console.log('\n② 同进程 / 清缓存后读取')
  eq(loadSecret('probe_secret'), PLAIN, '同进程命中缓存能解出原文')
  __resetSecretsForTest()
  eq(loadSecret('probe_secret'), PLAIN, '清缓存后重新读盘仍能解出原文')

  console.log('\n③ 跨进程解密（全新内存，证明不是内存假象）')
  const childCode = `
import { loadSecret } from ${JSON.stringify(secretsUrl)};
const v = loadSecret('probe_secret');
console.log(v === ${JSON.stringify(PLAIN)} ? 'CROSS_PROCESS_OK' : 'CROSS_PROCESS_FAIL:' + String(v));
`
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', childCode], {
    env: { ...process.env, DSH_HOME: HOME }, encoding: 'utf8'
  })
  eq(String(child.stdout ?? '').trim(), 'CROSS_PROCESS_OK', '子进程解密出同一份原文')

  console.log('\n④ 环境变量覆盖优先级')
  const envCode = `
import { loadSecret } from ${JSON.stringify(secretsUrl)};
console.log(loadSecret('probe_secret'));
`
  const envChild = spawnSync(process.execPath, ['--input-type=module', '-e', envCode], {
    env: { ...process.env, DSH_HOME: HOME, SOUL_SECRET_PROBE_SECRET: 'from-env' }, encoding: 'utf8'
  })
  eq(String(envChild.stdout ?? '').trim(), 'from-env', 'SOUL_SECRET_* 环境变量优先于磁盘')

  console.log('\n⑤ 状态查询与删除')
  const info = secretInfo('probe_secret')
  eq(info.exists, true, 'secretInfo 报告存在')
  ok(!Object.values(info).includes(PLAIN), 'secretInfo 不回传明文')
  eq(deleteSecret('probe_secret'), true, 'deleteSecret 成功')
  __resetSecretsForTest()
  eq(loadSecret('probe_secret'), null, '删除后读不到')
} catch (error) {
  failed += 1
  console.error(`  ✗ 探针执行抛异常：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  delete process.env.SOUL_SECRET_PROBE_SECRET
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n收尾：')
  ok(!existsSync(HOME), '临时 DSH_HOME 已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
