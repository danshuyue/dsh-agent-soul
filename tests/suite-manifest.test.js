/**
 * 测试登记清单（2026-11-05 修 P1-7）：node tests/suite-manifest.test.js
 *
 * npm test 是 40 条 `node tests/xxx.test.js` 的手工长串，已经漂移过一次
 * （diary-complete.test.js 从来没被跑过）。这里不换成 node --test 自动收集 ——
 * 仓库里自建 runner 与 node:test 两套并存，并发跑会互相踩临时目录；
 * 改用「清单门禁」：所有 .test.js 必须登记、登记的文件必须存在、不许重复。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

const registered = [...String(pkg.scripts.test).matchAll(/tests\/([\w-]+\.test\.js)/g)].map((m) => m[1])
const all = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.js')).sort()

console.log('测试登记：')
eq(all.filter((f) => !registered.includes(f)), [], 'tests/ 下没有漏登记的 .test.js')
eq(registered.filter((f) => !all.includes(f)), [], '长串里没有指向不存在文件的幽灵引用')
eq(registered.filter((f, i) => registered.indexOf(f) !== i), [], '没有重复登记')
ok(registered.length === all.length, `登记 ${registered.length} 个 / 实际 ${all.length} 个`)
ok(String(pkg.scripts.test).startsWith('node tools/build-client.mjs'), '构建排在测试最前（client.test.js 读产物）')

console.log('发布门禁：')
ok(typeof pkg.scripts.prepack === 'string' && pkg.scripts.prepack.includes('npm test'), 'prepack 会跑全量测试')
ok(typeof pkg.scripts['sync:host'] === 'string', 'sync:host 与只构建的 sync 已分开')
ok(readFileSync(join(root, '.gitattributes'), 'utf8').includes('lib/client.js'), '.gitattributes 存在且覆盖生成物')
ok(readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8').includes('git diff --exit-code'), 'CI 有产物一致性门禁')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
