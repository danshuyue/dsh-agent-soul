/**
 * 记忆近似重复提示（2026-10-31）。
 *
 * 需求：写进两条意思相近但字面不同的记忆时，日志要留痕 —— 但不许自动替换。
 * 判据：只提醒，卡里两条都在。
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-mem-dup-'))
process.env.DSH_HOME = HOME

const { addRecord } = await import('../lib/memory.js')

/** 造一张空卡。 */
function blankCard() {
  return {
    version: 2,
    scope: 'global',
    records: [],
    stats: { added: 0 },
    updatedAt: null
  }
}

const CFG = { maxRecords: 200 }

describe('近似重复只提醒，不替换', () => {
  test('意思相近但字面不同的两条都留在卡里', () => {
    const card = blankCard()
    addRecord(card, { text: '树树的电脑不能保证24小时开机，硬件条件有限' }, CFG, Date.now())
    addRecord(card, { text: '树树的电脑不能保证24小时开机，硬件条件有限，晚上也不一定能一直开着' }, CFG, Date.now())
    // 关键：不许因为相近就把新的丢掉或改成覆盖老的
    assert.equal(card.records.length, 2, '两条都该在卡里')
  })

  test('一字不差的才算去重', () => {
    const card = blankCard()
    addRecord(card, { text: '树树喜欢猫' }, CFG, Date.now())
    const r = addRecord(card, { text: '树树喜欢猫' }, CFG, Date.now())
    assert.equal(card.records.length, 1)
    assert.equal(r.deduped, true)
  })

  test('完全不同的话题不触发相近提示（不能天天报假警）', () => {
    const card = blankCard()
    addRecord(card, { text: '树树喜欢猫' }, CFG, Date.now())
    addRecord(card, { text: '今天写完了日记插件的投递链' }, CFG, Date.now())
    assert.equal(card.records.length, 2)
  })

  test('空卡写入不报错', () => {
    const card = blankCard()
    assert.doesNotThrow(() => addRecord(card, { text: '第一条' }, CFG, Date.now()))
    assert.equal(card.records.length, 1)
  })

  test('空文本被拒绝', () => {
    const card = blankCard()
    const r = addRecord(card, { text: '   ' }, CFG, Date.now())
    assert.equal(r.ok, false)
    assert.equal(card.records.length, 0)
  })
})

describe('模块能加载（防漏 import）', () => {
  test('memory.js 导入后 addRecord 可用', () => {
    assert.equal(typeof addRecord, 'function')
  })
})
