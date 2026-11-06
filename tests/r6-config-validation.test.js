/**
 * R6 回归：`/config` 的值必须有类型与范围校验（2026-11-06）。
 *
 * 修之前只过滤键名，值原样写进去；一个对象 / NaN / 负数能让归一化吞掉键，
 * 表现是「设置页提示保存成功、功能其实失效」。
 *
 * 特别锁一条：`diarySessionBornAt` 是毫秒时间戳（≈1.79e12），
 * 任何「拍脑袋的数值上限」都会让绑过日记会话的人永远存不了设置。
 */
import { validateConfigEntry } from '../lib/api.js'
import { DEFAULT_CONFIG } from '../lib/store.js'

let passed = 0
let failed = 0
function ok(cond, name) {
  if (cond) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}`) }
}

console.log('未知键：')
{
  ok(validateConfigEntry('notARealKey', 1).ok === false, '未知键被拒')
}

console.log('布尔：')
{
  ok(validateConfigEntry('memoryEnabled', true).value === true, '接受 true')
  ok(validateConfigEntry('memoryEnabled', 'false').value === false, '接受 "false"')
  ok(validateConfigEntry('memoryEnabled', '1').value === true, '接受 "1"')
  ok(validateConfigEntry('memoryEnabled', 'yes').ok === false, '拒绝 "yes"')
  ok(validateConfigEntry('memoryEnabled', 1).ok === false, '拒绝数字 1')
}

console.log('数字：')
{
  ok(validateConfigEntry('injectMaxChars', 3200).ok === true, '接受正常数字')
  ok(validateConfigEntry('moodBase', -1).ok === false, '拒绝负数')
  ok(validateConfigEntry('moodBase', Number.NaN).ok === false, '拒绝 NaN')
  ok(validateConfigEntry('moodBase', Number.POSITIVE_INFINITY).ok === false, '拒绝 Infinity')
  ok(validateConfigEntry('moodBase', '70').ok === false, '拒绝字符串数字（类型要严格）')
  // 这条是 round1 那个严重缺陷的防盗门
  const now = Date.now()
  const born = validateConfigEntry('diarySessionBornAt', now)
  ok(born.ok === true && born.value === now, `接受毫秒时间戳 ${now}（不能有 1e9 之类上限）`)
}

console.log('字符串：')
{
  ok(validateConfigEntry('ownerName', '树树').ok === true, '接受中文名字')
  ok(validateConfigEntry('ownerName', 'x'.repeat(5000)).ok === false, '拒绝超长字符串')
  ok(validateConfigEntry('ownerName', 'a\u0000b').ok === false, '拒绝 NUL')
  ok(validateConfigEntry('diaryPublicTone', '一行\n两行').ok === true, '允许换行（语气文本可能多行）')
  ok(validateConfigEntry('ownerName', 123).ok === false, '拒绝数字传给字符串键')
}

console.log('数组（localNames）：')
{
  ok(validateConfigEntry('localNames', ['AGENT.md']).ok === true, '接受纯文件名')
  ok(validateConfigEntry('localNames', ['../vault.txt']).ok === false, '拒绝 .. 路径穿越')
  ok(validateConfigEntry('localNames', ['sub/AGENT.md']).ok === false, '拒绝带分隔符')
  ok(validateConfigEntry('localNames', ['C:\\x.md']).ok === false, '拒绝绝对路径')
  ok(validateConfigEntry('localNames', ['ok.md', 1]).ok === false, '拒绝非字符串元素')
  ok(validateConfigEntry('localNames', 'AGENT.md').ok === false, '拒绝非数组')
}

console.log('对象：')
{
  ok(validateConfigEntry('injectMaxChars', { a: 1 }).ok === false, '拒绝对象')
  ok(validateConfigEntry('memoryEnabled', []).ok === false, '拒绝数组传给布尔键')
}

console.log('默认值类型覆盖面：')
{
  const kinds = new Set(Object.values(DEFAULT_CONFIG).map((v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v)))
  ok(kinds.has('boolean') && kinds.has('number') && kinds.has('string') && kinds.has('array'), `覆盖到 ${[...kinds].join('/')} 四种类型`)
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
