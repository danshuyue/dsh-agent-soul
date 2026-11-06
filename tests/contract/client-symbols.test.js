/**
 * 契约门禁 ④：浏览器片段跨文件符号表（2026-11-06 P11）。
 *
 * lib/client/*.js 拼成单 bundle 后共享一个闭包，片段之间靠隐式全局互调。
 * `new Function(bundle)` 只查语法，查不出「某个函数被搬走/改名」造成的
 * 运行时 ReferenceError。这里要求所有调用形态的符号都能在符号表里找到定义。
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { codeView, scanClientSymbols } from '../../tools/client-symbols.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const clientDir = join(root, 'lib', 'client')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

const files = readdirSync(clientDir).filter((f) => f.endsWith('.js')).sort()

console.log('符号表扫描：')
const report = scanClientSymbols(clientDir, files)
ok(files.length >= 10, `片段数量合理（${files.length} 个）`)
ok(report.topLevel.length >= 30, `顶层声明被识别（${report.topLevel.length} 个）`)
for (const name of ['API', 'Card', 'DiaryTab', 'OverviewTab', 'PersonaTab']) {
  ok(report.topLevel.includes(name), `顶层符号 ${name} 在符号表里`)
}
ok(report.unknown.length === 0,
  `没有未定义的隐式全局${report.unknown.length ? ` → ${report.unknown.map((u) => `${u.file}: ${u.names.join(',')}`).join('; ')}` : ''}`)

console.log('\n扫描器自身的正确性（防门禁变成恒真）：')
ok(!codeView('var s = `rgba(1, 2, 3, .5)`').includes('rgba('), '模板串里的 CSS 函数调用被剥掉')
ok(!codeView('// ghostInComment()\nvar a = 1').includes('ghostInComment'), '行注释里的调用被剥掉')
ok(!codeView('/* ghostInBlock() */\nvar a = 1').includes('ghostInBlock'), '块注释里的调用被剥掉')
ok(codeView('var s = `${realCall()}`').includes('realCall()'), '模板插值里的真调用被保留')
ok(codeView('var [data, setData] = useState(0)').includes('setData'), 'useState 解构声明被保留')

console.log('\n元验证：投毒一个幽灵调用，扫描必须报出来')
const temp = mkdtempSync(join(tmpdir(), 'soul-symbols-'))
try {
  for (const f of files) copyFileSync(join(clientDir, f), join(temp, f))
  writeFileSync(join(temp, files[0]), '\n    function ghostPoison() { ghostSymbolProbe() }\n', { flag: 'a' })
  const poisoned = scanClientSymbols(temp, files)
  ok(poisoned.unknown.some((u) => u.names.includes('ghostSymbolProbe')), '幽灵符号被识别为未定义')
  ok(poisoned.unknown.every((u) => !u.names.includes('ghostPoison')), '新声明的函数本身不算未定义')
} finally {
  rmSync(temp, { recursive: true, force: true })
  ok(!existsSync(temp), '临时片段目录已清理')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
