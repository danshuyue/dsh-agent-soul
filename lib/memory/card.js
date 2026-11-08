/**
 * 记忆引擎 · card.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { CLARITY_ORDER, MEMORY_KINDS, MEMORY_VERSION, normalizeKind } from './constants.js'
import { FACT_RE, clamp, iso, timeOf } from './signals.js'
import { shortHash } from '../paths.js'


// ---- 卡的读写 ----

/**
 * R01 / T3：版本号归一。老卡没有该字段读作 0；字符串 "7" 按数字处理；
 * 极大值 / NaN / 负数收敛到合法范围，避免 max+1 溢出或拼出 "77"。
 * 故意不导出 —— 不新增公共导出就不用改导出快照（03 答复 §3.3）。
 */
function revOf(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)
}

export function createCard(scope = 'global', now = Date.now()) {
  return {
    version: MEMORY_VERSION,
    rev: 0,
    scope,
    records: [],
    stats: { added: 0, decayed: 0, forgotten: 0, compacted: 0, lastDecayAt: null },
    lastDecayDate: null,
    createdAt: iso(now),
    updatedAt: iso(now)
  }
}


/**
 * 老记录的 kind 补全（2026-10-30，卡片 v1 → v2）。
 *
 * 判据只用当时已经存在的字段，不猜、不调模型：
 *   · 已经是合法 kind（手工写的、新卡里的）→ 原样不动，迁移只补空的
 *   · tags 含 fact，或正文命中 FACT_RE → 'fact'（FACT_RE 是旧版唯一的「长期事实」判据）
 *   · tags 含 first → 'event'（保持原判：一次性的锚点）
 *   · 其余 → 'event'
 *
 * 为什么必须迁移：kind 缺省被归一成 event，于是注入里每条老记录都顶着〔事件〕，
 * 连「树树是烟台大学…」这种事实也不例外 —— 标签变成噪音，反而看不出哪条是事实。
 */
export function legacyKindOf(raw) {
  const kind = String(raw?.kind ?? '')
  // ⚠️ 2026-10-30 实测发现的坑：老卡里的 kind 不是"缺字段"，而是上一版回读时
  // 已经被归一成 'event' 存进去了（global.json 14 条全是 event）。
  // 所以 v1 卡上的 'event' 必须**重新判一次**，否则迁移等于没做。
  // 只有 non-event 的明确值（fact/preference/promise/feeling）才原样保留。
  if (MEMORY_KINDS.includes(kind) && kind !== 'event') return kind
  const tags = Array.isArray(raw?.tags) ? raw.tags.map((t) => String(t)) : []
  if (tags.includes('fact')) return 'fact'
  if (tags.includes('first')) return 'event'
  if (FACT_RE.test(String(raw?.text ?? ''))) return 'fact'
  return 'event'
}


/** 结构收敛：外部传进来的卡（含旧版本）一律补齐必需字段。 */
export function normalizeCard(raw) {
  const card = createCard(String(raw?.scope ?? 'global'))
  const source = raw !== null && typeof raw === 'object' ? raw : {}
  // 旧卡（v1）在加载时就地迁移 kind，新卡/Card 已迁移的走同一套 normalizeRecord。
  const legacy = (Number(source.version) || 1) < MEMORY_VERSION
  card.records = (Array.isArray(source.records) ? source.records : [])
    .map((item) => normalizeRecord(item, { migrateKind: legacy }))
    .filter((item) => item !== null)
  card.stats = { ...card.stats, ...(typeof source.stats === 'object' && source.stats !== null ? source.stats : {}) }
  card.lastDecayDate = typeof source.lastDecayDate === 'string' ? source.lastDecayDate : null
  card.createdAt = typeof source.createdAt === 'string' ? source.createdAt : card.createdAt
  card.updatedAt = typeof source.updatedAt === 'string' ? source.updatedAt : card.updatedAt
  // R01 / T3：老卡（无 rev）读作 0；带脏值的卡收敛成合法整数
  card.rev = revOf(source.rev)
  return card
}


