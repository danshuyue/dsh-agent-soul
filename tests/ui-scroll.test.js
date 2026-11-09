/**
 * 长列表自己滚（2026-11-09 / 设置页布局）
 *
 * 现象：日记 / 记忆 / 笔记 / 惦记的事条目一多，整页被撑得很长，要划很久才能看到下面的卡片。
 * 做法：给这四处列表一个**有界高度 + 内部滚动**（跟心情页时间线 `.soul-tl` 同一个套路）。
 *
 * 这里断言两件事：
 *   ① 样式里有这条规则（高度有界、能滚、不让滚动传给外层）；
 *   ② 四个片段真的挂上了这个 class —— 只加样式不挂 class 是最常见的「改了等于没改」。
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(root, p), 'utf8')

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }

console.log('样式：.soul-list-fixed 有界可滚')
{
  const styles = read('lib/client/styles.js')
  ok(styles.includes('.soul-list-fixed{'), '样式表里有这条规则')
  ok(/\.soul-list-fixed\{[^}]*max-height:min\(46vh,420px\)/.test(styles), '高度有界（46vh / 420px）')
  ok(/\.soul-list-fixed\{[^}]*overflow:auto/.test(styles), '内部可滚')
  ok(/\.soul-list-fixed\{[^}]*overscroll-behavior:contain/.test(styles), '滚到底不把滚动传给外层')
}

console.log('四处长列表都挂上了')
{
  const tabs = [
    ['lib/client/diary-tab.js', '日记 · 最近日记'],
    ['lib/client/memory-tab.js', '记忆 · 记录列表'],
    ['lib/client/notes-tab.js', '笔记 · 列表'],
    ['lib/client/purpose-tab.js', '目的 · 惦记的事']
  ]
  for (const [file, label] of tabs) {
    ok(read(file).includes('soul-list soul-list-fixed'), `${label} 用了有界滚动`)
  }
}

console.log('客户端产物里确实带上了')
{
  const bundle = read('lib/client.js')
  const hits = (bundle.match(/soul-list-fixed/g) ?? []).length
  ok(hits >= 5, `产物里出现 ${hits} 次（1 条样式 + 4 处列表）`)
  ok(bundle.includes('overscroll-behavior:contain'), '产物里有 overscroll-behavior')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
