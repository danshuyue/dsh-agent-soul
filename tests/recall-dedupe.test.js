/**
 * 「想起来了」去重（2026-10-31）。
 *
 * 线上症状：同一个 `## 想起来了` 块里，同一句话打印两遍。
 * 根因：writeAutoMemories 把长期事实跨工作区双写（项目卡一份 + 全局卡一份），
 *      renderRecallOnly 合并后没查「本批已输出」，只查了 exclude（上一轮的）。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-recall-dupe-'))
process.env.DSH_HOME = HOME

const { renderRecallOnly } = await import('../lib/memory.js')

function card(scope, records) {
  return { version: 2, scope, records, stats: { added: 0 }, updatedAt: null }
}

function rec(text, extra = {}) {
  return {
    id: text.slice(0, 8),
    text,
    title: text.slice(0, 24),
    importance: 80,
    kind: 'fact',
    clarity: 'vivid',
    tags: [],
    createdAt: '2026-10-31T00:00:00.000Z',
    lastSeenAt: '2026-10-31T00:00:00.000Z',
    recallCount: 0,
    pinned: true,
    source: 'auto',
    ...extra
  }
}

describe('想起来了 · 去重', () => {
  test('同一句话在项目卡和全局卡各一份，只输出一次', () => {
    const text = '树树让日记由我来写，我可以按自己的想法来写'
    const cards = [card('project', [rec(text)]), card('global', [rec(text)])]
    const out = renderRecallOnly(cards, { query: '日记 写法 想法', topK: 5, minHits: 1 })
    const occurrences = out.text.split(text).length - 1
    assert.equal(occurrences, 1, '同一句话不该出现两次')
  })

  test('三条不同记忆都还在（去重不能误伤）', () => {
    const cards = [
      card('global', [
        rec('树树让日记由我来写，我可以按自己的想法来写'),
        rec('树树的电脑不能保证24小时开机，硬件条件有限'),
        rec('树树比较追求完美')
      ])
    ]
    const out = renderRecallOnly(cards, { query: '树树 日记 电脑 完美', topK: 5, minHits: 1 })
    assert.match(out.text, /日记/)
    assert.match(out.text, /电脑/)
  })

  test('exclude 里的仍然不输出', () => {
    const text = '树树让日记由我来写，我可以按自己的想法来写'
    const cards = [card('global', [rec(text)])]
    const out = renderRecallOnly(cards, {
      query: '日记 写法 想法',
      exclude: new Set([text]),
      minHits: 1
    })
    assert.equal(out.text, '')
  })

  test('keys 不含重复项', () => {
    const text = '树树让日记由我来写，我可以按自己的想法来写'
    const cards = [card('project', [rec(text)]), card('global', [rec(text)])]
    const out = renderRecallOnly(cards, { query: '日记 写法 想法', topK: 5, minHits: 1 })
    assert.equal(new Set(out.keys).size, out.keys.length, 'keys 不该有重复')
  })

  test('空查询返回空', () => {
    const out = renderRecallOnly([card('global', [rec('随便一句话')])], { query: '' })
    assert.equal(out.text, '')
  })
})
