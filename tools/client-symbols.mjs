/**
 * 浏览器片段的跨文件符号表检查（2026-11-06 P11）。
 *
 * lib/client/*.js 不是 ESM：它们被 build-client.mjs 拼进同一个 factory 闭包，
 * 片段之间靠「隐式全局」互相调用。搬走或改名一个函数，另一个片段会静默
 * 变成 ReferenceError —— 而 `new Function(bundle)` 只做语法解析，抓不到。
 *
 * 这里做两件事：
 *   1. 收集所有片段里声明的符号（顶层 + 局部函数 + 解构 + 形参），
 *      形成整个 bundle 的共享符号表；
 *   2. 扫描所有「调用形态」的标识符，报告既没在符号表里、也不属于
 *      JS/浏览器/宿主全局的名字 —— 这就是漏接的隐式依赖。
 *
 * 关键：必须先剥掉注释与字符串。片段里有大量 CSS 模板串（`rgba(...)`、
 * `translateX(...)`）和给模型看的示例文本，不剥会报出几十个假符号。
 * 模板串 `${...}` 插值内部仍按代码保留，避免把真调用抹掉。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 把源码里非代码 token 抹成空格，保留下标、换行与模板插值内的代码。 */
export function codeView(src) {
  const out = src.split('')
  const n = src.length
  const blank = (a, b) => {
    for (let k = Math.max(0, a); k < Math.min(n, b); k++) if (out[k] !== '\n') out[k] = ' '
  }
  const skipString = (i, q) => {
    let j = i + 1
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === q) return j + 1
      if (q !== '`' && src[j] === '\n') return j
      j++
    }
    return n
  }
  const skipRegex = (i) => {
    let j = i + 1, inClass = false
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === '\n') return j
      if (src[j] === '[') inClass = true
      else if (src[j] === ']') inClass = false
      else if (src[j] === '/' && !inClass) {
        j++
        while (j < n && /[a-z]/i.test(src[j])) j++
        return j
      }
      j++
    }
    return n
  }
  const regexStart = (i) => {
    let k = i - 1
    while (k >= 0 && /\s/.test(src[k])) k--
    if (k < 0) return true
    if ('(,=:[!&|?{};+*%~^'.includes(src[k])) return true
    return /\b(?:return|throw|case|typeof|void|delete|new|in|of|do|else)\s*$/.test(src.slice(Math.max(0, k - 9), k + 1))
  }
  function scanTemplate(start) {
    let seg = start, j = start + 1
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === '`') { blank(seg, j + 1); return j + 1 }
      if (src[j] === '$' && src[j + 1] === '{') {
        blank(seg, j)
        const k = scanInterpolation(j + 2)
        seg = k; j = k
        continue
      }
      j++
    }
    blank(seg, n)
    return n
  }
  function scanInterpolation(start) {
    let depth = 1, i = start
    while (i < n && depth > 0) {
      const c = src[i], c2 = src[i + 1]
      if (c === '/' && c2 === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue }
      if (c === '/' && c2 === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(n, j + 2); blank(i, j); i = j; continue }
      if (c === "'" || c === '"') { const j = skipString(i, c); blank(i, j); i = j; continue }
      if (c === '`') { i = scanTemplate(i); continue }
      if (c === '{') { depth++; i++; continue }
      if (c === '}') { depth--; i++; continue }
      if (c === '/' && regexStart(i)) { const j = skipRegex(i); blank(i, j); i = j; continue }
      i++
    }
    return i
  }
  let i = 0
  while (i < n) {
    const c = src[i], c2 = src[i + 1]
    if (c === '/' && c2 === '/') { let j = i; while (j < n && src[j] !== '\n') j++; blank(i, j); i = j; continue }
    if (c === '/' && c2 === '*') { let j = i + 2; while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++; j = Math.min(n, j + 2); blank(i, j); i = j; continue }
    if (c === "'" || c === '"') { const j = skipString(i, c); blank(i, j); i = j; continue }
    if (c === '`') { i = scanTemplate(i); continue }
    if (c === '/' && regexStart(i)) { const j = skipRegex(i); blank(i, j); i = j; continue }
    i++
  }
  return out.join('')
}

