/**
 * 状态与持久化编排 · mood-state.js
 * 由 lib/store.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { applyDelta, blankMoodState, decayMood, normMoodState, normalizeMoodConfig } from '../mood.js'
import { applyEmotionToDrives } from '../purpose.js'
import { atomicWrite, ensureDirs, exists, moodDir, moodPath, readText } from '../paths.js'
import { join } from 'node:path'
import { loadConfig, moodCache, purposeState, savePurposeState } from './cache.js'
import { invalidate, readThrough, settle } from './file-cache.js'
import { note } from '../env.js'
import { readdirSync } from 'node:fs'


// --------------------------------------------------------------------------
// 心情状态（按 cwd 的 slug；无 cwd 用 global）
// --------------------------------------------------------------------------

/**
 * 心情状态。跟记忆卡同一套「mtime 缓存」模式：
 * 判断是异步落盘的，设置页又要20 秒轮询，每次都 readFile 会让两条路径互相踩。
 */
export function moodState(cwd) {
  const key = `mood:${String(cwd ?? '')}`
  return readThrough(moodCache, key, moodPath(cwd), (file) => {
    let raw = null
    try {
      const text = readText(file)
      raw = text === '' ? null : JSON.parse(text)
    } catch {
      raw = null
    }
    return normMoodState(raw, loadConfig().moodBase)
  })
}


/**
 * 所有工作区的心情分片（日记用）。
 *
 * 心情是按 cwd 存一份一份的，而**日记没有 cwd** —— 它记的是一整天，不管你在哪个
 * 工作区聊。所以这里不挑一份，把 `mood/` 下所有 json 全读出来交给调用方合并。
 *
 * 读不到 / 单个文件坏了都不抛：日记只是少了情绪底色，不该整篇写不出来。
 */
export function allMoodStates() {
  // 2026-10-31：心情已改成全局单文件（见 paths.js 的 moodPath）。
  // 原来这里把 mood/ 下所有 json 全读出来合并 —— 因为心情按工作区一份一份存，
  // 而日记没有 cwd。现在不再分工作区，继续合并只会把同一份状态重复计入。
  migrateMoodFiles()
  const file = moodPath('')
  if (!exists(file)) return []
  const base = loadConfig().moodBase
  try {
    return [normMoodState(JSON.parse(readText(file)), base)].filter((s) => s !== null && s !== undefined)
  } catch (error) {
    note('mood', `读心情状态失败：${error instanceof Error ? error.message : error}`)
    return []
  }
}


/**
 * 一次性迁移：把旧的「按工作区一份」合并成全局一份（2026-10-31）。
 *
 * 幂等：global.json 存在就什么都不做。挑时间线最多的那份 —— 它记录最全。
 * 旧文件不删，留着可以回溯（真要清理时手动删，不要替用户做不可逆的事）。
 */
export function migrateMoodFiles() {
  try {
    const dir = moodDir()
    if (!exists(dir)) return
    const globalFile = join(dir, 'global.json')
    if (exists(globalFile)) return

    const files = readdirSync(dir).filter((f) => String(f).endsWith('.json'))
    if (files.length === 0) return

    let best = null
    let bestLen = -1
    let bestName = ''
    for (const f of files) {
      try {
        const st = JSON.parse(readText(join(dir, String(f))))
        const len = Array.isArray(st?.timeline) ? st.timeline.length : 0
        if (len > bestLen) { bestLen = len; best = st; bestName = String(f) }
      } catch (error) {
        note('mood', `迁移时跳过读不了的心情文件 ${f}：${error instanceof Error ? error.message : error}`)
      }
    }
    if (best === null) return
    const written = atomicWrite(globalFile, `${JSON.stringify(best, null, 2)}\n`)
    if (written?.ok !== true) {
      note('mood', `⚠️ 心情迁移写盘失败：${written?.error ?? '未知原因'}`)
      return
    }
    note('mood', `心情已合并为全局单份，沿用记录最完整的「${bestName}」（${bestLen} 条时间线）；旧文件保留未删`)
  } catch (error) {
    note('mood', `心情合并失败：${error instanceof Error ? error.message : error}`)
  }
}