function normalizeRecord(raw, { migrateKind = false } = {}) {
  if (raw === null || typeof raw !== 'object') return null
  const text = String(raw.text ?? '').trim()
  if (text === '') return null
  const clarity = CLARITY_ORDER.includes(raw.clarity) ? raw.clarity : 'clear'
  return {
    // 2026-11-08 KNOWN-ISSUES #14：补 id 的哈希原来不掺 scope —— 两张卡各有一条
    // 「同文本 + 同时间」的手工导入记录会撞 id，mergeCards 按 id 去重就误并成一条。
    // 现在把 scope 掺进去（scope 是 '' 时与旧哈希差一个尾部 `|`，id 会变，
    // 但只影响补 id 的记录 —— 真正已入库的记录 id 是稳定的不受影响）。
    id: typeof raw.id === 'string' && raw.id !== '' ? raw.id : shortHash(`${text}|${String(raw.createdAt ?? '')}|${String(raw.scope ?? '')}`),
    text,
    title: String(raw.title ?? '').trim(),
    importance: clamp(Number(raw.importance) || 0, 0, 100),
    kind: migrateKind === true ? legacyKindOf(raw) : normalizeKind(raw.kind),
    clarity,
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t)) : [],
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : iso(),
    lastSeenAt: typeof raw.lastSeenAt === 'string' ? raw.lastSeenAt : iso(),
    recallCount: Math.max(0, Math.trunc(Number(raw.recallCount) || 0)),
    pinned: raw.pinned === true,
    isInitial: raw.isInitial === true,
    source: String(raw.source ?? 'manual'),
    scope: raw.scope === 'project' ? 'project' : 'global'
  }
}


/**
 * 跨进程合并（2026-11-01，审计 A3）。
 *
 * store.js 是「mtime 缓存 → 改内存 → 全量写回」。两个 DSH 进程（desktop + CLI，
 * 或两个 profile 指向同一个 ~/.dsh）同时开着时，后写的那个会拿自己那份内存
 * 把对方刚写进去的记录整份盖掉 —— atomicWrite 只保证文件不半截，不保证不丢更新。
 *
 * 所以写之前先比 mtime：变了就把盘上那份读回来做并集（按 id 去重，
 * 同 id 取 lastSeenAt 更新的那条、recallCount 取大），然后写合并结果。
 *
 * 代价说明：并集会**复活**另一进程刚删掉的记录（压缩/遗忘记档后又被并回来）。
 * 这个取舍是故意的 —— 多记一条旧的，比丢掉一条新的轻。
 */
export function mergeCards(mine, theirs, now = Date.now()) {
  const base = normalizeCard(mine)
  const other = normalizeCard(theirs)
  const byId = new Map()
  for (const record of other.records) byId.set(record.id, record)
  let added = 0
  for (const record of base.records) {
    const rival = byId.get(record.id)
    if (rival === undefined) {
      byId.set(record.id, record)
      continue
    }
    const mineNewer = timeOf(record.lastSeenAt, 0) >= timeOf(rival.lastSeenAt, 0)
    const winner = mineNewer === true ? record : rival
    const loser = mineNewer === true ? rival : record
    winner.recallCount = Math.max(Number(winner.recallCount) || 0, Number(loser.recallCount) || 0)
    byId.set(record.id, winner)
  }
  added = byId.size - base.records.length
  base.records = [...byId.values()]
  base.stats = {
    ...other.stats,
    ...base.stats,
    added: Math.max(Number(base.stats.added) || 0, Number(other.stats.added) || 0),
    // 2026-11-08 KNOWN-ISSUES #13：decayed 原来漏了 —— spread 顺序下只会取到
    // base 的值，对方进程衰减次数更多时计数丢失。
    decayed: Math.max(Number(base.stats.decayed) || 0, Number(other.stats.decayed) || 0),
    forgotten: Math.max(Number(base.stats.forgotten) || 0, Number(other.stats.forgotten) || 0),
    compacted: Math.max(Number(base.stats.compacted) || 0, Number(other.stats.compacted) || 0),
    // lastDecayAt 同 lastDecayDate 的口径：取较新的那个（null 永远更旧）
    lastDecayAt: [base.stats.lastDecayAt, other.stats.lastDecayAt]
      .filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v)))
      .map((v) => Number(v))
      .sort((a, b) => a - b)
      .at(-1) ?? null
  }
  // 2026-11-06 审计 P2-2：取**较新**的那个，不能无条件用对方的。
  // 原来 `other.lastDecayDate ?? base.lastDecayDate`：对方是旧进程（或旧备份）时
  // 会把衰减日期往回拨，下一次 maintain 一看「好几天没衰减」就一次补降好几档。
  // 日期是 YYYY-MM-DD，字符串比较即时间比较；null 表示没衰减过，永远更旧。
  base.lastDecayDate = [base.lastDecayDate, other.lastDecayDate]
    .filter((value) => typeof value === 'string' && value !== '')
    .sort()
    .at(-1) ?? null
  base.updatedAt = iso(now)
  // R01 / T3（03 答复 §4.1）：合并本身**不**产生新版本，只取两边较大的 rev。
  // 「一个 rev 增量 = 一次成功持久化」，+1 统一由 saveCard 在写盘成功时加。
  // 不改合并结果、不拒绝写、不加墓碑 —— 本轮只要观测。
  base.rev = Math.max(revOf(mine?.rev), revOf(theirs?.rev))
  return { card: base, added }
}
