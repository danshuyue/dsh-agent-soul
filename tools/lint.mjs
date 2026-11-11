#!/usr/bin/env node
/**
 * 轻量静态检查（2026-11-07 R12 / P2-30；2026-11-10 R20-C 扩充）。
 *
 * 为什么不用 eslint：这个项目**零运行时依赖**，为了一个 lint 装一棵 200 包的依赖树
 * 不划算，而且 esbuild/TS 那套配置对纯 ESM 脚本过重。
 * 这里只做「不需要解析器也能查、且真出过问题」的检查：
 *
 *   ① 未使用的 import 名字 —— `segment-memory.js` 导入了 `name` 从没用过。
 *      2026-11-10 R20-C（审查 H3）：修复多行 import 的跳过区间 —— 原来只跳到
 *      「首个换行」，多行 import 后续行里的名字会被当成「已使用」，检查静默失效。
 *   ② **用了但没导入**（R20-C 新增，H1 的直接解药）—— `legacyKeysInFile` 用了
 *      `readFileSync`/`CONFIG_FILE` 但两个都没导入，ReferenceError 被 catch 吞掉，
 *      功能从上线那天就是死的，而 node --check / 92 个测试 / CI 全绿。
 *      实现：剥掉字符串与注释后，收集「已声明」的名字（import / 声明 / 函数参数），
 *      再扫**调用目标**（标识符后跟 `(`），不在已声明集合与内置白名单里的报错。
 *      只查 `lib/` 服务端模块 —— `lib/client/*.js` 片段跑在 factory 作用域里，
 *      依赖注入的 h/React 等，另有 client-symbols 门禁管它。
 *      保守原则不变：宁可漏报（白名单放行），不要因为分析太糙就误报。
 *   ③ 测试里的恒真断言：字面量 `ok(true, …)`（原有）+ `|| true` 型（R20-C 新增，
 *      r18-evidence.test.js 的 `A && B === false || true` 就是这种，逃过了原检查）。
 *      允许 `// lint-allow:ok-true` / `// lint-allow:always-true` 行尾说明。
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

/** 剥掉字符串 / 注释 / 正则字面量（保留换行位置），给「用了但没导入」的扫描一个干净视图。
 *  2026-11-10 R20-C：正则字面量必须剥 —— 它里面常含引号（`/['"]/`）与 `(`（`(?:…)`），
 *  不剥的话剥字符串器会从正则里的引号开始失步，把后面整段代码吃进"字符串"里，
 *  于是该报的报不出来、不该报的乱报（signals.js 的 `b(`、feed.js 的 `pad(` 都是这么来的）。
 */
