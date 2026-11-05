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

const { readRecentChat, readRecentDiaries, todayKey, digestDiaries, compressFeedText } = await import('../lib/diary.js')
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
    // 2026-11-04：主人怎么标跟着配置走（第三个参数），不再是写死的「树树」
    const out = readRecentChat(TODAY, 1000, '树树')
    assert.match(out, /树树：早上好/)
    assert.match(out, /我：早喵/)
    assert.equal(out.indexOf('早上好') < out.indexOf('早喵'), true, '顺序应该是先树树后我')
  })

  test('没设主人名字时用中性的「对方」', () => {
    writeJsonl(TODAY, [
      { t: Date.now() - 1000, role: 'user', text: '在吗', src: 'user' },
      { t: Date.now(), role: 'assistant', text: '在的', src: '' }
    ])
    const out = readRecentChat(TODAY, 1000)
    assert.match(out, /对方：在吗/)
    assert.doesNotMatch(out, /树树/)
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

  // 2026-11-05：JSONL 是多个会话各自异步追加的，落盘顺序 ≠ 事件顺序。
  // 实测注入里出现过「19:05 排在 19:33 后面」，因果关系是反的。
  test('落盘顺序乱了也要按事件时间输出', () => {
    const base = Date.now() - 60_000
    writeJsonl(TODAY, [
      { t: base + 2000, role: 'user', text: '第二句', src: 'user' },
      { t: base, role: 'user', text: '第一句', src: 'user' },
      { t: base + 4000, role: 'assistant', text: '第三句', src: '' }
    ])
    const out = readRecentChat(TODAY, 2000, '树树')
    assert.equal(out.indexOf('第一句') < out.indexOf('第二句'), true)
    assert.equal(out.indexOf('第二句') < out.indexOf('第三句'), true)
  })
})

describe('compressFeedText（长回复折叠）', () => {
  test('带表格的长回复折成一行，不留半张表', () => {
    const table = `## 必做（3 件）\n\n| # | 在哪 | 要做什么 |\n|---|---|---|\n| 1 | store.js | 改缓存 |\n| 2 | memory.js | 改分区 |\n`.repeat(4)
    const out = compressFeedText(table, 'assistant')
    assert.equal(out.includes('\n'), false, '折叠结果必须是一行')
    assert.match(out, /带表格\/代码/)
    assert.match(out, new RegExp(`约 ${table.trim().length} 字`))
  })

  test('短回复原样返回', () => {
    assert.equal(compressFeedText('好，我改完了。', 'assistant'), '好，我改完了。')
  })

  test('长纯文字仍然截断，但留省略记号', () => {
    const out = compressFeedText('这句话要说很久。'.repeat(80), 'assistant')
    assert.equal(out.length < 700, true)
    assert.match(out, /省略 \d+ 字/)
  })
})

describe('digestDiaries（日记注入改摘要）', () => {
  const entry = (date, body) => `【公开】\n${date}\n\n${body}\n`

  test('每篇只留第一段，带日期和全文字数', () => {
    const a = entry('2026-11-03', '今天最放不下的是复制件那段。\n\n第二段细节很多，不该进注入。')
    const b = entry('2026-11-04', '今天最放不下的是树树往回退的那几步。\n\n第二段。')
    const out = digestDiaries(`${a}\n\n---\n\n${b}`, 100)
    const lines = out.split('\n')
    assert.equal(lines.length, 2)
    assert.match(lines[0], /^- 2026-11-03：今天最放不下的是复制件那段。/)
    assert.doesNotMatch(out, /第二段/)
    assert.match(out, /全文 \d+ 字/)
  })

  test('比原来整篇短一个量级', () => {
    const long = `${'很长的正文。'.repeat(400)}\n\n第二段`
    const out = digestDiaries(entry('2026-11-04', long), 120)
    assert.equal(out.length < 200, true, `摘要应该很短，实际 ${out.length}`)
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
