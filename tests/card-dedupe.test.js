/**
 * 整卡渲染的去重（2026-11-05，A）。
 *
 * 背景：整卡路径把「项目卡 + 全局卡」各渲染一次再拼起来，而两张卡里躺着大量同一句话
 * （写回时的双写）。结果一屏里同一句出现两遍，白占一半预算。
 *
 * 做法：renderCard 接一个调用方传进来的 seen Set —— 谁先渲染谁留下，后面撞上的跳过。
 * 这里钉住三件事：
 *   ① 同一张卡内部的重复也要去（不只是跨卡）
 *   ② 预算裁剪 pop 掉的行不能记进 seen（它没进上下文，第二张卡还得能显示它）
 *   ③ 不传 seen 时行为不变（老调用方零影响）
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

const { renderCard } = await import('../lib/memory.js')

/** 造一条最小可用的记忆记录（够 sectionize / recordLine 用）。 */
function rec(text, extra = {}) {
  return {
    id: `id-${text.slice(0, 8)}`,
    text,
    title: text.slice(0, 20),
    kind: 'fact',
    clarity: 'vivid',
    importance: 70,
    tags: ['owner'],
    pinned: false,
    isInitial: false,
    recallCount: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastSeenAt: '2026-11-01T00:00:00.000Z',
    ...extra
  }
}

const card = (records) => ({ records })

/** 某段文字在输出里出现了几次。 */
const countOf = (out, text) => out.split(text).length - 1

describe('renderCard 去重', () => {
  test('同一张卡内部重复的条目只出现一次', () => {
    const out = renderCard(card([rec('同一句记忆'), rec('同一句记忆')]), { maxChars: 2000 })
    assert.equal(countOf(out, '同一句记忆'), 1)
  })

  test('跨卡共用 seen：第二张卡撞上的条目跳过', () => {
    const seen = new Set()
    const first = renderCard(card([rec('跨卡这句'), rec('全局独有')]), { maxChars: 2000, seen })
    const second = renderCard(card([rec('跨卡这句'), rec('项目独有')]), {
      maxChars: 2000,
      seen,
      omitHeader: true,
      titleSuffix: '（这个工作区）'
    })
    assert.equal(countOf(first, '跨卡这句'), 1)
    assert.equal(countOf(second, '跨卡这句'), 0, '第二张卡不该再出现一遍')
    assert.equal(countOf(second, '项目独有'), 1, '它自己的条目要留下来')
  })

  test('被预算裁掉的行不进 seen（第二张卡还看得见）', () => {
    const seen = new Set()
    // 6 条普通条目 + 1 条固定区，预算 200 字：普通条目会被逐条 pop 掉
    const records = []
    for (let i = 0; i < 6; i += 1) records.push(rec(`普通条目第 ${i} 条，用来把预算撑爆，长度故意写长一点`))
    records.push(rec('固定区这条不参与裁剪', { pinned: true }))
    const out = renderCard(card(records), { maxChars: 200, seen })

    assert.match(out, /不参与裁剪/, '固定区必须留下')
    assert.equal([...seen].includes('固定区这条不参与裁剪'), true, '留下来的要记进 seen')

    const droppedText = `普通条目第 5 条，用来把预算撑爆，长度故意写长一点`
    assert.equal(out.includes(droppedText), false, '这条应该被裁掉了')
    assert.equal(seen.has(droppedText), false, '被裁掉的不能记成用过')

    const next = renderCard(card([rec(droppedText)]), { maxChars: 2000, seen, omitHeader: true })
    assert.equal(next.includes(droppedText), true, '第二张卡应该还能显示它')
  })

  test('不传 seen 时行为不变（老调用方零影响）', () => {
    const a = renderCard(card([rec('老调用这句')]), { maxChars: 2000 })
    const b = renderCard(card([rec('老调用这句')]), { maxChars: 2000 })
    assert.equal(countOf(a, '老调用这句'), 1)
    assert.equal(countOf(b, '老调用这句'), 1, '两次独立渲染各出一份，跟改动前一致')
  })
})
