/**
 * 状态与持久化编排 · maintain.js
 * 由 lib/store.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { addRecord, applyDecay, classifyScope, compactCard, daysSince, makeArchiver, normalizeConfig, normalizeKind, scoreRecord, status } from '../memory.js'
import { autoMemoryRejectReason, minImportanceForKind } from '../extract.js'
import { deriveDrives, mineGoals } from '../purpose.js'
import { archivePath, exists, memoryDir } from '../paths.js'
import { rotateArchiveIfNeeded } from '../retention.js'
import { globalCard, projectCard, saveGlobalCard, saveProjectCard } from './cards.js'
import { join } from 'node:path'
import { note } from '../env.js'
import { purposeState, savePurposeState } from './cache.js'
import { writeDailyHealth } from '../health.js'

/**
 * 从记忆记录里挑「最近被想起的 N 条」喂给 deriveDrives。
 *
 * 2026-11-07 R7 / P1-L2，抽成纯函数是为了能单独测：
 *   · 口径按 lastSeenAt（最近被聊到）优先，缺了退回 createdAt；
 *   · 两者都没有的按 0 算 —— 不能让「没有时间的旧记录」假扮成最新；
 *   · 同分时保持原顺序（稳定排序），避免每次 maintain 的素材顺序抖动。
 */
export function pickRecentMaterials(records, limit = 12) {
  const stampOf = (record) => {
    const seen = Date.parse(String(record?.lastSeenAt ?? ''))
    if (Number.isFinite(seen) && seen > 0) return seen
    const created = Date.parse(String(record?.createdAt ?? ''))
    if (Number.isFinite(created) && created > 0) return created
    return 0
  }
  const n = Math.max(1, Math.trunc(Number(limit) || 12))
  return (Array.isArray(records) ? records : [])
    .map((record, index) => ({ record, index, stamp: stampOf(record) }))
    .sort((a, b) => (b.stamp - a.stamp) || (a.index - b.index))
    .slice(0, n)
    .map(({ record }) => ({ text: record.text, title: record.title }))
}



/**
 * 每日维护：衰减 + 压缩 + 遗忘存档。
 *
 * 由注入路径（每回合）和 API 调用，但内部用 lastDecayDate 保证一天只真跑一次。
 * 补跑：DSH 关了一周，回来按「漏了几天」一次推进（最多 30 天），
 * 否则记忆会停在关掉那天，一周的衰减全丢。
 */
