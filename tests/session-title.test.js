/**
 * 会话标题读取测试：node tests/session-title.test.js
 *
 * 重点盯两件事（都是踩过的坑）：
 *   ① 日志是**多帧 zstd** 追加写的 —— 只解第一帧会漏掉尾巴上的 session/title；
 *   ② 日志缺失 / 空壳会话 / 坏帧都不许抛，只许回退（占位文案或空串）。
 *
 * ⚠️ 全程把 DSH_HOME 指到临时目录，绝不碰真实的 ~/.dsh/sessions。
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = actual === expected
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// 先换 DSH_HOME 再 import（paths.js / registry.js 每次都读环境变量）
const fakeHome = mkdtempSync(join(tmpdir(), 'soul-session-title-'))
process.env.DSH_HOME = fakeHome

const { EMPTY_SESSION_TITLE, decodeZstdFrames, readTitleFromLog, titleForSession, findSessionLog } =
  await import('../lib/session-title.js')

const workDir = mkdtempSync(join(tmpdir(), 'soul-session-title-files-'))

/** 拼多帧 zstd：每段是独立压缩的一帧，首尾相接就是 DSH 日志的真实形状。 */
function frames(...chunks) {
  return Buffer.concat(chunks.map((text) => zstdCompressSync(Buffer.from(text, 'utf8'))))
}
function event(type, data) {
  return JSON.stringify({ type, data }) + '\n'
}
function titleEvent(title) {
  return event('session/title', { title })
}
function messageEvent(text) {
  return event('user/message', { content: [{ type: 'text', text }] })
}

console.log('多帧 zstd（Q14 的坑）：')
{
  const file = join(workDir, 'multi-frame.zstd')
  // 标题在**最后**一帧：只解第一帧会读不到
  writeFileSync(file, frames(
    event('session/header', { id: 's1', cwd: 'D:\\x' }) + messageEvent('第一句话'),
    messageEvent('第二句话'),
    titleEvent('旧标题'),
    titleEvent('最后一帧的标题')
  ))
  eq(readTitleFromLog(file), '最后一帧的标题', '能读到最后一帧里的 session/title（取最后一条）')
  const lines = decodeZstdFrames(frames('{"a":1}\n', '{"b":2}\n', '{"c":3}\n'))
  eq(lines.length, 3, `多帧逐帧解出全部行（${lines.length} 行）`)
}

console.log('\n回退链：')
{
  // 没有标题 → 首条用户消息，截到第一个标点
  const noTitle = join(workDir, 'no-title.zstd')
  writeFileSync(noTitle, frames(
    messageEvent('今天天气不错。后面还有一大段不该出现的话'),
    messageEvent('第二条不该被选中')
  ))
  eq(readTitleFromLog(noTitle), '今天天气不错', '没有标题时回退首条消息，截到第一个标点')

  // 没有标点 → 截到 24 字
  const longOne = join(workDir, 'long.zstd')
  const longText = '这是一段特别长的用户消息没有标点也没有换行所以只能按字数截断了啊'
  writeFileSync(longOne, frames(messageEvent(longText)))
  eq(readTitleFromLog(longOne), longText.slice(0, 24), '首条消息没标点时截到 24 字')

  // 空壳会话：只有 header，一行消息都没有
  const empty = join(workDir, 'empty.zstd')
  writeFileSync(empty, frames(event('session/header', { id: 's2' })))
  eq(readTitleFromLog(empty), EMPTY_SESSION_TITLE, '空会话返回占位文案')
  ok(EMPTY_SESSION_TITLE === '（空会话，没有消息）', '占位文案与前端约定一致')
}

console.log('\n健壮性：')
{
  const missing = join(workDir, 'nope', 'session.v4.jsonl.zstd')
  let threw = false
  let value = 'unset'
  try {
    value = readTitleFromLog(missing)
  } catch {
    threw = true
  }
  ok(threw === false, '文件不存在不抛异常')
  eq(value, '', '文件不存在返回空串（由调用方决定回退）')

  // 末尾半帧（正在写）不许拖垮前面的内容
  const half = join(workDir, 'half.zstd')
  writeFileSync(half, Buffer.concat([
    frames(titleEvent('完整的帧')),
    Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x11, 0x22])
  ]))
  eq(readTitleFromLog(half), '完整的帧', '末尾半帧被跳过，前面的标题照读')

  // 缓存要按 size+mtime 失效：追加标题后再读必须看到新的
  const grow = join(workDir, 'grow.zstd')
  writeFileSync(grow, frames(messageEvent('没有标题的时候')))
  eq(readTitleFromLog(grow), '没有标题的时候', '首次读：回退首条消息')
  appendFileSync(grow, frames(titleEvent('后来才有的标题')))
  eq(readTitleFromLog(grow), '后来才有的标题', '追加一帧后缓存失效，读到新标题')

  // 不是 zstd 的垃圾文件
  const junk = join(workDir, 'junk.zstd')
  writeFileSync(junk, 'not a zstd file at all')
  eq(readTitleFromLog(junk), EMPTY_SESSION_TITLE, '无 zstd magic 时当作空会话，不抛')
}

console.log('\n按 sessionId 找日志（titleForSession）：')
{
  const root = join(fakeHome, 'sessions')
  // --D-~80A5~9C7C-- 是 registry.decodeSessionDirName 认的编码名（D:\肥鱼）
  const cwdDir = join(root, '--D-~80A5~9C7C--', 'session-abc-123')
  mkdirSync(cwdDir, { recursive: true })
  writeFileSync(join(cwdDir, 'session.v4.jsonl.zstd'), frames(
    messageEvent('你好'),
    titleEvent('按 id 找到的标题')
  ))
  eq(titleForSession('session-abc-123'), '按 id 找到的标题', '按 sessionId 扫目录读到标题')

  // 没有 cwd 的会话落在 _no-cwd 里，也必须找得到
  const noCwdDir = join(root, '_no-cwd', 'session-no-cwd')
  mkdirSync(noCwdDir, { recursive: true })
  writeFileSync(join(noCwdDir, 'session.v4.jsonl.zstd'), frames(titleEvent('没有 cwd 的会话')))
  eq(titleForSession('session-no-cwd'), '没有 cwd 的会话', '_no-cwd 里的会话也能找到')

  ok(findSessionLog('session-abc-123').endsWith('session.v4.jsonl.zstd'), 'findSessionLog 返回日志文件路径')
  eq(titleForSession('不存在的会话'), '', '找不到会话返回空串')
  eq(titleForSession(''), '', '空 id 返回空串')
  eq(titleForSession('../escape'), '', '带路径分隔符的 id 被拒绝')
}

rmSync(workDir, { recursive: true, force: true })
rmSync(fakeHome, { recursive: true, force: true })

console.log('')
console.log(failed === 0 ? `全部通过：${passed} 个断言` : `失败 ${failed} 个（通过 ${passed} 个）`)
process.exit(failed === 0 ? 0 : 1)
