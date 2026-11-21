/**
 * 摘录「完整性」判断（2026-11-01 加；2026-11-21 / 0.10.0 从两篇改成一篇）。
 *
 * 线上真事故：10-31 下午 14:20 手动触发写过那一篇，当时窗口（到 24:00）
 * 还没闭合，只写得到半天。第二天开机看到文件都在，就当成已完成跳过，
 * 结果下午到晚上整段（改压缩配置、推 GitHub、发 npm）全丢了。
 *
 * 判据是：摘录在 **且** 最后修改时间在窗口闭合之后（次日 00:00 之后）——
 * 或者写完之后这一天再没有新对话。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-diary-complete-'))
process.env.DSH_HOME = HOME

const { diaryIsCompleteFor } = await import('../lib/diary.js')
const { diaryExcerptPath, diaryJsonlPath, diaryLegacyPath, ensureDirs } = await import('../lib/paths.js')

const DAY = '2026-10-31'
/** 窗口结束 = 2026-11-01 00:00 本地时间 */
const DAY_END = new Date(2026, 10, 1, 0, 0, 0, 0)
/** 窗口内（当天下午） */
const INSIDE = new Date(2026, 9, 31, 14, 20, 0, 0)

function writeExcerpt(mtime) {
  ensureDirs()
  writeFileSync(diaryExcerptPath(DAY), `# ${DAY}\n\n- 写了一下午\n`, 'utf8')
  if (mtime !== undefined) utimesSync(diaryExcerptPath(DAY), mtime, mtime)
}

/** 造一条当天某个时刻的对话流水（用来判断"写完那一刻之后还有没有新内容"）。 */
function writeTalk(at) {
  ensureDirs()
  writeFileSync(diaryJsonlPath(DAY), `${JSON.stringify({ t: at, role: 'user', text: 'x', src: 'user' })}\n`, 'utf8')
}

beforeEach(() => ensureDirs())
afterEach(() => {
  try { rmSync(join(HOME, 'agents', 'diary'), { recursive: true, force: true }) } catch { /* 忽略 */ }
})

describe('diaryIsCompleteFor', () => {
  test('摘录在、且写于窗口闭合之后 → 完整', () => {
    writeExcerpt(DAY_END)
    assert.equal(diaryIsCompleteFor(DAY), true)
  })

  test('摘录在、但写在当天下午，且之后又聊到深夜 → 不完整', () => {
    writeTalk(new Date(2026, 9, 31, 23, 30, 0, 0).getTime())
    writeExcerpt(INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), false, '半天版本不能被当成写完')
  })

  test('写在下午，但那之后这一天再没聊过 → 完整（别白重写一遍）', () => {
    writeTalk(new Date(2026, 9, 31, 13, 0, 0, 0).getTime())
    writeExcerpt(INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), true, '内容已经写全了，重写只会换个说法')
  })

  test('写在下午、那天一条对话记录都没有 → 不完整（拿不到流水就站严格那边）', () => {
    writeExcerpt(INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), false, '判不准时宁可当没写完 —— 漏写是丢内容，白写只是多花一次调用')
  })

  test('没有摘录、也没有旧日记 → 不完整', () => {
    assert.equal(diaryIsCompleteFor(DAY), false)
  })

  test('只有旧日记（public/ + private/）→ **完整**（2026-11-21 / 0.10.4 改）', () => {
    // 0.10.0 一开始定的是「旧数据不算今天写过」，本意是升级后给昨天补一篇摘录。
    // 实际后果：findMissingDay 从今天往回扫，历史每一天都「没写过摘录」，
    // 于是每次重启都补一天，用户看到「重启又写了一篇之前的摘要」。
    // 现在有旧日记就算写过，不再补。
    ensureDirs()
    mkdirSync(join(HOME, 'agents', 'diary', 'public'), { recursive: true })
    mkdirSync(join(HOME, 'agents', 'diary', 'private'), { recursive: true })
    writeFileSync(diaryLegacyPath('public', DAY), '【公开】\n2026-10-31\n\n正文\n', 'utf8')
    writeFileSync(diaryLegacyPath('private', DAY), '【私密】\n2026-10-31\n\n正文\n', 'utf8')
    assert.equal(diaryIsCompleteFor(DAY), true, '旧日记也算写过：不再把历史一天补成摘录')
  })

  test('非法日期 → 不完整（不抛错）', () => {
    assert.equal(diaryIsCompleteFor('not-a-date'), false)
    assert.equal(diaryIsCompleteFor(''), false)
  })
})