export function maintain(cwd, config = {}) {
  const cfg = normalizeConfig(config)
  // 2026-11-06 P12：归档分片检查。archiveMaxBytes 默认 0，此时连 stat 都不做；
  // 开启后超过上限才把 archive.jsonl 另存为分片（不删任何文件）。
  rotateArchiveIfNeeded(archivePath(), cfg.archiveMaxBytes)
  const archive = makeArchiver(`${memoryDir()}/archive.jsonl`)
  // 2026-11-05 修 P0-4：维护路径原来也忽略 target.save() 的结果，
  // 衰减/压缩没落盘照样被算进 report.decayed / compacted，日志显示「维护完成」。
  const report = { decayed: [], compacted: [], errors: [] }

  // 2026-11-06 修 R1（A 层，函数链实测）：保存闭包原来又调了一次 globalCard() / projectCard(cwd)。
  // 前面 applyDecay 存过一次盘、缓存被清，闭包里那次重读会拿到**磁盘上的旧对象**，
  // compactCard 改的那个对象被丢掉 —— 表现是「压缩删了记录、归档也写了一条，但磁盘上还在」，
  // 下次启动重新压缩、档案无限膨胀。改成把被修改的 card 显式传进去。
  const targets = [{ scope: 'global', card: globalCard(), save: (card) => saveGlobalCard(card) }]
  // 2026-11-07 第二份审查 P1-D7：这里只判了 cwd 非空，没看 projectMemoryEnabled。
  // 用户显式关掉项目记忆之后，maintain 仍然每天衰减 / 压缩 / 改写项目卡 ——
  // 把它当冷备份留着的人会发现文件被"整理"过。开关判断与 cardsFor 保持一致。
  if (String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false) {
    targets.push({ scope: 'project', card: projectCard(cwd), save: (card) => saveProjectCard(cwd, card) })
  }

  for (const target of targets) {
    const card = target.card
    const steps = daysSince(card.lastDecayDate)
    // 2026-11-06 审计 P1-4：归档下沉进 applyDecay 了 —— 引擎自己写 archive.jsonl，
    // 不再依赖「调用方记得处理 forgotten」。这里只把归档器显式传进去（保持同一份文件句柄语义），
    // 并且只负责记日志，不重复写档案。
    const { changed, forgotten } = applyDecay(card, cfg, Date.now(), { steps, archive })
    if (forgotten.length > 0) {
      note('memory', `${target.scope}：${forgotten.length} 条彻底遗忘（已存档）`)
    }
    if (changed) {
      const saved = target.save(card)
      if (saved?.ok === true) report.decayed.push(target.scope)
      else report.errors.push({ scope: target.scope, stage: 'decay', error: saved?.error ?? '未知原因' })
    }
    const st = status(card, cfg)
    // 2026-11-04：除了「容量到顶」，卡里只要还躺着 forgotten 也要跑一次。
    // 它们在渲染里看不见（sectionize 跳过），status 的字符统计也不会因为它们变高，
    // 于是 level 可能长期停在 warn/ok —— 这些记录就一直删不掉、越攒越多。
    // compactCard 自己会判断要不要真压缩，这里只负责别把它挡在门外。
    const hasForgotten = card.records.some((record) => record.clarity === 'forgotten')
    if (cfg.autoCompact && (st.level === 'full' || hasForgotten)) {
      const steps2 = compactCard(card, cfg, { now: Date.now(), archive })
      if (steps2 > 0) {
        const saved = target.save(card)
        if (saved?.ok !== true) {
          report.errors.push({ scope: target.scope, stage: 'compact', error: saved?.error ?? '未知原因' })
        } else {
          report.compacted.push({ scope: target.scope, steps: steps2 })
          note('memory', `${target.scope}：容量到顶，压缩掉 ${steps2} 条`)
        }
      }
    }
    // 从记忆里补目标（只在目的机制开着时）
    if (cfg.purposeEnabled !== false) {
      const state = purposeState()
      const before = state.goals.length
      for (const goal of mineGoals(card, { limit: 6 })) {
        // 判据不能只看「还开着的」那条：目标被 closeGoal 设上 closedAt 之后，
        // 原来的 `closedAt === null &&` 会让 exists 变 false，下一轮 maintain
        // 又从记忆卡里挖出一条全新的（closedAt: null）—— 表现就是用户点了
        // 「放下」，过十分钟它自己回来了，永远关不掉。
        const exists = state.goals.some((item) => item.text === goal.text)
        if (!exists) state.goals.push({ ...goal, closedAt: null })
      }
      if (state.goals.length !== before) savePurposeState(state)
    }
  }

  // 驱动衰减：每回合都算一次（成本极低），保证「久没说话会想分享」成立
  if (cfg.purposeEnabled !== false) {
    const state = purposeState()
    const hours = state.drivesAt > 0 ? (Date.now() - state.drivesAt) / 3600000 : 0
    // 素材刺激：把最近记下的东西喂进 deriveDrives。
    // 之前这里永远不传 materials，于是 curiosity / mastery 只能靠自然衰减 + 空闲上涨，
    // README 写的「被聊到的内容会推高对应维度」从来没兑现过 —— 属于参数留了口子但没人接。
    //
    // 2026-11-07 R7 / P1-L2：原来用 `.slice(-12)`，隐含假设 records 按时间有序。
    // 但 mergeCards 会把**别的进程的旧记录排到尾部** —— 跨进程合并过一次之后，
    // 「最近 12 条」可能是很久以前的。现在显式按时间排序取前 12（口径见 pickRecentMaterials）。
    const materials = pickRecentMaterials([
      ...globalCard().records,
      ...(String(cwd ?? '').trim() !== '' ? projectCard(cwd).records : [])
    ], 12)
    const derived = deriveDrives({
      drives: state.drives,
      drivesAt: state.drivesAt,
      now: Date.now(),
      idleHours: hours,
      materials
    })
    state.drives = derived.drives
    state.drivesAt = derived.drivesAt
    savePurposeState(state)
  }

  // 2026-11-04：每日健康一行。
  //
  // 用 try/catch 再包一层：writeDailyHealth 自己不会抛，但这里在**提示词装配路径**上，
  // 宁可吞掉一个统计错误，也不能让一行工程指标把这一轮对话炸掉。
  try {
    writeDailyHealth({
      cwd,
      config: cfg,
      cards: {
        global: globalCard(),
        project: String(cwd ?? '').trim() === '' ? null : projectCard(cwd)
      }
    })
  } catch {
    /* 健康指标失败不影响维护本身 */
  }

  return report
}


/**
 * 把一批**已经成形的记忆**写进卡（自动提取 + 模型提炼之后的落盘口）。
 *
 * 跟 ingestCandidates 的区别：那边收的是「候选原话」（还要现场打分、判是否够格），
 * 这边收的是「提炼过的条目」，重要度由提炼阶段给出（模型判断它值多少分）。
 * tags 仍然交给 addRecord 里的正则去算 —— 写成事实句就自动拿到 fact，
 * 拿到 fact 就有了「永不遗忘」的保护，不用模型去猜标签体系。
 *
 * @returns {{ written: number, promoted: number }}
 */
