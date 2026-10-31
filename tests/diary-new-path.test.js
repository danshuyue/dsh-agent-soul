/**
 * 新日记主流程的测试（2026-10-31）。
 *
 * 为什么单独开一个文件：
 *   diary.test.js 里的 90 条测的全是「投消息给 agent」那套旧链路 ——
 *   那套已经不走主流程了，但函数还在，所以测试还是绿的。
 *   而今天真正在跑的 composeDiaryText / writeDiaryFile / yesterdayKey
 *   一条测试都没有：写坏了，全绿也看不出来。
 *
 *   这个文件专门盯住「写完就在那儿」这条新主路径。
 */
import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 用临时 DSH_HOME 隔离，别碰真日记
const HOME = mkdtempSync(join(tmpdir(), 'soul-diary-new-'))
process.env.DSH_HOME = HOME

const {
  yesterdayKey,
  writeDiaryFile,
  composeDiaryText
} = await import('../lib/diary.js')
const { diaryPublicPath, diaryPrivatePath } = await import('../lib/paths.js')

afterEach(() => {
  try { rmSync(join(HOME, 'agents', 'diary'), { recursive: true, force: true }) } catch { /* 忽略 */ }
})

// --------------------------------------------------------------------------
// yesterdayKey：日记改成「第二天写前一天」的根
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
// writeDiaryFile：写完就在那儿
// --------------------------------------------------------------------------
describe('writeDiaryFile', () => {
  test('公开篇写到 public/<日期>.md', () => {
    const ok = writeDiaryFile('public', '2026-10-30', '今天很好。')
    assert.equal(ok, true)
    assert.equal(existsSync(diaryPublicPath('2026-10-30')), true)
  })

  test('私密篇写到 private/<日期>.md', () => {
    writeDiaryFile('private', '2026-10-30', '有点累。')
    assert.equal(existsSync(diaryPrivatePath('2026-10-30')), true)
  })

  test('首行自动补【公开】，次行补日期', () => {
    writeDiaryFile('public', '2026-10-30', '正文内容')
    const text = readFileSync(diaryPublicPath('2026-10-30'), 'utf8')
    const lines = text.split(/\r?\n/)
    assert.equal(lines[0], '【公开】')
    assert.equal(lines[1], '2026-10-30')
    assert.match(text, /正文内容/)
  })

  test('私密篇首行是【私密】', () => {
    writeDiaryFile('private', '2026-10-30', '正文')
    const lines = readFileSync(diaryPrivatePath('2026-10-30'), 'utf8').split(/\r?\n/)
    assert.equal(lines[0], '【私密】')
  })

  test('已经有首行标记时不重复加', () => {
    writeDiaryFile('public', '2026-10-30', '【公开】\n2026-10-30\n\n正文')
    const text = readFileSync(diaryPublicPath('2026-10-30'), 'utf8')
    assert.equal((text.match(/【公开】/g) ?? []).length, 1)
  })

  test('同一天重写是覆盖，不是追加', () => {
    writeDiaryFile('public', '2026-10-30', '第一版')
    writeDiaryFile('public', '2026-10-30', '第二版')
    const text = readFileSync(diaryPublicPath('2026-10-30'), 'utf8')
    assert.match(text, /第二版/)
    assert.doesNotMatch(text, /第一版/)
  })

  test('文件以换行结尾', () => {
    writeDiaryFile('public', '2026-10-30', '正文')
    const text = readFileSync(diaryPublicPath('2026-10-30'), 'utf8')
    assert.equal(text.endsWith('\n'), true)
  })
})

// --------------------------------------------------------------------------
// composeDiaryText：失败必须报错，不能假装成功
// --------------------------------------------------------------------------
describe('composeDiaryText', () => {
  const baseCtx = { dateStr: '2026-10-30', summary: '聊了日记。', recentDiaries: {}, moodText: '' }

  test('没有 llm 服务时返回 null', async () => {
    const out = await composeDiaryText(undefined, {}, undefined, 'public', baseCtx)
    assert.equal(out, null)
  })

  test('llm 没有 stream 方法时返回 null', async () => {
    const out = await composeDiaryText({}, {}, undefined, 'public', baseCtx)
    assert.equal(out, null)
  })

  test('取不到模型路由时返回 null', async () => {
    const llm = { async *stream() { yield { type: 'text-delta', text: '不该到这里' } } }
    // agent 为空 + 配置里没指定 provider/model → 取不到路由
    const out = await composeDiaryText(llm, {}, undefined, 'public', baseCtx)
    assert.equal(out, null)
  })

  test('正常返回正文', async () => {
    const llm = {
      async *stream() {
        yield { type: 'text-delta', text: '【公开】\n2026-10-30\n\n' }
        yield { type: 'text-delta', text: '今天的日记。' }
      }
    }
    const config = { diarySummarizeProvider: 'p', diarySummarizeModel: 'm' }
    const out = await composeDiaryText(llm, config, undefined, 'public', baseCtx)
    assert.equal(out, '【公开】\n2026-10-30\n\n今天的日记。')
  })

  test('模型只吐空文本时返回 null（不能写一篇空的）', async () => {
    const llm = { async *stream() { yield { type: 'text-delta', text: '   ' } } }
    const config = { diarySummarizeProvider: 'p', diarySummarizeModel: 'm' }
    const out = await composeDiaryText(llm, config, undefined, 'public', baseCtx)
    assert.equal(out, null)
  })

  test('模型报错误 finish 时返回 null', async () => {
    const llm = {
      async *stream() {
        yield { type: 'finish', reason: { kind: 'error', message: '配额用尽' } }
      }
    }
    const config = { diarySummarizeProvider: 'p', diarySummarizeModel: 'm' }
    const out = await composeDiaryText(llm, config, undefined, 'public', baseCtx)
    assert.equal(out, null)
  })

  test('公开篇的提示词里不该出现私密历史', async () => {
    let captured = ''
    const llm = {
      async *stream(opts) {
        captured = JSON.stringify(opts.messages ?? [])
        yield { type: 'text-delta', text: '正文' }
      }
    }
    const config = { diarySummarizeProvider: 'p', diarySummarizeModel: 'm' }
    await composeDiaryText(llm, config, undefined, 'public', {
      ...baseCtx,
      recentDiaries: { public: '公开的旧日记', all: '公开的旧日记\n私密的旧日记' }
    })
    assert.match(captured, /公开的旧日记/)
    assert.doesNotMatch(captured, /私密的旧日记/)
  })

  test('私密篇的提示词里包含全部历史', async () => {
    let captured = ''
    const llm = {
      async *stream(opts) {
        captured = JSON.stringify(opts.messages ?? [])
        yield { type: 'text-delta', text: '正文' }
      }
    }
    const config = { diarySummarizeProvider: 'p', diarySummarizeModel: 'm' }
    await composeDiaryText(llm, config, undefined, 'private', {
      ...baseCtx,
      recentDiaries: { public: '公开的旧日记', all: '公开的旧日记\n私密的旧日记' }
    })
    assert.match(captured, /私密的旧日记/)
  })
})
