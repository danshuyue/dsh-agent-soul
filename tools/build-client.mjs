#!/usr/bin/env node
/**
 * build-client.mjs —— 把 lib/client/ 下的浏览器端片段拼成 DSH 需要的单包 bundle
 * （lib/client.js）。
 *
 * 为什么需要它：
 *   DSH 客户端模块系统「一个包只出一个 bundle，兄弟文件无法同步 require」
 *   （dsh-switchman/client.js 顶部的注释明说）。所以要么挤成单个 1200+ 行的文件，
 *   要么用一个零依赖的拼接脚本，把按职责拆开的片段合成一个入口。这里选后者。
 *
 * 已解决原单文件的维护痛点：
 *   每个 Tab、样式、API、共享组件各归一个片段文件，能单独阅读、单独检查。
 *
 * 2026-11-05 修 P1-9：以前只检查「片段文件存在」，注释声称会 node --check
 *   其实从没跑过 —— 给片段塞个语法错误，脚本照样退出码 0 并写出坏 bundle，
 *   `npm publish` 就能把死掉的设置页发出去。现在拼接后真做语法解析、
 *   扫跨片段重名与 ESM 关键字，任何一项失败都非零退出且**不写盘**。
 *
 * 拼接规则：
 *   · 片段是「工厂函数作用域内」的纯 var/function 声明，不 import/export 任何东西
 *     （ESM 关键字会让 concat 后的作用域乱掉）；
 *   · 顺序即依赖顺序：靠前的片段声明的函数/变量，靠后的片段可以引用；
 *   · 唯一外壳（window.__ModuleLoader__.load 包装 + React/hooks/NS）写死在本脚本；
 *   · 每个片段都能 node --check 过 —— 引用未定义变量只是运行时 ReferenceError，
 *     node --check 只查语法，不会拦。
 *
 * 运行：node tools/build-client.mjs    （也挂在 npm run sync / test 前面）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanClientSymbols } from './client-symbols.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const projectRoot = join(here, '..')
const clientDir = join(projectRoot, 'lib', 'client')
const outFile = join(projectRoot, 'lib', 'client.js')

// 拼接顺序 = 依赖顺序。改了顺序要同步更新这个数组。
const ORDER = [
  'styles.js',        // CSS + ensureStyles（不依赖 h，最先）
  'api.js',           // API 常量 + readJson/apiGet/apiPost/cwdOf/timeLabel
  'components.js',    // 共享小组件 + 标签常量（依赖 h）
  'overview-tab.js',
  'persona-tab.js',
  'memory-tab.js',
  'purpose-tab.js',
  'mood-tab.js',
  'diary-tab.js',     // 日记：定时触发、手动触发、最近日记列表
  'notes-tab.js',     // 笔记：她自己写的 md，看/改/删
  'settings-tab.js',
  'app.js',           // SoulSection + ErrorBoundary + apply + module.exports
]

const DOC = `/**
 * client.js —— 浏览器半侧：设置页（手写 __ModuleLoader__ bundle）。
 *
 * ⚠️ 本文件是【生成物】，不要直接改 —— 改 lib/client/*.js 然后跑
 *    \`node tools/build-client.mjs\`（或 \`npm run sync\`）。DSH 客户端每个包只
 *    出一个 bundle、兄弟文件无法同步 require，所以把按职责拆开的片段拼回单文件。
 */

`

const HEADER =
  DOC +
  `window.__ModuleLoader__.load({
  id: 'dsh-agent-soul',
  factory: function (require) {
    // ⚠️ 这两行不能省：宿主只提供 require，不提供 CommonJS 的 module/exports。
    // 少了它们，factory 里一碰 module.exports 就是 "module is not defined"，
    // 而 DSH 的启动日志只会说「1 entry did not activate」—— 整个应用起不来。
    // node --check 查不出这个问题：它是语法层面合法的，只有真跑一次才炸。
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var NS = 'dsh-agent-soul'
`

const FOOTER = `
    return module.exports
  }
})
`

const missing = ORDER.filter((file) => !existsSync(join(clientDir, file)))
if (missing.length > 0) {
  console.error(`缺少片段：\n  ${missing.map((f) => join(clientDir, f)).join('\n  ')}`)
  process.exit(1)
}

// 统一成 LF：片段在 Windows 检出是 CRLF，外壳是 LF，产物会变成混合行尾，
// 跑一次 test 就把生成物标成 M（P2-18）。配合仓库根 .gitattributes 收口。
const fragments = ORDER.map((file) => ({
  file,
  text: readFileSync(join(clientDir, file), 'utf8').replace(/\r\n/g, '\n')
}))
const bundle = HEADER + '\n' + fragments.map((f) => f.text).join('\n\n') + FOOTER

const problems = []
// 2026-11-06 P11：跨片段符号表检查。片段之间靠隐式全局互调，
// 搬走或改名一个函数，另一个片段会静默 ReferenceError —— new Function 抓不到。
// 扫描器先剥注释/字符串再取调用，避免 CSS 模板串里的 rgba(...) 之类误报。
const symbolReport = scanClientSymbols(clientDir, ORDER)
for (const { file, names } of symbolReport.unknown) {
  problems.push(`${file} 引用了未定义的符号：${names.join('、')}（片段间靠隐式全局互调，搬走/改名会静默 ReferenceError）`)
}
// 2026-11-05：删掉了逐行扫纯文本的 ESM_RE。片段里有大量模板字符串，
// 行首出现 `import ` / `export ` 完全可能是给模型看的示例文本，正则会误判成
// 顶层 ESM 声明，把一次合法构建直接判死。真正的 ESM 语法错误本来就逃不过
// 下面的 new Function 解析，所以改成「只在解析真失败时」才归因提示。
const DECL_RE = /^\s{4}(?:function\s+([A-Za-z_$][\w$]*)\s*\(|var\s+([A-Za-z_$][\w$]*)\s*=)/gm
const seen = new Map()
for (const { file, text } of fragments) {
  for (const match of text.matchAll(DECL_RE)) {
    const name = match[1] ?? match[2]
    if (seen.has(name) && seen.get(name) !== file) {
      problems.push(`${name} 在 ${seen.get(name)} 与 ${file} 重复声明（后者会静默覆盖前者）`)
    } else if (!seen.has(name)) {
      seen.set(name, file)
    }
  }
}
// new Function 只解析、不执行：不会触发 window.__ModuleLoader__，也抓不到
// 「module is not defined」那类运行时错误（那由 tests/client.test.js 负责）。
try {
  new Function(bundle)
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  const esmHint = /import\b|export\b|Unexpected token/i.test(message)
    ? '（若片段里有顶层 import/export，拼接后作用域会乱，请改回 var/function 声明）'
    : ''
  problems.push(`拼接后的 bundle 语法错误：${message}${esmHint}`)
}
if (problems.length > 0) {
  console.error(`构建失败，产物未写入（${problems.length} 个问题）：\n  ${problems.join('\n  ')}`)
  process.exit(1)
}

// 内容没变就不写盘：避免每次 npm test 都把生成物 mtime 刷新一遍。
if (existsSync(outFile) && readFileSync(outFile, 'utf8') === bundle) {
  console.log(`产物无变化，跳过写盘（${ORDER.length} 个片段，${bundle.split('\n').length} 行，语法/重名/符号表检查通过）`)
} else {
  writeFileSync(outFile, bundle, 'utf8')
  console.log(`已拼接 ${outFile}（${ORDER.length} 个片段，${bundle.split('\n').length} 行，语法/重名/符号表检查通过）`)
}