export function writeAutoMemories(cwd, items, config = {}) {
  const cfg = normalizeConfig(config)
  const list = (Array.isArray(items) ? items : []).filter((item) => String(item?.text ?? '').trim() !== '')
  const report = { written: 0, promoted: 0, saved: true }
  if (list.length === 0) return report

  const useProject = String(cwd ?? '').trim() !== '' && cfg.projectMemoryEnabled !== false
  // 2026-11-05：写之前先判归属 —— 项目独有的进项目卡，其余进全局卡，**不再双写**。
  // 双写的毛病：项目卡慢慢变成全局卡的副本（这次合并前 63 条里 50 条是副本），
  // 注入一屏里同一句出现两遍，还得靠渲染层去重兜底；而且两份内容会各自分叉。
  // 判断放在写入口，数据本身就是干净的。
  const projectTarget = useProject ? projectCard(cwd) : null
  const globalTarget = globalCard()
  const touched = new Set()
  const cardFor = (scope) => {
    const useIt = scope === 'project' && projectTarget !== null
    touched.add(useIt ? 'project' : 'global')
    return useIt ? projectTarget : globalTarget
  }
  // 记下落库后的记录本身：去重命中时 addRecord 返回的是**老记录**，
  // 它的 kind / importance 才是卡里真实的字段（item 那份可能会被后续逻辑改掉）。
  const written = []
  const dropped = []
  for (const item of list) {
    // 2026-10-30 第一道闸（提示词管不住的用规则兜底）：祈使句、代码改动进度、
    // 「对…进行…」、「最近在排查 X / 下一步要 Y」—— 命中整条丢弃。
    // 用户当场在项目卡里抓到的那三条垃圾记忆全是这一类。
    const junk = autoMemoryRejectReason(item.text)
    if (junk !== null) {
      dropped.push(junk)
      continue
    }
    // 第二道闸：kind=event 的自动记忆要 ≥ autoImportanceEvent（默认 70）才配占位置，
    // fact/preference/promise 照旧 autoImportanceDefault（42）。
    // 阈值由 extract.js 的 minImportanceForKind 统一挑选，不在调用方散写。
    const kind = normalizeKind(item.kind)
    const importance = Number.isFinite(Number(item.importance))
      ? Math.min(100, Math.max(0, Math.round(Number(item.importance))))
      : scoreRecord({ text: String(item.text ?? ''), isOwner: true, isPrivate: true }).importance
    if (importance < minImportanceForKind(kind, cfg)) {
      dropped.push(`${kind} 重要度 ${importance} 不够`)
      continue
    }
    // 提炼模型如果能给出 scope 就听它的，给不出（或值不认识）再用规则判。
    const scope = item.scope === 'project' || item.scope === 'global'
      ? item.scope
      : classifyScope(item.text, cwd, cfg)
    const result = addRecord(cardFor(scope), {
      text: item.text,
      isOwner: true,
      isPrivate: true,
      source: item.source ?? 'auto',
      importance: item.importance,
      kind: item.kind
    }, cfg, Date.now())
    if (result?.ok === true) {
      report.written += 1
      written.push(result.record)
    }
  }
  if (report.written > 0) {
    // 2026-11-04 修 ①：saveCard 现在会回 { ok }，这里必须看 ——
    // 提炼这条是**默认走的主路**，不检查的话失败仍然静默，游标照样会前移。
    // 2026-11-05：现在可能写了两张卡，各自存、各自检查。
    for (const scope of touched) {
      const saved = scope === 'project' ? saveProjectCard(cwd, projectTarget) : saveGlobalCard(globalTarget)
      if (saved?.ok !== true) report.saved = false
    }
  }
  if (dropped.length > 0) {
    // 2026-10-31：原来只记 dropped[0] —— 丢了几条、剩下的是什么都看不到。
    // 现在把前几条原因都带上，至少能回头判断「这个判断对不对」。
    const shown = dropped.slice(0, 3).join('；')
    const more = dropped.length > 3 ? `；…另有 ${dropped.length - 3} 条` : ''
    note('memory', `丢弃 ${dropped.length} 条任务/进度类记忆（宁可少记）：${shown}${more}`)
  }
  report.dropped = dropped.length
  report.scopes = [...touched]
  // promoted 字段留着给老的日志/调用方用，含义已经没有了（双写被归属判断取代）。
  report.promoted = 0
  return report
}
