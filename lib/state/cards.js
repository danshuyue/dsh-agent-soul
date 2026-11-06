/**
 * 状态与持久化编排 · cards.js
 * 由 lib/store.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { addRecord, classifyScope, corruptInfoOf, createCard, isCardReadonly, loadCard, mergeCards, normalizeConfig, saveCard } from '../memory.js'
import { cardCache, loadCached, mtimeOf } from './cache.js'
import { invalidate } from './file-cache.js'
import { globalMemoryPath, projectMemoryPath } from '../paths.js'
import { note } from '../env.js'


/** 全局记忆卡。 */
export function globalCard() {
  return loadCached('global', globalMemoryPath(), loadCard, () => createCard('global'))
}


/** 项目记忆卡（按 cwd 的 slug）。 */
export function projectCard(cwd) {
  const key = `project:${String(cwd ?? '')}`
  const file = projectMemoryPath(cwd)
  return loadCached(key, file, loadCard, () => createCard('project'))
}


/** 这个会话该用的卡集合：全局 + （有 cwd 时）项目。 */
export function cardsFor(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  const out = []
  if (cfg.enabled === false) return out
  out.push({ scope: 'global', card: globalCard() })
  if (String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false) {
    out.push({ scope: 'project', card: projectCard(cwd) })
  }
  return out
}


/**
 * 存盘 + 跨进程冲突处理（2026-11-01，审计 A3）。
 *
 * store 的模式是「mtime 缓存 → 改内存 → 全量写回」。如果另一个 DSH 进程
 * （desktop + CLI 同时开、或两个 profile 指向同一 ~/.dsh）在我们读完之后
 * 写过这张卡，直接覆盖就把对方刚记的东西整份抹了 —— atomicWrite 只防半截文件，
 * 不防丢更新。
 *
 * 这里写前比一次 mtime：变了就把盘上那份读回来做并集再写。
 */
function saveCardMerged(key, file, card) {
  const hit = cardCache.get(key)
  const stamp = mtimeOf(file)
  let target = card
  if (hit !== undefined && stamp !== 0 && hit.stamp !== stamp) {
    const disk = loadCard(file)
    if (disk !== null) {
      const merged = mergeCards(card, disk)
      target = merged.card
      note('memory', `${key}：文件被别的进程改过，已合并（补回 ${merged.added} 条）`)
    }
  }
  const saved = saveCard(file, target)
  // 2026-11-05 修 P0-4：写盘失败时**不要删缓存**。
  // 以前无条件 delete，失败后连内存里那份改过的卡都取不到了，
  // 记录变成「既不在磁盘、也不在内存」，而上层还收到 ok:true。
  // 保留缓存 = 保住这次改动、留一个可重试的状态；是否对外报成功，
  // 由调用方依据 saved.ok 决定（本函数只负责不再丢数据）。
  if (saved?.ok === true) {
    invalidate(cardCache, key)
  } else {
    note('memory', `${key}：写盘失败，保留内存缓存待重试（${saved?.error ?? '未知原因'}）`)
  }
  // 2026-11-04 修 ①：把「到底写没写进磁盘」带回去。
  // 以前这里返回的是卡本身 —— 写得成、写不成返回值长得一模一样，
  // 调用方（记忆提取链）就没法据此决定游标推不推，于是写盘失败的那批对话永久消失。
  return { ...saved, card: target }
}


export function saveGlobalCard(card) {
  return saveCardMerged('global', globalMemoryPath(), card)
}


export function saveProjectCard(cwd, card) {
  return saveCardMerged(`project:${String(cwd ?? '')}`, projectMemoryPath(cwd), card)
}


/** 记忆卡健康状态（设置页亮红用）：没坏过返回 null。 */
export function memoryHealth() {
  return corruptInfoOf(globalMemoryPath())
}


/** 写入一条记忆：按 scope 决定进哪张卡。scope 可以是 'auto'（先判归属）。 */
export function writeMemory({ cwd = '', scope = 'global', input = {}, config = {} }) {
  const cfg = normalizeConfig(config)
  const wanted = scope === 'auto'
    ? classifyScope(input?.text, cwd, cfg)
    : scope
  const useProject = wanted === 'project' && String(cwd).trim() !== ''
  const file = useProject ? projectMemoryPath(cwd) : globalMemoryPath()
  // 只读模式（读取受损且无法把原文件挪走）：**明确失败**，不装作记下了。
  // 静默返回 ok 的话，用户以为记住了，其实是拿空卡盖掉原文件的路上被拦了一下。
  if (isCardReadonly(file) === true) {
    return { ok: false, reason: '记忆卡只读：上次读取失败且无法安全备份，已跳过写入' }
  }
  const card = useProject ? projectCard(cwd) : globalCard()
  const result = addRecord(card, input, cfg, Date.now())
  if (result.ok === true) {
    // 2026-11-05 修 P0-4：这里原来**根本没接** saveCard 的返回值，
    // 返回的 ok:true 只来自内存里的 addRecord —— 磁盘结果从未进入这条链路。
    // 盘满 / 目录被删 / 权限丢失时，工具照样回「记住了」，而记录没落盘。
    // 注意：不是「拿到失败结果还当成功」，是压根没拿；B10 补了主链路，
    // 这个调用点被漏掉了。现在把结果接进返回链。
    const saved = useProject ? saveProjectCard(cwd, card) : saveGlobalCard(card)
    if (saved?.ok !== true) {
      return {
        ...result,
        ok: false,
        reason: `记忆写入磁盘失败：${saved?.error ?? '未知原因'}（改动仍在内存缓存，修复后可重试）`
      }
    }
  }
  return result
}