/** 宿主 factory 注入 + JS/浏览器内置。这些名字不需要在片段里声明。 */
const GLOBALS = new Set([
  'React', 'h', 'useCallback', 'useEffect', 'useState', 'module', 'exports', 'require', 'NS',
  'window', 'document', 'console', 'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'Promise', 'JSON', 'Math', 'Date', 'String', 'Number', 'Array', 'Object', 'Boolean', 'RegExp',
  'Error', 'Map', 'Set', 'Symbol', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'localStorage', 'sessionStorage', 'navigator',
  'location', 'alert', 'confirm', 'AbortSignal', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FileReader', 'FormData', 'Headers', 'Request', 'Response', 'TextEncoder', 'TextDecoder',
  'Intl', 'Infinity', 'NaN', 'undefined', 'globalThis', 'queueMicrotask', 'structuredClone',
  'btoa', 'atob', 'CSS', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
])
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof', 'new', 'throw',
  'await', 'async', 'of', 'in', 'do', 'else', 'try', 'finally', 'case', 'default', 'delete',
  'void', 'yield', 'class', 'extends', 'import', 'export', 'var', 'let', 'const', 'instanceof',
  'with', 'debugger'
])

/**
 * @param {string} clientDir 片段目录
 * @param {string[]} files 片段文件名（按拼接顺序）
 * @returns {{ declared: string[], unknown: Array<{file: string, names: string[]}>, topLevel: string[] }}
 */
export function scanClientSymbols(clientDir, files) {
  const declared = new Set()
  const topLevel = new Set()
  const perFileCalls = new Map()

  for (const file of files) {
    const raw = readFileSync(join(clientDir, file), 'utf8').replace(/\r\n/g, '\n')
    const code = codeView(raw)

    // 顶层声明：拼接后处于 factory 顶层（4 空格缩进）
    // 2026-11-09 KNOWN-ISSUES #32：放宽到 let/const（原来只认 var/function，顶层
    // let/const 不进 topLevel，跨片段重名/漏接检查会静默失效）。
    for (const m of code.matchAll(/^\s{4}(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=)/gm)) {
      const name = m[1] ?? m[2]
      if (name) { declared.add(name); topLevel.add(name) }
    }
    // 任意层级的函数声明 / 变量声明
    for (const m of code.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=)/g)) {
      const name = m[1] ?? m[2]
      if (name) declared.add(name)
    }
    // 解构：var [a, setA] = useState(...) / var { a, b: c } = obj
    for (const m of code.matchAll(/(?:var|let|const)\s*\[([^\]]+)\]\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]
        if (name) declared.add(name)
      }
    }
    for (const m of code.matchAll(/(?:var|let|const)\s*\{([^}]+)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s*:\s*/).pop().trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]
        if (name) declared.add(name)
      }
    }
    // 形参：function (a, b) { / (a, b) => { / function foo(a) {
    for (const m of code.matchAll(/\(([^()]*)\)\s*(?:=>|\{)/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().match(/^([A-Za-z_$][\w$]*)/)?.[1]
        if (name) declared.add(name)
      }
    }
    // catch (e)
    for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)/g)) declared.add(m[1])

    const calls = new Set()
    for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      if (!KEYWORDS.has(m[2])) calls.add(m[2])
    }
    perFileCalls.set(file, calls)
  }

  const unknown = []
  for (const file of files) {
    const names = [...perFileCalls.get(file)]
      .filter((n) => !declared.has(n) && !GLOBALS.has(n))
      .sort()
    if (names.length > 0) unknown.push({ file, names })
  }
  return { declared: [...declared].sort(), topLevel: [...topLevel].sort(), unknown }
}
