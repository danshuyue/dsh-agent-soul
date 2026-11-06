/**
 * 契约门禁 ①：导出名快照（2026-11-06 重构 P0）。
 *
 * 大范围搬家的最大风险是「搬完某个 export 不见了，而现有测试恰好没引用它」。
 * 这里把每个 lib 模块的导出名集合冻成快照，每批重构后逐集合比对。
 * 新增导出是允许的（要更新快照），少一个、改一个名字都直接红。
 *
 * 首次运行会生成快照；要主动更新用 `SOUL_UPDATE_SNAPSHOT=1 node tests/contract/exports.snapshot.test.js`。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { requireSnapshotReason } from './snapshot-policy.mjs'

if (!process.env.DSH_HOME) process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'soul-exports-'))
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const libDir = join(root, 'lib')
const snapshotFile = join(root, 'tests', 'contract', 'exports.snapshot.json')

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.error(`  ✗ ${name}`) }
}

/** 浏览器半侧不是 Node 模块（片段靠 factory 闭包、生成物需要 window），排除 */
function modules(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      return rel === 'client' ? [] : modules(join(dir, entry.name), rel)
    }
    if (!entry.name.endsWith('.js')) return []
    return rel === 'client.js' ? [] : [rel]
  })
}

const files = modules(libDir).sort()
const current = {}
const loadErrors = []
for (const rel of files) {
  try {
    const mod = await import(pathToFileURL(join(libDir, rel)).href)
    current[rel] = Object.keys(mod).sort()
  } catch (error) {
    loadErrors.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log('导出名快照：')
ok(loadErrors.length === 0, `所有 lib 模块都能被 import（${files.length} 个）${loadErrors.length ? ` → ${loadErrors.join('; ')}` : ''}`)

// 2026-11-06 第二份审查 H-4：基线**缺失**时不许静默重建。
// 原来 `!existsSync(snapshotFile)` 会直接走进「首次生成」分支 —— 删掉基线文件
// 就等于把门禁整个关掉，而且 `git status` 上只会多一个「新增文件」。
// 现在缺基线必须显式说明是首次生成（SOUL_UPDATE_SNAPSHOT=1），否则本测试失败。
if (!existsSync(snapshotFile) && process.env.SOUL_UPDATE_SNAPSHOT !== '1') {
  ok(false, `基线文件存在（${relative(root, snapshotFile)} 缺失时不许静默重建；首次生成请显式 SOUL_UPDATE_SNAPSHOT=1）`)
} else if (!existsSync(snapshotFile) || process.env.SOUL_UPDATE_SNAPSHOT === '1') {
  const existed = existsSync(snapshotFile)
  // 2026-11-06 P11：更新已有基线必须写明理由并留痕，防「刷基线消红」。
  if (existed) requireSnapshotReason(root, 'exports.snapshot.json')
  writeFileSync(snapshotFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  console.log(`  · 已${existed ? '更新' : '生成'}快照：${relative(root, snapshotFile)}`)
  ok(Object.keys(current).length > 0, '快照非空')
} else {
  const expected = JSON.parse(readFileSync(snapshotFile, 'utf8'))
  const missing = Object.keys(expected).filter((f) => !Object.hasOwn(current, f))
  const added = Object.keys(current).filter((f) => !Object.hasOwn(expected, f))
  ok(missing.length === 0, `没有模块消失${missing.length ? ` → ${missing.join(', ')}` : ''}`)
  ok(added.length === 0, `没有未登记的模块（新增请更新快照）${added.length ? ` → ${added.join(', ')}` : ''}`)
  for (const file of Object.keys(expected).sort()) {
    if (!current[file]) continue
    const exp = expected[file]
    const got = current[file]
    const lost = exp.filter((n) => !got.includes(n))
    const extra = got.filter((n) => !exp.includes(n))
    ok(lost.length === 0 && extra.length === 0,
      `${file} 导出集合不变（${exp.length} 个）${lost.length ? ` 少了 ${lost.join(',')}` : ''}${extra.length ? ` 多了 ${extra.join(',')}` : ''}`)
  }
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
