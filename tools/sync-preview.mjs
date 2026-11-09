#!/usr/bin/env node
/**
 * 把 lib/client/styles.js 的 CSS 同步进 docs/preview.html（2026-11-09）。
 *
 * 为什么需要它：preview.html 里 `.soul-*` 那一段是**手工复制**的样式产物。
 * R15 加了 `tests/preview-css.test.js` 拦住「改了样式忘了同步」——但拦下来之后，
 * 同步这件事仍然是手工的。这个脚本让它是**一条命令**。
 *
 * 用法：node tools/sync-preview.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

// 1. 求值 CSS 数组（只跑数组字面量，不加载整个片段、不碰 DOM）
const stylesSrc = readFileSync(join(root, 'lib', 'client', 'styles.js'), 'utf8')
const arr = stylesSrc.match(/var CSS = \[([\s\S]*?)\]\s*\.join\(/)
if (arr === null) {
  console.error('styles.js 里没找到 CSS 数组（正则失配，样式结构可能变了）')
  process.exit(1)
}
// 注意：必须用普通字符串拼 "].join('\\n')" —— 写进模板字符串的话 \n 会变成真换行，
// 生成的代码就断了（我自己先踩了一次）。
const generated = new Function(`return [${arr[1]}].join('\\n')`)()

// 2. 替换 preview.html 里的插件段（从 .soul-app{ 到 </style> 之前）
const previewPath = join(root, 'docs', 'preview.html')
const preview = readFileSync(previewPath, 'utf8')
const styleStart = preview.indexOf('<style>')
const styleEnd = preview.indexOf('</style>')
if (styleStart < 0 || styleEnd <= styleStart) {
  console.error('preview.html 里没找到 <style> 块')
  process.exit(1)
}
const soulAt = preview.indexOf('.soul-app{', styleStart)
if (soulAt <= styleStart) {
  console.error('preview.html 的 style 块里没有插件段（.soul-app{ 起始）')
  process.exit(1)
}

// 行尾跟随原文件：Windows 检出是 CRLF，别把整份文件改成 LF
const eol = preview.includes('\r\n') ? '\r\n' : '\n'
const body = generated.split('\n').join(eol)
const next = preview.slice(0, soulAt) + body + preview.slice(styleEnd)

if (next === preview) {
  console.log('preview.html 已经是最新的（无需改动）')
  process.exit(0)
}
writeFileSync(previewPath, next, 'utf8')
console.log(`preview.html 已同步（插件 CSS 段 ${generated.length} 字符）`)
