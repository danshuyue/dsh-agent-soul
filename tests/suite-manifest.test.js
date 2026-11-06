/**
 * 测试收集与发布门禁（2026-11-06 重构 P0 重写）。
 *
 * 原版靠正则比对 npm test 的 51 条手工长串防漂移。现在长串已换成
 * tools/run-tests.mjs 的递归收集器，这里改成比对「收集器实际收集到的集合」
 * 与「tests/ 目录里真实存在的集合」—— 两边用同一套文件发现逻辑之外，
 * 再加一层独立实现，防止收集器自己漏扫。
 *
 * 仍然串行：40 个自建 runner 与 9 个 node:test 用例并存，很多用例各自
 * mkdtemp 同一套 DSH_HOME 布局，并发会互相踩临时目录。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectTests } from '../tools/run-tests.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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

/** 独立实现：递归列出 tests/ 下所有 .test.js，返回相对项目根、/ 分隔的路径 */
function actualTests(dir, prefix = 'tests') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    const rel = `${prefix}/${entry.name}`
    if (entry.isDirectory()) return actualTests(full, rel)
    return entry.name.endsWith('.test.js') ? [rel] : []
  }).sort()
}

const collected = collectTests()
const actual = actualTests(join(root, 'tests'))

console.log('测试收集：')
ok(collected.length > 0, '收集器至少收集到一个测试文件')
eq(collected, actual, '收集集合与 tests/ 实际文件集合逐项相等（含子目录）')
eq(new Set(collected).size, collected.length, '没有重复收集')
ok(collected.every((f) => f.endsWith('.test.js') && statSync(join(root, f)).isFile()), '每个收集项都是真实文件')
ok(String(pkg.scripts.test).startsWith('node tools/build-client.mjs'), '构建排在测试最前（client.test.js 读产物）')
ok(String(pkg.scripts.test).includes('node tools/run-tests.mjs'), 'npm test 走自动收集器，不再靠手工长串')
ok(readFileSync(join(root, 'tools', 'run-tests.mjs'), 'utf8').includes('entry.isDirectory()'), '收集器是递归的')

console.log('契约门禁：')
for (const name of ['exports.snapshot', 'dep-graph', 'behavior-golden']) {
  ok(statSync(join(root, 'tests', 'contract', `${name}.test.js`)).isFile(), `${name} 契约测试存在`)
}

console.log('发布门禁：')
ok(typeof pkg.scripts.prepack === 'string' && pkg.scripts.prepack.includes('npm test'), 'prepack 会跑全量测试')
ok(typeof pkg.scripts['sync:host'] === 'string', 'sync:host 与只构建的 sync 已分开')
ok(readFileSync(join(root, '.gitattributes'), 'utf8').includes('lib/client.js'), '.gitattributes 存在且覆盖生成物')
ok(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').includes('git diff --exit-code'), 'CI 有产物一致性门禁')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