function stripCode(text) {
  const out = []
  let i = 0
  const n = text.length
  let prevMeaningful = '' // 上一个非空白字符（判断 `/` 是除法还是正则开头）
  let lastWord = '' // 最近一个完整单词（判断 return/typeof 等关键字后跟正则）
  while (i < n) {
    const ch = text[i]
    const next = text[i + 1]
    if (ch === '/' && next === '/') {
      while (i < n && text[i] !== '\n') { out.push(' '); i += 1 }
      continue
    }
    if (ch === '/' && next === '*') {
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) {
        out.push(text[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      out.push('  ')
      i += 2
      continue
    }
    // 正则字面量：`/` 且前一个有效字符表明「这里只能是正则，不是除法」。
    const prevIsWord = /[A-Za-z0-9_$)\]]/.test(prevMeaningful)
    const prevIsKeyword = ['return', 'typeof', 'case', 'in', 'of', 'new', 'delete', 'void', 'do', 'else'].includes(lastWord)
    if (ch === '/' && (prevMeaningful === '' || '([{;,=:!&|?<>+-*%~^\n'.includes(prevMeaningful) || prevIsKeyword)) {
      out.push(' ')
      i += 1
      let inClass = false
      while (i < n) {
        if (text[i] === '\\') { out.push('  '); i += 2; continue }
        if (text[i] === '[') { inClass = true; out.push(' '); i += 1; continue }
        if (text[i] === ']') { inClass = false; out.push(' '); i += 1; continue }
        if (text[i] === '/' && inClass === false) {
          // 跳过 flags（g/i/m/s/u/y/d）
          i += 1
          while (i < n && /[gimsuyd]/.test(text[i])) { out.push(' '); i += 1 }
          break
        }
        out.push(text[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      prevMeaningful = '/'
      continue
    }
    if (ch === '\'' || ch === '"' || ch === '`') {
      const quote = ch
      out.push(' ')
      i += 1
      while (i < n) {
        if (text[i] === '\\') { out.push('  '); i += 2; continue }
        if (text[i] === quote) { out.push(quote); i += 1; break }
        out.push(text[i] === '\n' ? '\n' : ' ')
        i += 1
      }
      prevMeaningful = quote
      continue
    }
    // 维护 lastWord（供「关键字后跟正则」判断）：字母数字续词，其它字符清空
    if (/[A-Za-z0-9_$]/.test(ch)) lastWord += ch
    else lastWord = ''
    if (/\S/.test(ch)) prevMeaningful = ch
    out.push(ch)
    i += 1
  }
  return out.join('')
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
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push({ local, index: m.index, end: m.index + m[0].length })
    }
  }
  return names
}

/** 这个标识符在文件里除了 import 语句之外还出现过吗。
 *  2026-11-10 R20-C（审查 H3）：跳过区间改为**整条 import 语句**（原来只跳到
 *  首个换行，多行 import 后续行里的名字会被误判成「已使用」）。 */
function usedElsewhere(text, local, statementStart, statementEnd) {
  const escaped = local.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'g')
  let m
  while ((m = re.exec(text)) !== null) {
    if (m.index >= statementStart && m.index < statementEnd) continue
    return true
  }
  return false
}

/** JS / Node 内置：这些名字不算「用了但没导入」。 */
const GLOBALS = new Set([
  'console', 'process', 'JSON', 'Math', 'Date', 'URL', 'URLSearchParams', 'Buffer',
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'URIError',
  'RegExp', 'Promise', 'Set', 'Map', 'WeakMap', 'WeakSet', 'WeakRef', 'FinalizationRegistry',
  'Number', 'String', 'Boolean', 'Array', 'Object', 'Symbol', 'BigInt', 'Function',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'setImmediate', 'clearImmediate', 'queueMicrotask', 'structuredClone', 'globalThis',
  'undefined', 'NaN', 'Infinity', 'require', 'fetch', 'AbortController', 'AbortSignal',
  'TextEncoder', 'TextDecoder', 'performance', 'Event', 'EventTarget'
  // 注意：node:fs 的 readFileSync 等**不是**全局 —— ESM 里必须 import。
  // 2026-11-10 曾把它们误放进白名单，导致「删掉 H1 的导入 lint 也不红」
  //（复核方 §10.5 的抽查项）。白名单只收真正的 JS/Node 全局。
])

/** 关键字：后面跟 `(` 不是函数调用。 */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'new', 'typeof',
  'delete', 'void', 'in', 'of', 'else', 'do', 'await', 'yield', 'with', 'async'
])

