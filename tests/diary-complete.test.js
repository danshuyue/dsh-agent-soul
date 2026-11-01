/**
 * 日记「完整性」判断（2026-11-01）。
 *
 * 线上真事故：10-31 下午 14:20 手动触发写过那一篇，当时窗口（到 24:00）
 * 还没闭合，只写得到半天。第二天开机看到两个文件都在，就当成已完成跳过，
 * 结果下午到晚上整段（改压缩配置、推 GitHub、发 npm）全丢了。
 *
 * 判据应该是：两篇都在 **且** 最后修改时间在窗口闭合之后（次日 00:00 之后）。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-diary-complete-'))
process.env.DSH_HOME = HOME

const { diaryIsCompleteFor } = await import('../lib/diary.js')
const { diaryPublicPath, diaryPrivatePath, diaryJsonlPath, ensureDirs } = await import('../lib/paths.js')

const DAY = '2026-10-31'
/** 窗口结束 = 2026-11-01 00:00 本地时间 */
const DAY_END = new Date(2026, 10, 1, 0, 0, 0, 0)
/** 窗口内（当天下午） */
const INSIDE = new Date(2026, 9, 31, 14, 20, 0, 0)

function writeBoth(pubTime, privTime) {
  ensureDirs()
  writeFileSync(diaryPublicPath(DAY), '【公开】\n2026-10-31\n\n正文\n', 'utf8')
  writeFileSync(diaryPrivatePath(DAY), '【私密】\n2026-10-31\n\n正文\n', 'utf8')
  if (pubTime !== undefined) utimesSync(diaryPublicPath(DAY), pubTime, pubTime)
  if (privTime !== undefined) utimesSync(diaryPrivatePath(DAY), privTime, privTime)
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
  test('两篇都在、且都写于窗口闭合之后 → 完整', () => {
    writeBoth(DAY_END, DAY_END)
    assert.equal(diaryIsCompleteFor(DAY), true)
  })

  test('两篇都在、但写在当天下午，且之后又聊到深夜 → 不完整', () => {
    writeTalk(new Date(2026, 9, 31, 23, 30, 0, 0).getTime())
    writeBoth(INSIDE, INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), false, '半天版本不能被当成写完')
  })

  test('写在下午，但那之后这一天再没聊过 → 完整（别白重写一遍）', () => {
    writeTalk(new Date(2026, 9, 31, 13, 0, 0, 0).getTime())
    writeBoth(INSIDE, INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), true, '内容已经写全了，重写只会换个说法')
  })

  test('写在下午、那天一条对话记录都没有 → 不完整（拿不到流水就站严格那边）', () => {
    writeBoth(INSIDE, INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), false, '判不准时宁可当没写完 —— 漏写是丢内容，白写只是多花一次调用')
  })

  test('公开写在窗口后、私密写在窗口内 → 不完整', () => {
    writeBoth(DAY_END, INSIDE)
    assert.equal(diaryIsCompleteFor(DAY), false)
  })

  test('缺私密那篇 → 不完整', () => {
    ensureDirs()
    writeFileSync(diaryPublicPath(DAY), '【公开】\n', 'utf8')
    assert.equal(diaryIsCompleteFor(DAY), false)
  })

  test('两篇都不在 → 不完整', () => {
    assert.equal(diaryIsCompleteFor(DAY), false)
  })

  test('非法日期 → 不完整（不抛错）', () => {
    assert.equal(diaryIsCompleteFor('not-a-date'), false)
    assert.equal(diaryIsCompleteFor(''), false)
  })
})
