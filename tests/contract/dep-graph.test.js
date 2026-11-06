/**
 * 契约门禁 ②：模块依赖图（2026-11-06 重构 P0）。
 *
 * 拆文件之前先钉住依赖方向：
 *   - 现存环只有 store → health → diary → store 一条（health.js:39-40 注释自认）；
 *     P3 断环后把 KNOWN_CYCLES 清空，门禁会强制「零环」。
 *   - core/ 基础层不得反向依赖业务层；
 *   - memory/、mood/ 子模块不得回指门面或 state/（避免拆分后立刻成环）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const libDir = join(root, 'lib')

// 2026-11-06 P3 已断掉 store → health → diary → store 的环，零环成为硬约束
const KNOWN_CYCLES = []

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

function jsFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) return rel === 'client' ? [] : jsFiles(join(dir, entry.name), rel)
    if (!entry.name.endsWith('.js') || rel === 'client.js') return []
    return [rel]
  })
}

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'";]*?from\s*['"](\.[^'"]+)['"]|(?:^|\n)\s*import\s*['"](\.[^'"]+)['"]/g
const files = jsFiles(libDir).sort()
const graph = new Map()
for (const rel of files) {
  const text = readFileSync(join(libDir, rel), 'utf8')
  const deps = []
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2]
    const resolved = posix.normalize(posix.join(posix.dirname(rel), spec))
    deps.push(resolved)
  }
  graph.set(rel, [...new Set(deps)])
}

// DFS 找环；用「环上节点集合」做 key，避免同环不同起点重复计数
const cycles = new Set()
const visited = new Set()
const stack = []
const onStack = new Set()
function visit(node) {
  if (onStack.has(node)) {
    const i = stack.indexOf(node)
    cycles.add([...stack.slice(i)].sort().join('|'))
    return
  }
  if (visited.has(node)) return
  visited.add(node)
  onStack.add(node)
  stack.push(node)
  for (const dep of graph.get(node) ?? []) visit(dep)
  stack.pop()
  onStack.delete(node)
}
for (const f of files) visit(f)

console.log('依赖图：')
ok(files.length > 0, `扫描 ${files.length} 个 lib 模块`)
const found = [...cycles].sort()
eq(found, KNOWN_CYCLES, '模块环集合与已知白名单完全一致（新增环必须当场断掉）')

const badCore = []
const badMemory = []
const badMood = []
for (const [file, deps] of graph) {
  for (const dep of deps) {
    if (file.startsWith('core/') && !dep.startsWith('core/') && dep !== 'paths.js' && dep !== 'env.js') {
      badCore.push(`${file} → ${dep}`)
    }
    if (file.startsWith('memory/') && (dep === 'memory.js' || dep === 'store.js')) {
      badMemory.push(`${file} → ${dep}`)
    }
    if (file.startsWith('mood/') && dep.startsWith('state/')) {
      badMood.push(`${file} → ${dep}`)
    }
  }
}
eq(badCore, [], 'core/ 不反向依赖业务层')
eq(badMemory, [], 'memory/ 子模块不回指门面或 store')
eq(badMood, [], 'mood/ 子模块不依赖 state/')

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
