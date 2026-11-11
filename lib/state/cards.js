/**
 * 状态与持久化编排 · cards.js
 * 由 lib/store.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { addRecord, classifyScope, corruptInfoOf, createCard, isCardReadonly, loadCard, mergeCards, normalizeConfig, readCardQuietly, saveCard } from '../memory.js'
import { cardCache, loadCached, mtimeOf } from './cache.js'
import { invalidate } from './file-cache.js'
import { globalMemoryPath, memoryProjectsDir, projectMemoryPath } from '../paths.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { note } from '../env.js'
import { revOf } from '../memory/constants.js'
import { invalidateSegment } from '../host/runtime/segment-cache.js'

/**
 * R01 / T3：与 memory/card.js 的 revOf 同口径（不新增公共导出）。
 * 这里只用观测到的数字比大小、写日志，不参与合并决策。
 */

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
    const disk = readCardQuietly(file)
    if (disk !== null) {
      // R01 / T3：合并前比一次 rev，只做观测 —— 不改合并结果、不拒绝写、不加墓碑。
      const ourRev = revOf(card.rev)
      const diskRev = revOf(disk.rev)
      const merged = mergeCards(card, disk)
      target = merged.card
      if (diskRev > ourRev) {
        note('memory', `${key}：盘上 rev=${diskRev} 比内存 rev=${ourRev} 新，已合并（补回 ${merged.added} 条，记录数差 ${disk.records.length - card.records.length}）`)
      } else {
        note('memory', `${key}：文件被别的进程改过，已合并（补回 ${merged.added} 条）`)
      }
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
    // 2026-11-11：记忆段有渲染缓存。写入成功后立刻作废它 ——
    // 光靠 mtime 也能在下一次装配时发现，但「写完马上作废」是承诺：
    // 她刚记下的那条，下一轮就该在注入里看见（回声路径之外的兜底）。
    invalidateSegment('memory')
    // 2026-11-07 R7 / P1-D5：写后回读一次 rev —— **只检测、不自动重写**。
    //
    // 背景：stamp → loadCard → mergeCards → saveCard 之间没有锁，两个 DSH 进程同时写时
    // 后写者会整份盖掉先写者。彻底解法是文件锁或写后重合并，但那条路要给**每一次写盘**
    // 加成本，而多进程并发是低频场景。
    //
    // 这里取的是折中：写完读一眼盘上的 rev，如果比我们刚写的还大，说明有人在我们之后
    // 写成功了（我们的记录可能被盖）。只在日志里留一行，交给用户判断。
    // 绝不静默 ——「另一条记忆莫名其妙没了」比「多一次 append-only 日志」难查得多。
    const disk = readCardQuietly(file)
    const diskRev = revOf(disk?.rev)
    const ourRev = revOf(target.rev)
    if (disk !== null && diskRev > ourRev) {
      note('memory', `${key}：写完后盘上 rev=${diskRev} 比我们写的 rev=${ourRev} 新 —— 可能有另一个 DSH 进程同时写入，本次改动可能已被覆盖（检测到就报，不自动重试）`)
    }
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
/**
 * 记忆文件健康状态（设置页亮红用）。
 *
 * 2026-11-07 R11 / P2-21：原来只查全局卡 —— 项目卡损坏时设置页**完全看不见**，
 * 用户只会觉得「这个项目的记忆怎么不对」。现在把全局卡与所有项目卡一起汇总：
 * 任何一张坏了都报出来，并说清是哪一张。
 */
export function memoryHealth() {
  const out = []
  const globalInfo = corruptInfoOf(globalMemoryPath())
  if (globalInfo !== null && globalInfo !== undefined) out.push({ scope: 'global', ...globalInfo })

  // 项目卡：目录里有多少张就查多少张（数量很少，直接 readdir）
  try {
    const dir = memoryProjectsDir()
    if (existsSync(dir)) {
      for (const name of readdirSync(dir)) {
        // 坏文件会被 parkCorrupt 改名成 `X.json.corrupt-<时间戳>`，而 corruptState 是以
        // **原路径**为键记的 —— 所以命中改名文件时要把原名字还原出来再去查，
        // 否则「坏掉的那张」恰恰被漏掉（旧实现只查全局卡，漏得更彻底）。
        const corruptAt = name.indexOf('.corrupt-')
        const originalName = corruptAt === -1 ? name : name.slice(0, corruptAt)
        if (!originalName.endsWith('.json')) continue
        const info = corruptInfoOf(join(dir, originalName))
        if (info !== null && info !== undefined) out.push({ scope: 'project', file: originalName, ...info })
      }
    }
  } catch {
    /* 目录读不到就算了，别让健康检查本身抛错 */
  }
  if (out.length === 0) return null
  // 保持旧返回形状（单个对象）的兼容性：多张时用 list 暴露全部，最新的一张也照旧展开在顶层
  return out.length === 1 ? out[0] : { ...out[0], list: out, count: out.length }
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