export function saveMoodState(cwd, state) {
  ensureDirs()
  // 2026-11-05 DSH 复核收尾：同 savePurposeState，写失败不能再删缓存。
  // moodState() 也是按 mtime 判缓存，删了就回盘读旧值 → 心情当场回退。
  const file = moodPath(cwd)
  const key = `mood:${String(cwd ?? '')}`
  const written = atomicWrite(file, `${JSON.stringify(state, null, 2)}\n`)
  if (written?.ok !== true) {
    const error = written?.error ?? '未知原因'
    note('mood', `⚠️ 心情状态写盘失败：${error}（改动保留在内存，重启会丢失，请检查磁盘/权限）`)
    // 写失败：内存新值 + 当前磁盘 mtime，moodState() 不会回退成旧心情。
    settle(moodCache, key, file, normMoodState(state, loadConfig().moodBase) ?? state)
    return { ok: false, error, state }
  }
  invalidate(moodCache, key)
  return { ok: true, state }
}


/** 重置成一份空白心情（设置页的「重置」按钮）。 */
export function resetMood(cwd) {
  // 保持旧契约：设置页 / 冒烟测试拿的是状态对象，不是写盘结果。
  const saved = saveMoodState(cwd, blankMoodState(loadConfig().moodBase))
  return saved.state
}


/**
 * 应用一次判定结果并落盘。
 * 衰减也在这里顺手做：判定前先让时间把旧情绪磨平一点，别让一周前的吃醋还全额压在底上。
 */
export function applyMoodDelta(cwd, delta, opts = {}) {
  const cfg = normalizeMoodConfig(loadConfig())
  const s = moodState(cwd)
  decayMood(s, cfg.moodBase, Date.now(), cfg.moodDecayHalfHours)
  applyDelta(s, delta, { floor: cfg.moodFloor, minor: opts.minor === true })
  saveMoodState(cwd, s)
  // 判定完了顺手把情绪推给目的：担心/心疼 → 更惦记你，开心/甜蜜 → 更想说点什么。
  // 放在这里而不是 maintain 里，是因为只有判定过才知道这一轮她是什么情绪。
  pullDrivesByEmotion(s.dims)
  return s
}


/**
 * 情绪牵引目的驱动一次。
 *
 * 心情是按工作区分片的，驱动是全局的 —— 这里不挑分片，谁判定了谁推一把，
 * 最后停在哪个值由「靠拢」自然收敛（见 applyEmotionToDrives）。
 *
 * 失败不影响心情：牵引只是让目的机制有素材，推不动也不该让这一轮的心情白记。
 */
export function pullDrivesByEmotion(dims) {
  try {
    if (loadConfig().purposeEnabled === false) return null
    const state = purposeState()
    const next = applyEmotionToDrives(state.drives, dims)
    state.drives = next
    savePurposeState(state)
    return next
  } catch (error) {
    note('purpose', `情绪牵引失败：${error instanceof Error ? error.message : error}`)
    return null
  }
}


/**
 * 只做时间衰减（设置页刷新、手动整理时用）。
 * 平复过半格就写盘；不然设置页看到的心情会停在上次判定那一刻。
 */
export function decayMoodFor(cwd) {
  const cfg = normalizeMoodConfig(loadConfig())
  const s = moodState(cwd)
  const before = s.mood
  const beforeNoted = s.lastNotedMood
  decayMood(s, cfg.moodBase, Date.now(), cfg.moodDecayHalfHours)
  const moved = Math.abs(s.mood - before) >= 0.5 || s.lastNotedMood !== beforeNoted
  if (moved) saveMoodState(cwd, s)
  return s
}


/** 心情统计（设置页用）：值 + 七情 + 时间线条数。 */
export function moodStats(cwd) {
  const s = moodState(cwd)
  return {
    mood: Math.round(s.mood),
    dims: Object.fromEntries(Object.entries(s.dims).map(([k, v]) => [k, Math.round(v)])),
    lastReason: s.lastReason,
    lastConfidence: s.lastConfidence,
    updatedAt: s.updatedAt,
    timelineCount: s.timeline.length
  }
}
