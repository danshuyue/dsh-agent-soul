/**
 * 契约门禁 ⑤：宿主加载入口清单（2026-11-06 P11）。
 *
 * 模块化重构后新增了 7 个 lib/ 子目录，最容易出事的是「宿主按老路径加载」——
 * 仓库内测试全绿，但插件在 DSH 里根本不激活。package.json 的 main/exports、
 * cordis.patch.yml 的裸包名、lib/client.js 单 bundle、CI 的硬编码路径，
 * 这些是「一动就炸」的外部契约，在这里逐项钉住。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOME = mkdtempSync(join(tmpdir(), 'soul-entries-'))
process.env.DSH_HOME = HOME

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

try {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

  console.log('\n① package.json 入口')
  ok(typeof pkg.main === 'string' && existsSync(join(root, pkg.main)), `main 指向的文件存在（${pkg.main}）`)
  for (const [sub, target] of Object.entries(pkg.exports ?? {})) {
    const path = String(target).replace(/^\.\//, '')
    ok(existsSync(join(root, path)), `exports["${sub}"] → ${path} 存在`)
  }
  for (const entry of pkg.files ?? []) {
    ok(existsSync(join(root, entry)), `files 里的 ${entry} 存在`)
  }

  console.log('\n② 四处裸包名必须一致（DSH 按目录名找包）')
  const patch = readFileSync(join(root, 'cordis.patch.yml'), 'utf8')
  const patchName = patch.match(/^\s*name:\s*(\S+)\s*$/m)?.[1] ?? ''
  eq(patchName, pkg.name, 'cordis.patch.yml 的 name 与 package.json 一致')
  const index = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  eq(index.name, pkg.name, 'lib/index.js 导出的 name 与 package.json 一致')
  ok(typeof index.apply === 'function', 'lib/index.js 导出 apply 函数')
  ok(index.inject !== undefined, 'lib/index.js 导出 inject 声明')

  console.log('\n③ 浏览器单 bundle')
  const bundlePath = join(root, 'lib', 'client.js')
  ok(existsSync(bundlePath) && statSync(bundlePath).size > 1000, 'lib/client.js 存在且非空')
  let parseError = null
  try { new Function(readFileSync(bundlePath, 'utf8')) } catch (e) { parseError = e }
  eq(parseError, null, 'bundle 能被解析（语法正确）')
  ok(readFileSync(bundlePath, 'utf8').includes("window.__ModuleLoader__.load"), 'bundle 仍带宿主期望的 __ModuleLoader__ 外壳')
  const fragments = readdirSync(join(root, 'lib', 'client')).filter((f) => f.endsWith('.js'))
  ok(fragments.length >= 10, `片段目录仍在（${fragments.length} 个，产物由源码拼接）`)

  console.log('\n④ 发布与 CI 门禁')
  ok(String(pkg.scripts.prepack).includes('npm test'), 'prepack 会跑全量测试')
  ok(typeof pkg.scripts['sync:host'] === 'string', 'sync:host 与只构建的 sync 已分开')
  const attrs = readFileSync(join(root, '.gitattributes'), 'utf8')
  ok(attrs.includes('lib/client.js'), '.gitattributes 锁定生成物行尾')
  const ci = readFileSync(join(root, '.github', 'workflows', 'ci.yml'), 'utf8')
  ok(ci.includes('git diff --exit-code'), 'CI 有产物一致性门禁')
  ok(ci.includes('npm test'), 'CI 跑全量测试')
} catch (error) {
  failed += 1
  console.error(`  ✗ 入口检查抛异常：${error instanceof Error ? `${error.message}\n${error.stack}` : String(error)}`)
} finally {
  rmSync(HOME, { recursive: true, force: true })
  console.log('\n收尾：')
  ok(!existsSync(HOME), '临时 DSH_HOME 已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
