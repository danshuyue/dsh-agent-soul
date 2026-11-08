/**
 * preview.html 的插件 CSS 与 styles.js 生成物一致（2026-11-09 KNOWN-ISSUES #35）。
 *
 * docs/preview.html 里 `.soul-*` 那一段是**手工复制**的 styles.js 产物 ——
 * 没有任何机制拦住「改了 styles.js 忘了同步预览」，视觉对照会静默失真。
 * 这里把 styles.js 的 CSS 数组原样求值（new Function 只跑数组字面量，不碰 DOM），
 * 与 preview.html `<style>` 块里从 `.soul-app{` 起的插件段落逐字符比较。
 *
 * 想改样式：只改 lib/client/styles.js，然后把生成的 CSS 段复制进 preview.html
 * （preview 自己的 html/body/.pv-* 前置规则不参与比较）。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }

// 1. 求值 styles.js 里的 CSS 数组（只执行数组字面量，不加载整个片段）
const stylesSrc = readFileSync(join(root, 'lib', 'client', 'styles.js'), 'utf8')
const arr = stylesSrc.match(/var CSS = \[([\s\S]*?)\]\s*\.join\(/)
ok(arr !== null, 'styles.js 里找到了 CSS 数组')
let generated = ''
try {
  generated = new Function(`return [${arr[1]}].join('\\n')`)()
} catch (error) {
  ok(false, `CSS 数组求值失败：${error instanceof Error ? error.message : error}`)
}
ok(typeof generated === 'string' && generated.length > 500, `CSS 求值成功（${generated.length} 字符）`)

// 2. 从 preview.html 的 <style> 块里取出插件段落（.soul-app{ 起到 </style> 止）
const preview = readFileSync(join(root, 'docs', 'preview.html'), 'utf8')
const styleStart = preview.indexOf('<style>')
const styleEnd = preview.indexOf('</style>')
ok(styleStart >= 0 && styleEnd > styleStart, 'preview.html 有 <style> 块')
const soulAt = preview.indexOf('.soul-app{', styleStart)
ok(soulAt > styleStart, 'style 块里有插件 CSS 段（.soul-app{ 起始）')
// docs/preview.html 不在 .gitattributes 的 eol=lf 管辖内，Windows 检出是 CRLF；
// 行尾归一化后再比（比较的是内容，不是行尾）。
const copied = preview.slice(soulAt, styleEnd).replace(/\r\n/g, '\n').replace(/\s+$/, '')

// 3. 逐字符比较（两侧都去掉尾部空白）
const genTrim = generated.replace(/\s+$/, '')
ok(copied === genTrim, 'preview.html 的插件 CSS 与 styles.js 产物逐字符一致' +
  (copied === genTrim ? '' : `（不一致：第一处差异在第 ${firstDiff(copied, genTrim)} 字符附近）`))

function firstDiff(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) return i
  return n
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