/** 收集文件里「已声明」的名字：声明 / 函数名 / 类名 / 函数参数（含解构）。 */
function declaredNames(code) {
  const names = new Set()
  const add = (raw) => {
    for (const token of String(raw).match(/[A-Za-z_$][\w$]*/g) ?? []) names.add(token)
  }
  // import 的绑定（named / default / namespace）
  for (const m of code.matchAll(/import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\}\s*)?(?:\*\s+as\s+([A-Za-z_$][\w$]*)\s*)?from/g)) {
    if (m[1]) names.add(m[1])
    if (m[2]) add(m[2])
    if (m[3]) names.add(m[3])
  }
  // 声明：const/let/var 的首个名字 + 解构里的全部名字
  for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\b(?:const|let|var)\s*[{[]([^};]*)[}\]]\s*=/g)) add(m[1])
  // 函数 / 类名
  for (const m of code.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  // 参数：function (...) 形参 与 (…) => 形参 —— 括号里所有标识符都算「已声明」
  // （宽了没关系：参数本来就该被当作局部名，宁漏报不误报）
  for (const m of code.matchAll(/\bfunction\b[^(]*\(([^)]*)\)/g)) add(m[1])
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1])
  // catch (error) 形参
  for (const m of code.matchAll(/\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

/** 找出「调用了但全文件没人声明」的标识符。 */
function undeclaredCalls(code) {
  const declared = declaredNames(code)
  const targets = []
  // 标识符后紧跟 `(`；前面不能是 `.` / `?`（属性调用）也不能是字母数字（那是别的标识符的一部分）
  const re = /(?<![.\w$'"])([A-Za-z_$][\w$]*)\s*\(/g
  let m
  while ((m = re.exec(code)) !== null) {
    const name = m[1]
    if (KEYWORDS.has(name)) continue
    if (GLOBALS.has(name)) continue
    if (declared.has(name)) continue
    targets.push({ name, index: m.index })
  }
  return targets
}

const problems = []

for (const file of walk(join(projectRoot, 'lib'))) {
  const rel = relative(projectRoot, file).replace(/\\/g, '/')
  const text = readFileSync(file, 'utf8')
  // lib/client/*.js 片段跑在 factory 作用域里（h / React / NS 等由宿主注入），
  // 「用了但没导入」的检查不适用 —— 它们有 client-symbols 门禁管。
  const isFragment = rel.startsWith('lib/client/') && rel !== 'lib/client.js'
  const imports = importedNames(text)
  for (const { local, index, end } of imports) {
    if (local === 'default') continue
    if (!usedElsewhere(text, local, index, end)) {
      problems.push({ file: rel, kind: 'unused-import', name: local })
    }
  }
  if (isFragment) continue
  const code = stripCode(text)
  for (const { name, index } of undeclaredCalls(code)) {
    const line = text.slice(0, index).split('\n').length
    problems.push({ file: rel, kind: 'undeclared-call', name, line })
  }
}

for (const file of walk(join(projectRoot, 'tests'))) {
  const rel = relative(projectRoot, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split('\n')
  lines.forEach((line, i) => {
    // 注释里提到 ok(true, …) 不算问题（那是解释，不是断言）
    if (/^\s*(\/\/|\*)/.test(line)) return
    if (line.includes('lint-allow:ok-true') || line.includes('lint-allow:always-true')) return
    if (/\bok\(\s*true\b/.test(line)) {
      problems.push({ file: rel, kind: 'ok-true', line: i + 1, text: line.trim() })
      return
    }
    // 2026-11-10 R20-C（审查 H3②）：`A && B === false || true` 这种「|| true」型
    // 恒真表达式 —— 原检查只匹配字面量 ok(true, …)，这类全漏。
    if (/\bok\(/.test(line) && /\|\|\s*true\b/.test(line)) {
      problems.push({ file: rel, kind: 'always-true', line: i + 1, text: line.trim() })
    }
  })
}

if (problems.length === 0) {
  console.log('lint: 没有发现问题（未使用导入 / 用了未导入 / 恒真断言）')
  process.exit(0)
}

for (const p of problems) {
  if (p.kind === 'unused-import') console.error(`✗ ${p.file}: 导入了 ${p.name} 但没用过`)
  else if (p.kind === 'undeclared-call') console.error(`✗ ${p.file}:${p.line}: 调用了未声明的标识符 ${p.name}( —— 缺 import 或拼错名字（H1 的形状：ReferenceError 会被 catch 吞掉）`)
  else if (p.kind === 'always-true') console.error(`✗ ${p.file}:${p.line}: 恒真断言（|| true 型）—— ${p.text.slice(0, 80)}`)
  else console.error(`✗ ${p.file}:${p.line}: 恒真断言 ok(true, …) —— ${p.text.slice(0, 80)}`)
}
console.error(`\nlint: ${problems.length} 个问题`)
process.exit(1)
