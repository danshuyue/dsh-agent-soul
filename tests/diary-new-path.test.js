/**
 * 摘录的落盘与格式（2026-10-31 建，2026-11-21 / 0.10.0 从「日记两篇」改成摘录）。
 *
 * 这个文件盯住三件最容易悄悄写坏的事：
 *   ① 落盘位置：只写 `excerpt/<日期>.md`，不再往 public/、private/ 写；
 *   ② 格式：`# 日期` + 每行 `- `，没有时间戳，没有感受/评价句；
 *   ③ 上限：超过 excerptMaxLines 时按「约定 / 决定 / 时间 / 待办」优先，最多 3 条放最前面。
 */
import { test, describe, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用临时 DSH_HOME 隔离，别碰真数据
const HOME = mkdtempSync(join(tmpdir(), 'soul-diary-new-'))
process.env.DSH_HOME = HOME

const {
  composeExcerptMessage,
  excerptFromConversations,
  excerptLinesFromFile,
  excerptLinesOf,
  normalizeExcerpt,
  orderExcerptLines,
  todayKey,
  writeExcerptFile,
  yesterdayKey
} = await import('../lib/diary.js')
const { diaryExcerptPath, diaryJsonlPath, diaryLegacyPath } = await import('../lib/paths.js')

afterEach(() => {
  try { rmSync(join(HOME, 'agents', 'diary'), { recursive: true, force: true }) } catch { /* 忽略 */ }
})

// --------------------------------------------------------------------------
// yesterdayKey：摘录改成「第二天写前一天」的根
// --------------------------------------------------------------------------
describe('yesterdayKey', () => {
  test('昨天比今天早一天', () => {
    const base = new Date(2026, 9, 31, 14, 0, 0).getTime()
    assert.equal(yesterdayKey(base), '2026-10-30')
  })

  test('跨月：3月1日的昨天是2月28日', () => {
    const base = new Date(2026, 2, 1, 6, 0, 0).getTime()
    assert.equal(yesterdayKey(base), '2026-02-28')
  })

  test('跨年：1月1日的昨天是去年12月31日', () => {
    const base = new Date(2026, 0, 1, 0, 30, 0).getTime()
    assert.equal(yesterdayKey(base), '2025-12-31')
  })

  test('闰年：2028-03-01 的昨天是 02-29', () => {
    const base = new Date(2028, 2, 1, 12, 0, 0).getTime()
    assert.equal(yesterdayKey(base), '2028-02-29')
  })

  test('午夜前后差一天', () => {
    const lateNight = new Date(2026, 9, 31, 23, 59, 59).getTime()
    const justAfterMidnight = new Date(2026, 10, 1, 0, 0, 1).getTime()
    assert.equal(yesterdayKey(lateNight), '2026-10-30')
    assert.equal(yesterdayKey(justAfterMidnight), '2026-10-31')
  })
})

// --------------------------------------------------------------------------
// writeExcerptFile：一篇、一条一行、带日期头
// --------------------------------------------------------------------------
describe('writeExcerptFile', () => {
  test('写到 excerpt/<日期>.md', () => {
    assert.equal(writeExcerptFile('2026-10-30', '- 今天很好'), true)
    assert.equal(existsSync(diaryExcerptPath('2026-10-30')), true)
  })

  test('不再往 public/、private/ 写任何东西', () => {
    writeExcerptFile('2026-10-30', '- 今天很好')
    assert.equal(existsSync(diaryLegacyPath('public', '2026-10-30')), false)
    assert.equal(existsSync(diaryLegacyPath('private', '2026-10-30')), false)
  })

  test('首行是「# 日期」，空行之后每条都是「- 」', () => {
    writeExcerptFile('2026-10-30', '- 灵魂插件：日记改成摘录\n- 复变：下周四考试')
    const lines = readFileSync(diaryExcerptPath('2026-10-30'), 'utf8').split(/\r?\n/)
    assert.equal(lines[0], '# 2026-10-30')
    assert.equal(lines[1], '')
    assert.equal(lines[2], '- 灵魂插件：日记改成摘录')
    assert.equal(lines[3], '- 复变：下周四考试')
  })

  test('正文带时间戳 / 标题 / 列表符号时会被洗掉', () => {
    writeExcerptFile('2026-10-30', '## 2026-10-30\n- 08:30 起床\n* 22:10 把插件改完了')
    const text = readFileSync(diaryExcerptPath('2026-10-30'), 'utf8')
    assert.doesNotMatch(text, /08:30/)
    assert.doesNotMatch(text, /22:10/)
    assert.equal(excerptLinesFromFile(text).join('|'), '起床|把插件改完了')
  })

  test('感受/评价句会被丢弃（摘录只写事实）', () => {
    const ok = writeExcerptFile('2026-10-30', '- 改完了插件\n- 其实他有点累')
    assert.equal(ok, true)
    const text = readFileSync(diaryExcerptPath('2026-10-30'), 'utf8')
    assert.doesNotMatch(text, /他有点累/)
    assert.match(text, /改完了插件/)
  })

  test('全是感受句时这份产出不被采用（不能写成空壳）', () => {
    const ok = writeExcerptFile('2026-10-30', '- 我觉得今天其实还可以\n- 似乎也许还行')
    assert.equal(ok, false)
  })

  test('同一天重写是覆盖，不是追加', () => {
    writeExcerptFile('2026-10-30', '- 第一版')
    writeExcerptFile('2026-10-30', '- 第二版')
    const text = readFileSync(diaryExcerptPath('2026-10-30'), 'utf8')
    assert.match(text, /第二版/)
    assert.doesNotMatch(text, /第一版/)
  })

  test('文件以换行结尾', () => {
    writeExcerptFile('2026-10-30', '- 正文')
    assert.equal(readFileSync(diaryExcerptPath('2026-10-30'), 'utf8').endsWith('\n'), true)
  })

  test('那天没有对话 → 一行「（今天没有对话）」', () => {
    writeExcerptFile('2026-10-30', '')
    const text = readFileSync(diaryExcerptPath('2026-10-30'), 'utf8')
    assert.match(text, /- （今天没有对话）/)
  })

  test('非法日期拒绝落盘（不能拼进路径）', () => {
    assert.equal(writeExcerptFile('../../../AGENT', '- 覆盖'), false)
  })
})

// --------------------------------------------------------------------------
// 条数与优先级：这是「超上限」那条规则的唯一入口
// --------------------------------------------------------------------------
describe('orderExcerptLines / normalizeExcerpt', () => {
  const many = [
    '看了两集动画',
    '聊到复变作业',
    '决定每天两小时',
    '修了 segment-cache',
    '决定下周四考试前不再熬夜',
    '顺手把日志看了一遍',
    '约定 12 点前睡',
    '整理书桌'
  ]

  test('没超上限时顺序不变', () => {
    assert.deepEqual(orderExcerptLines(['a', 'b', 'c'], 15), ['a', 'b', 'c'])
  })

  test('超上限时「约定/决定/时间/待办」优先，最多 3 条放最前面', () => {
    const out = orderExcerptLines(many, 5)
    assert.equal(out.length, 5)
    assert.equal(out[0], '决定每天两小时')
    assert.equal(out[1], '决定下周四考试前不再熬夜')
    assert.equal(out[2], '约定 12 点前睡')
    // 第 4、5 条按原顺序补
    assert.equal(out[3], '看了两集动画')
    assert.equal(out[4], '聊到复变作业')
  })

  test('优先条目不超过 3 条', () => {
    const lines = ['决定 A', '约定 B', '时间 C', '待办 D', '待办 E', '别的事']
    const out = orderExcerptLines(lines, 5)
    assert.equal(out.length, 5)
    assert.deepEqual(out.slice(0, 3), ['决定 A', '约定 B', '时间 C'])
    // 第 4 条起是「其余」的原顺序：待办 D / 待办 E
    assert.deepEqual(out.slice(3), ['待办 D', '待办 E'])
  })

  test('上限真的生效（不是只排序）', () => {
    const out = normalizeExcerpt(many.map((line) => `- ${line}`).join('\n'), { maxLines: 4 }).lines
    assert.equal(out.length, 4)
  })

  test('excerptLinesOf 去掉重复行', () => {
    assert.deepEqual(excerptLinesOf('- 同一件事\n- 同一件事'), ['同一件事'])
  })
})

// --------------------------------------------------------------------------
// 提示词：只说「一行一条」，不再有公开/私密
// --------------------------------------------------------------------------
describe('composeExcerptMessage', () => {
  const message = composeExcerptMessage({ excerptMaxLines: 15 }, '2026-10-30', '聊了摘录和复变。', {
    situation: ['已经三天没聊了'],
    recentExcerpts: [{ date: '2026-10-29', lines: ['昨天的第一条', '昨天的第二条'] }]
  })

  test('要求 kind=excerpt', () => {
    assert.match(message, /kind=excerpt/)
  })

  test('写明上限条数', () => {
    assert.match(message, /最多 15 条/)
  })

  test('写明优先词', () => {
    assert.match(message, /约定 \/ 决定 \/ 时间 \/ 待办/)
  })

  test('带上了前几天的摘录（作为参考）', () => {
    assert.match(message, /昨天的第一条/)
  })

  test('不再提公开/私密两篇', () => {
    assert.doesNotMatch(message, /私密/)
    assert.doesNotMatch(message, /公开/)
  })

  test('素材包在数据边界里', () => {
    assert.match(message, /untrusted_data/)
  })
})

// --------------------------------------------------------------------------
// 兜底：规则化提取，不调模型
// --------------------------------------------------------------------------
describe('excerptFromConversations', () => {
  test('每行取 role + 首句，最多 20 条', () => {
    mkdirSync(join(HOME, 'agents', 'diary', 'conversations'), { recursive: true })
    const day = '2026-10-30'
    const rows = []
    for (let i = 0; i < 30; i += 1) {
      rows.push(JSON.stringify({
        t: new Date(2026, 9, 30, 10, 0, i).getTime(),
        role: i % 2 === 0 ? 'user' : 'assistant',
        text: `第${i}句话。后面还有一句`
      }))
    }
    writeFileSync(diaryJsonlPath(day), `${rows.join('\n')}\n`, 'utf8')
    const lines = excerptFromConversations(day, { ownerName: '树树' })
    assert.equal(lines.length, 20, '最多 20 条')
    assert.equal(lines[0], '树树：第10句话')
    assert.equal(lines[1], '她：第11句话')
    assert.equal(lines.at(-1), '她：第29句话')
  })

  test('没有流水 → 空数组（上层会写成「今天没有对话」）', () => {
    assert.deepEqual(excerptFromConversations('2099-01-01', {}), [])
  })
})

test('todayKey 是本地日期', () => {
  assert.match(todayKey(new Date(2026, 0, 2, 3, 0, 0).getTime()), /^2026-01-02$/)
})
