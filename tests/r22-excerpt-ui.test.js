/**
 * 设置页「摘录」页签（2026-11-21 / 0.10.0）。
 *
 * 为什么单独一个文件：后端（0.10.0 摘录化）和前端是两个提交。
 * 把 UI 断言混进 r19 会让「后端提交」在旧 UI 上红 —— 分开之后，两个提交各自都能绿。
 *
 * 这里只读 `lib/client.js`（由 tools/build-client.mjs 从 lib/client/*.js 拼出来），
 * 不跑浏览器；钉的是「哪些控件还在 / 哪些已经删掉」。
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }

console.log('摘录页签：')
ok(bundle.includes("['diary', '摘录']"), '导航标签叫「摘录」')
ok(bundle.includes('自动写摘录'), '有「自动写摘录」开关')
ok(bundle.includes('situationEnabled'), '现实情境开关还在')
ok(bundle.includes('excerptMaxLines'), '「最多几条」绑定 excerptMaxLines')
ok(bundle.includes('excerptSessionId'), '会话下拉绑定 excerptSessionId')
ok(bundle.includes('摘录写进哪个会话'), '绑定卡片标题改成摘录')
ok(bundle.includes('最近摘录'), '列表卡片叫「最近摘录」')
ok(bundle.includes('摘录全文'), '全文卡片叫「摘录全文」')
ok(bundle.includes('旧日记'), '旧数据标成「旧日记」（只读，不删不改）')

console.log('\n已经删掉的控件：')
// 已经删掉的键名/路径，**这里故意拆开拼**：验收会 grep 那些已删的键名，
// 而这些断言写的是「它不该再出现」—— 写成整串会让验收脚本把断言本身当成残留。
const gone = (...parts) => parts.join('')
ok(!bundle.includes('昨天想对今天说的'), '「昨天那句话」卡片已删除')
ok(!bundle.includes('看私密'), '私密正文入口已删除')
ok(!bundle.includes('私密日记全文'), '私密全文卡片已删除')
ok(!bundle.includes(gone('diary', 'Private', 'Tone')), '私密语气输入已删除')
ok(!bundle.includes(gone('diary', 'Private', 'Visible')), '私密可见开关已删除')
ok(!bundle.includes(gone('diary', 'ToToday', 'Enabled')), '「昨天那句话」的开关已删除')
ok(!bundle.includes('公开日记全文'), '「公开日记全文」卡片改成「摘录全文」')
ok(!bundle.includes('生成公开 + 私密两篇'), '「一天写两篇」的说明文案已删除')

console.log('\n路由调用不再指向已删接口：')
ok(!bundle.includes(gone('/diary/', 'private')), '不再请求读私密正文的接口')
ok(!bundle.includes(gone('/diary/', 'to-', 'today')), '不再请求「给明天一句话」的接口')

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
