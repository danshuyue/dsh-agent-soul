/**
 * R16 · diary/compose.js 特征测试（2026-11-10，#27 拆分前置）
 *
 * compose.js 全文件只有这两个函数此前**没有任何直接测试**：
 *   composeDiarySetup  会话 preset 组装修复（拆到 diary/agent.js）
 *   buildMoodBlocks    心情底色组装（留在 compose.js）
 * 其余函数（composeDiaryText / composePublic/PrivateMessage / readRecentDiaries /
 * digestDiaries / diaryWindowOf / summarizeConversations）已有 diary 系列测试覆盖。
 *
 * 拆完这份测试必须一条不改就全绿（R15 纪律照抄）。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const imp = (p) => import(pathToFileURL(join(root, 'lib', p)).href)

const sandbox = mkdtempSync(join(tmpdir(), 'soul-r16-'))
process.env.DSH_HOME = sandbox
process.env.TZ = 'UTC'
mkdirSync(join(sandbox, 'agents'), { recursive: true })

let passed = 0
let failed = 0
const ok = (c, n) => { if (c) { passed += 1; console.log(`  ✓ ${n}`) } else { failed += 1; console.error(`  ✗ ${n}`) } }
const eq = (a, e, n) => ok(JSON.stringify(a) === JSON.stringify(e), `${n}${JSON.stringify(a) === JSON.stringify(e) ? '' : `（实际 ${JSON.stringify(a)}，期望 ${JSON.stringify(e)}）`}`)

const { ensureDirs } = await imp('paths.js')
const { sessionsRoot } = await imp('core/registry.js')
ensureDirs()
// 走稳定门面取 buildMoodBlocks；composeDiarySetup 是内部函数（不在门面上），
// 从它拆分后的归宿模块取（#27：compose.js → diary/agent.js）。断言全部不变。
const { buildMoodBlocks } = await imp('diary.js')
const { composeDiarySetup } = await imp('diary/agent.js')
const store = await imp('store.js')
const moodStateMod = await imp('state/mood-state.js')
const { moodState, saveMoodState } = moodStateMod

const todayKey = (() => {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
})()

// ---------------------------------------------------------------------------
console.log('A · buildMoodBlocks（心情底色）')
// ---------------------------------------------------------------------------
{
  // A1: 没有任何心情状态 → 双空
  const r1 = buildMoodBlocks(todayKey, 1320, { config: {} })
  eq(r1, { public: '', private: '' }, 'A1 无心情状态 → 双空串')
}
{
  // A2: 窗口内有真实波动 → public/private 都有内容且口径不同
  const base = moodState('r16-workspace')
  const now = Date.now()
  const next = {
    ...base,
    mood: 62,
    timeline: [
      { at: now - 60_000, mood: 70, delta: 8, conf: 80, reason: '她聊到了蓝桥杯的进展，明显来了精神', kind: 'turn' },
      { at: now - 30_000, mood: 62, delta: -8, conf: 80, reason: '说到实验报告没交，有点蔫', kind: 'turn' }
    ]
  }
  saveMoodState('r16-workspace', next)
  const r2 = buildMoodBlocks(todayKey, 1320, { config: {} })
  ok(r2.public !== '' && r2.private !== '', 'A2 窗口内有波动 → 双段非空')
  ok(r2.public.includes('蓝桥杯') || r2.public.includes('实验报告'), '公开段含真实波动内容')
  ok(r2.private.length >= r2.public.length, '私密段信息量不少于公开段（现状口径：私密给全部）')
}
{
  // A3: 时间线全在窗口外 → 摘要为空
  const base = moodState('r16-workspace')
  const next = { ...base, timeline: [{ at: 1000, mood: 90, delta: 5, conf: 80, reason: '很久以前的事', kind: 'turn' }] }
  saveMoodState('r16-workspace', next)
  const r3 = buildMoodBlocks(todayKey, 1320, { config: {} })
  eq(r3, { public: '', private: '' }, 'A3 时间线全在窗口外 → 双空串（moodDigest empty）')
}

// ---------------------------------------------------------------------------
console.log('B · composeDiarySetup（会话 preset 组装修复）')
// ---------------------------------------------------------------------------
/** 假宿主 ctx：可注入 agentPresets / sessions 两个服务。 */
function makeCtx({ presets, sessions } = {}) {
  const services = { agentPresets: presets, sessions }
  return { get(key) { return services[key] } }
}

{
  // B1: presets 服务缺失 → undefined（并有告警日志）
  const r = await composeDiarySetup(makeCtx(), 'sess-r16-x')
  eq(r, undefined, 'B1 agentPresets 服务缺失 → undefined')
}
{
  // B2: 活会话带 agentPreset → resolve + 返回挂载函数
  const mounted = []
  const presets = {
    resolve: async (id) => ({ id: `resolved-${id}` }),
    mount: async (agentCtx, id) => { mounted.push(id) }
  }
  const sessions = { get: (id) => ({ header: { id, agentPreset: 'standard' } }) }
  const r = await composeDiarySetup(makeCtx({ presets, sessions }), 'sess-r16-a')
  ok(typeof r === 'function', 'B2 活会话有 preset → 返回挂载函数')
  await r({})
  eq(mounted, ['resolved-standard'], 'B2 挂载函数把 resolve 产物 mount 上去')
}
{
  // B3: resolve 抛异常 → undefined（不往上炸）
  const presets = { resolve: async () => { throw new Error('preset 服务炸了') }, mount: async () => {} }
  const sessions = { get: () => ({ header: { agentPreset: 'standard' } }) }
  const r = await composeDiarySetup(makeCtx({ presets, sessions }), 'sess-r16-b')
  eq(r, undefined, 'B3 resolve 抛异常 → undefined（不往调用方炸）')
}
{
  // B4: 会话不活跃（get 返回 null）但落盘日志里有 agentPreset → 从日志读到
  // 目录布局：sessionsRoot()/<--编码后的 cwd-->/<sessionId>/session.v4.jsonl.zstd
  const cwdDir = join(sessionsRoot(), '--r16cwd--')
  const sessDir = join(cwdDir, 'sess-r16-c')
  mkdirSync(sessDir, { recursive: true })
  const headerLine = JSON.stringify({ type: 'session', id: 'sess-r16-c', cwd: 'r16cwd', agentPreset: 'from-log' })
  // 多帧 zstd：按 magic 切帧逐帧解 —— 写一帧即可
  writeFileSync(join(sessDir, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(`${headerLine}\n`)))
  const presets = {
    resolve: async (id) => ({ id: `resolved-${id}` }),
    mount: async () => {}
  }
  const sessions = { get: () => null } // 不活跃
  const r = await composeDiarySetup(makeCtx({ presets, sessions }), 'sess-r16-c')
  ok(typeof r === 'function', 'B4 不活跃会话从落盘日志读到 preset（2026-11-05 事故修的行为）')
  const mounted = []
  await r({ __t: (id) => mounted.push(id) })
  void mounted
}
{
  // B5: 活跃会话与落盘日志都拿不到 preset → undefined
  const presets = { resolve: async (id) => ({ id }), mount: async () => {} }
  const sessions = { get: () => ({ header: { agentPreset: '' } }) }
  const r = await composeDiarySetup(makeCtx({ presets, sessions }), 'sess-r16-none')
  eq(r, undefined, 'B5 live 与落盘都读不到 → undefined')
}

console.log('')
console.log(`结果：${passed} 过 / ${failed} 败`)
rmSync(sandbox, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
