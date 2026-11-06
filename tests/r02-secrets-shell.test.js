/**
 * R02 · T4 PowerShell 回退链（第二份审查 L-3）
 *
 * 修复前的 bug（我们自己写的）：
 *
 *   for (const candidate of candidates) {
 *     if (!candidate.includes('\\') && !candidate.includes('/')) { return candidate }
 *     //  ↑ 'pwsh' 走到这里直接返回：既没验它存在，第三级 'powershell' 也永远不可达
 *
 * 现契约：
 *   ① DSH_SOUL_POWERSHELL 显式指定 → 设了但不存在就**报错**，不静默回退
 *   ② %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
 *   ③ PATH 里的 pwsh   ④ PATH 里的 powershell
 *   全部找不到 → 抛一条人能读懂的错（列出试过的路径），且**不缓存空值**
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r02-shell-'))
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

const WIN = process.platform === 'win32'
const ENV = 'DSH_SOUL_POWERSHELL'

// ---------------------------------------------------------------------------
console.log('① 显式指定一个不存在的路径 → 必须报错，且错误里带这个路径')
// ---------------------------------------------------------------------------
if (WIN) {
  const bogus = join(sandbox, 'no-such-powershell.exe')
  process.env[ENV] = bogus
  const saved = secrets.saveSecret('r02-shell-test', 'sk-test-value')
  eq(saved.ok, false, '保存失败（不是静默成功）')
  ok(String(saved.error ?? '').includes(bogus), '错误信息里带着那个不存在的路径')
  ok(String(saved.error ?? '').includes(ENV), '错误信息里点名是哪个环境变量')

  console.log('② 设成真实存在的可执行 → 不再报「路径不存在」')
  // 用 System32\cmd.exe 顶替：它存在，但跑不了我们的脚本，所以会以**另一种**理由失败。
  // 关键断言是「错误不再是路径不存在」—— 证明 powershellExe() 真的重新解析了，没有缓存空值。
  const cmdExe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe')
  ok(existsSync(cmdExe), `测试前提：${cmdExe} 存在`)
  process.env[ENV] = cmdExe
  const second = secrets.saveSecret('r02-shell-test2', 'sk-test-value')
  eq(second.ok, false, '仍然失败（cmd.exe 不是 PowerShell）')
  ok(!String(second.error ?? '').includes('指向的路径不存在'), '错误不再是「路径不存在」→ 说明没有缓存上一个失败')
  ok(String(second.error ?? '').includes('PowerShell') || String(second.error ?? '').includes('系统加密组件'),
    '错误文案仍然说得清是 PowerShell / 加密组件的问题')

  console.log('③ 不设环境变量时，能找到 System32 下那个 powershell.exe')
  delete process.env[ENV]
  const third = secrets.saveSecret('r02-shell-test3', 'sk-test-value')
  eq(third.ok, true, 'DPAPI 路径可用（能保存）')
  ok(third.encrypted === true, '确实是 DPAPI 加密，不是明文退化')
} else {
  console.log('① 非 Windows：走 plain 分支，不应触碰 PowerShell')
  process.env[ENV] = join(sandbox, 'no-such-powershell')
  const saved = secrets.saveSecret('r02-shell-test', 'sk-test-value')
  eq(saved.ok, true, '非 Windows 保存仍然成功（不依赖 PowerShell）')
  eq(saved.encrypted, false, '明确标记为「没有系统级加密」')
  ok(String(saved.error ?? '') === '', '没有因为那个环境变量报错')
}

// ---------------------------------------------------------------------------
console.log('④ 密钥文件权限与内容形态（回归：R01/P1-6 的加固没被弄坏）')
// ---------------------------------------------------------------------------
{
  const info = secrets.secretInfo(WIN ? 'r02-shell-test3' : 'r02-shell-test')
  eq(info.exists, true, '密钥文件存在')
  eq(info.source, 'file', '来源是文件')
  ok(typeof info.updatedAt === 'number' && info.updatedAt > 0, '有 mtime')
  // 明文绝不能出现在文件里
  const file = secrets.secretPath(WIN ? 'r02-shell-test3' : 'r02-shell-test')
  const { readFileSync } = await import('node:fs')
  const raw = readFileSync(file, 'utf8')
  ok(!raw.includes('sk-test-value'), '文件里没有明文密钥')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
delete process.env[ENV]
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
