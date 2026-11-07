#!/usr/bin/env node
/**
 * 轻量静态检查（2026-11-07 R12 / P2-30）。
 *
 * 为什么不用 eslint：这个项目**零运行时依赖**，为了一个 lint 装一棵 200 包的依赖树
 * 不划算，而且 esbuild/TS 那套配置对纯 ESM 脚本过重。
 * 这里只做两条「不需要解析器也能查、且真出过问题」的检查：
 *
 *   ① 未使用的 import 名字 —— 报告里就有一条：`segment-memory.js` 导入了 `name` 从没用过。
 *      死导入不会报错，只会在读代码时误导人（以为这里用到了）。
 *   ② 测试里的恒真断言 `ok(true, …)` —— 它们看起来像断言，实际什么都没验。
 *      允许带 `// lint-allow:ok-true` 的行（真需要「到这里没抛异常就算过」时用）。
 *
 * 两条都是**保守**的：宁可漏报，也不要因为字符串里恰好出现某个词就误报。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function walk(dir, ext = '.js') {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full, ext))
    else if (entry.name.endsWith(ext)) out.push(full)
  }
  return out
}

/** 从 `import { a, b as c } from '…'` 里抠出本地名字 */
function importedNames(text) {
  const names = []
  const re = /import\s*\{([^}]*)\}\s*from\s*['"][^'"]+['"]/g
  let m
  while ((m = re.exec(text)) !== null) {
    for (const part of m[1].split(',')) {
      const piece = part.trim()
      if (piece === '') continue
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(piece)
      const local = asMatch ? asMatch[1] : piece
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push({ local, index: m.index })
    }
  }
  return names
}

/** 这个标识符在文件里除了 import 语句之外还出现过吗 */
function usedElsewhere(text, local, importIndex) {
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    // 跳过 import 语句所在的那一段（从 import 到该语句结尾的分号）
    if (m.index >= importIndex) {
      const tail = text.slice(importIndex)
      const end = tail.indexOf('\n')
      const lineEnd = end === -1 ? text.length : importIndex + end
      if (m.index < lineEnd) continue
    }
    return true
  }
  return false
}

const problems = []

for (const file of walk(join(projectRoot, 'lib'))) {
  const rel = relative(projectRoot, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  for (const { local, index } of importedNames(text)) {
    if (local === 'default') continue
    if (!usedElsewhere(text, local, index)) {
      problems.push({ file: rel, kind: 'unused-import', name: local })
    }
  }
}

for (const file of walk(join(projectRoot, 'tests'))) {
  const rel = relative(projectRoot, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // 注释里提到 ok(true, …) 不算问题（那是解释，不是断言）
    if (/^\s*(\/\/|\*)/.test(line)) return
    if (!/\bok\(\s*true\b/.test(line)) return
    if (line.includes('lint-allow:ok-true')) return
    problems.push({ file: rel, kind: 'ok-true', line: i + 1, text: line.trim() })
  })
}

if (problems.length === 0) {
  console.log('lint: 没有发现问题（未使用导入 / 恒真断言）')
  process.exit(0)
}

for (const p of problems) {
  if (p.kind === 'unused-import') console.error(`✗ ${p.file}: 导入了 ${p.name} 但没用过`)
  else console.error(`✗ ${p.file}:${p.line}: 恒真断言 ok(true, …) —— ${p.text.slice(0, 80)}`)
}
console.error(`\nlint: ${problems.length} 个问题`)
process.exit(1)
