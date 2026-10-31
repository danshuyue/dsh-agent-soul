/**
 * 「最近」注入的数据源（2026-10-31）。
 *
 * 需求：树树会在多个对话里做不同的事（修插件 / QQ / 闲聊）。
 * 新开一个对话时，她应该知道昨天怎么过的、今天早些时候做过什么。
 *
 * 这里只测两个数据源函数；拼装逻辑在 index.js 的 renderRecentSection 里。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'soul-recent-'))
process.env.DSH_HOME = HOME

const { readRecentChat, readRecentDiaries, todayKey } = await import('../lib/diary.js')
const { diaryJsonlPath, diaryPublicPath, diaryPrivatePath, ensureDirs } = await import('../lib/paths.js')

const TODAY = todayKey(Date.now())

function writeJsonl(dateKey, entries) {
  ensureDirs()
  writeFileSync(diaryJsonlPath(dateKey), entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
}

beforeEach(() => ensureDirs())
afterEach(() => {
  try { rmSync(join(HOME, 'agents', 'diary'), { recursive: true, force: true }) } catch { /* 忽略 */ }
})

describe('readRecentChat（今天到目前为止的流水）', () => {
  test('文件不存在返回空串', () => {
    assert.equal(readRecentChat('2099-01-01', 1000), '')
  })

  test('按时间正序输出，且带时间和角色', () => {
    const t0 = Date.now() - 60_000
    writeJsonl(TODAY, [
      { t: t0, role: 'user', text: '早上好', src: 'user' },
      { t: t0 + 1000, role: 'assistant', text: '早喵', src: '' }
    ])
    const out = readRecentChat(TODAY, 1000)
    assert.match(out, /树树：早上好/)
    assert.match(out, /我：早喵/)
    assert.equal(out.indexOf('早上好') < out.indexOf('早喵'), true, '顺序应该是先树树后我')
  })

  test('超过 maxChars 只保留最近的部分', () => {
    const now = Date.now()
    const entries = []
    for (let i = 0; i < 50; i += 1) {
      entries.push({ t: now - (50 - i) * 1000, role: 'user', text: `第${i}条消息内容填充填充`, src: 'user' })
    }
    writeJsonl(TODAY, entries)
    const out = readRecentChat(TODAY, 200)
    assert.equal(out.length <= 400, true, `应该被限制长度，实际 ${out.length}`)
    assert.match(out, /第49条/, '最近的应该保留')
    assert.doesNotMatch(out, /第0条/, '最早的应该被丢掉')
  })

  test('单条超长也至少保留一条（不能返回空）', () => {
    writeJsonl(TODAY, [{ t: Date.now(), role: 'user', text: 'x'.repeat(5000), src: 'user' }])
    const out = readRecentChat(TODAY, 100)
    assert.equal(out.length > 0, true)
  })

  test('坏行跳过，不影响其他行', () => {
    ensureDirs()
    const raw = `${JSON.stringify({ t: Date.now(), role: 'user', text: '好的这条', src: 'user' })}\n{坏行\n`
    writeFileSync(diaryJsonlPath(TODAY), raw, 'utf8')
    const out = readRecentChat(TODAY, 1000)
    assert.match(out, /好的这条/)
  })
})

describe('readRecentDiaries（前几天的日记）', () => {
  test('公开与全部分开返回', () => {
    ensureDirs()
    const y1 = todayKey(Date.now() - 24 * 60 * 60 * 1000)
    writeFileSync(diaryPublicPath(y1), '【公开】\n公开内容\n', 'utf8')
    writeFileSync(diaryPrivatePath(y1), '【私密】\n私密内容\n', 'utf8')
    const r = readRecentDiaries(TODAY, 3)
    assert.match(r.public, /公开内容/)
    assert.doesNotMatch(r.public, /私密内容/, 'public 不该含私密')
    assert.match(r.all, /私密内容/)
  })

  test('没有日记时返回空串', () => {
    const r = readRecentDiaries('2099-01-01', 3)
    assert.equal(r.public, '')
    assert.equal(r.all, '')
  })
})
