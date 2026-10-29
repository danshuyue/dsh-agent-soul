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
 *   每个 Tab、样式、API、共享组件各归一个片段文件，能单独阅读、单独 node --check。
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

const fragments = ORDER.map((file) => readFileSync(join(clientDir, file), 'utf8'))
const bundle = HEADER + '\n' + fragments.join('\n\n') + FOOTER
writeFileSync(outFile, bundle, 'utf8')
console.log(`已拼接 ${outFile}（${ORDER.length} 个片段，${bundle.split('\n').length} 行）`)