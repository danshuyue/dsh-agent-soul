/**
 * 记忆引擎 · mutation.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { CLARITY_ORDER, DAY_MS, normalizeKind } from './constants.js'
import { archivePath, shortHash } from '../paths.js'
import { clamp, dateKey, iso, redact, timeOf } from './signals.js'
import { makeArchiver } from './card-io.js'
import { normalizeConfig } from './config.js'
import { note } from '../env.js'
import { ownerImportant, scoreRecord, targetClarity } from './scoring.js'
import { recordLine, renderCard } from './render.js'


// ---- 归档失败回滚（R01 / 2026-11-06）-----------------------------------
//
// 四个删除入口（applyDecay / forgetRecord / compactCard 的两处）以前都是
// 「先从 card.records 里删掉，再写 archive.jsonl」，而 makeArchiver 早就
// 返回 true / false，只是没人接。盘满、目录被删、权限丢失时，记忆从卡里
// 消失、档案件里也没有 —— 一次失败就是永久丢失，且没有任何痕迹。
//
// 现在统一走这个私有原语：**先归档，再删除**。
// 契约（R01 任务书 §3.1 / 03 答复 §3.1，改名或改形状会让对方无法重放 REDGREEN）：
//   · 名字固定 archiveAll，入参固定 (records, archive, reason, now)
//   · 返回固定 { archived, failed }，两个都是数组
//   · 不导出；四个入口全部经由它，不允许某处自己写归档循环
const ARCHIVE_ENTRY_LABEL = Object.freeze({
  decay: 'applyDecay/decay',
  'manual-forget': 'forgetRecord/manual-forget',
  compact: 'compactCard/compact'
})

/** 「归档器没提供」每进程只提醒一次，别把 soul.log 刷满。 */
let warnedArchiveMissing = false

/**
 * 逐条归档；返回真正归档成功的与原样保留的。archiver 抛异常等价于失败。
 * archive 未提供时保持旧行为（照旧允许删除），只留一行日志 —— 大量单测
 * 直接调 compactCard(card, cfg, { now }) 不传归档器，改语义会炸一片。
 */
function archiveAll(records, archive, reason, now) {
  const list = Array.isArray(records) ? records : []
  if (typeof archive !== 'function') {
    if (list.length > 0 && warnedArchiveMissing === false) {
      warnedArchiveMissing = true
      note('memory', `归档器未提供，本次删除不留档（原因类别：${ARCHIVE_ENTRY_LABEL[reason] ?? reason}）`)
    }
    return { archived: list.slice(), failed: [] }
  }
  const archived = []
  const failed = []
  for (const record of list) {
    let ok = false
    try {
      const outcome = archive(record, reason, now)
      // 显式 false / undefined / 抛异常 = 失败。
      // 正整数也算成功：现有 tests/archive.test.js 的归档器写的是
      // `(record, reason) => collected.push(...)`，返回 Array.push() 的长度。
      // R01 任务书 §2.3⑤ 要求它「不改断言也能过」，若这里只认 === true，
      // 那条「卡里确实没了」会红 —— 见 REPORT §6.6 对这处冲突的说明。
      // 生产归档器 makeArchiver 明确返回 true / false，判据放宽不影响兜底。
      ok = outcome === true || (typeof outcome === 'number' && Number.isFinite(outcome) && outcome > 0)
    } catch { ok = false }
    ;(ok ? archived : failed).push(record)
  }
  if (failed.length > 0) {
    note('memory', `归档失败 ${failed.length} 条（${ARCHIVE_ENTRY_LABEL[reason] ?? reason}），保留在卡里等待下次重试`)
  }
  return { archived, failed }
}


// ---- 增 / 改 / 删 ----

/**
 * 写入一条记忆。
 *
 * 去重策略：同一条文本（归一后）已存在 → 不新增，改为「复习」这条老记忆
 * （recallCount+1、lastSeenAt 刷新）。理由：同一件事反复记一遍会让卡里
 * 塞满重复内容，而人不会因为「今天又提了一次」就多记一条。
 *
 * 2026-10-31 补：**近似重复要留痕**。
 *   原来只有「一字不差」才会被拦下，像
 *     「电脑不能保证24小时开机」和「电脑经常不关机」
 *   这种意思相近但字面不同的，两条都会进卡。
 *   单看没毛病，可万一写进两条互相矛盾的说法（比如「每天22点写日记」和
 *   「第二天写前一天的」），她不知道该信哪个，而**日志里什么都不会说**。
 *
 *   所以这里加一道相似度检查：命中就跟已有的那条比一比，
 *   **记一行日志提醒，但绝不自动替换** —— 让一个字符串算法替她决定
 *   「哪句是真的」太危险了。留痕，让人（和她自己）事后判断。
 */
// --------------------------------------------------------------------------
// 写之前先判归属：这条记忆是「这个项目独有的」还是「到处都成立的」（2026-11-05）
// --------------------------------------------------------------------------

/**
 * 项目独有的信号。命中任意一条就写项目卡，否则写全局卡。
 *
 * 为什么用「指代 + 技术标识」而不是关键词表：单纯出现「插件」「项目」这种词不算 ——
 * 「树树自己开发了两个插件」是全局事实，写进项目卡就等于换个对话就失忆。
 * 真正说明「说的是当前这个工作区」的，是**指代词**（这个/本/当前 + 项目/文件/函数…）
 * 或者**具体的技术标识**（文件扩展名、相对路径、`file.js:123`、`foo()`）。
 */
const PROJECT_SCOPE_MARKERS = Object.freeze([
  // 「这个项目」「本文件」「当前分支」——指代 + 载体名词
  /(这个|本|该|当前)(项目|仓库|工作区|目录|文件夹|文件|模块|插件|脚本|分支|函数|接口|测试)/,
  // 文件名（带常见扩展名）
  /\b[\w.-]+\.(js|mjs|cjs|ts|tsx|jsx|cs|json|ya?ml|md|py|lua|ps1|cmd|bat|sh|toml|ini)\b/i,
  // 相对路径：lib/store.js、tests/xxx.test.js
  /(^|[\s（(])(lib|src|test|tests|tools?|docs?|assets)\/[\w./-]+/i,
  // 绝对路径
  /[A-Za-z]:[\\/]|~\//,
  // 行号引用：store.js:223
  /\b[\w.-]+\.(js|cs|ts|py):\d+/,
  // 函数/方法调用形态：savePurposeState()
  /\b[a-z_$][\w$]*\(\)/i
])


/**
 * 判断一条记忆该进哪张卡。
 *
 * 默认是 **global**，这是有意的保守选择：
 *   写错成 global，代价是多一条到处都读得到的噪音；
 *   写错成 project，代价是换个对话就**完全失忆**（正是这套机制要解决的问题）。
 * 两边不对称，所以宁可漏判成全局，也不轻易判成项目。
 *
 * @param {string} text 记忆正文
 * @param {string} cwd  当前工作区（空 = 没有项目，只能全局）
 * @param {object} config
 * @returns {'global'|'project'}
 */
export function classifyScope(text, cwd = '', config = {}) {
  const t = String(text ?? '').trim()
  if (t === '') return 'global'
  const dir = String(cwd ?? '').trim()
  if (dir === '') return 'global'
  const cfg = normalizeConfig(config)
  if (cfg.projectMemoryEnabled === false) return 'global'

  // 工作区目录名直接出现在正文里（「QQ对话」「work-ea826e02」）→ 明确指的就是它
  //
  // 2026-11-06 审计 P2-4：`includes` 太松。目录名叫 `work` / `ai` / `go` / `code` 时，
  // 「我平时用 workflow…」「AI 这个词…」都会被判成 project，结果这条记忆只在
  // 那个工作区可见 —— 换个对话就"失忆"。改成词边界判断：
  //   · 太短的目录名（<4 字）不足以当证据，直接不认；
  //   · 前后不能紧贴字母数字（中文/标点/空白/开头结尾都算边界）。
  const tail = dir.split(/[\\/]/).filter((part) => part !== '').pop() ?? ''
  if (tail.length >= 4) {
    const escaped = tail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    if (new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(t)) return 'project'
  }

  if (PROJECT_SCOPE_MARKERS.some((re) => re.test(t))) return 'project'
  return 'global'
}


export function addRecord(card, input = {}, config = {}, now = Date.now()) {
  const cfg = normalizeConfig(config)
  const raw = String(input.text ?? '').trim()
  if (raw === '') return { ok: false, reason: '空文本' }

  const text = redact(raw, 600)
  const key = text.replace(/\s+/g, '')
  const existing = card.records.find((record) => record.text.replace(/\s+/g, '') === key)
  if (existing !== undefined && existing !== null) {
    existing.lastSeenAt = iso(now)
    existing.recallCount = (Number(existing.recallCount) || 0) + 1
    stepUp(existing)
    card.updatedAt = iso(now)
    return { ok: true, deduped: true, record: existing }
  }

  // 近似重复：只提醒，不拦截、不改写。
  const nearDupe = findNearDuplicate(card, text)
  if (nearDupe !== null) {
    note('memory', `新记忆与已有条目相近，请留意是否矛盾：新增「${text.slice(0, 40)}」≈ 已有「${nearDupe.record.text.slice(0, 40)}」（相似度 ${Math.round(nearDupe.score * 100)}%）`)
  }

  // 容量到顶就先腾地方。2026-10-30：这条路径原来没传 archive，压缩掉的记录
  // 不进 archive.jsonl（maintain 那条传了），于是「自动写入把老记忆挤没了」
  // 在档案件里查不到。这里补上，格式与 maintain 完全一致（{archivedAt, reason, record}）。
  if (card.records.length >= cfg.maxRecords) {
    compactCard(card, cfg, { now, archive: makeArchiver(archivePath()) })
    // 2026-11-07 第二份审查 P1-D8：原来不复查长度、也不看 compactCard 的返回值。
    // 整卡都是 pinned / 初始记忆 / 主人重要记忆时，compactCard 返回 0（无可压缩项），
    // 然后照旧 push —— maxRecords 对"被保护的记忆"完全失效，卡无界增长。
    // 现在：压完还是满的，就明确拒绝写入，而不是默默超上限。
    if (card.records.length >= cfg.maxRecords) {
      return {
        ok: false,
        reason: `记忆卡已满（${card.records.length}/${cfg.maxRecords}），且没有可压缩的条目（都是被保护的）`
      }
    }
  }

  const scored = scoreRecord({ ...input, text })
  const record = {
    id: shortHash(`${text}|${now}|${card.records.length}`),
    text,
    title: String(input.title ?? '').trim() || text.slice(0, 24),
    importance: scored.importance,
    kind: normalizeKind(input.kind),
    clarity: 'vivid',
    tags: scored.tags,
    createdAt: iso(now),
    lastSeenAt: iso(now),
    recallCount: 0,
    pinned: input.pinned === true,
    isInitial: input.isInitial === true,
    source: String(input.source ?? 'manual'),
    scope: card.scope === 'project' ? 'project' : 'global'
  }
  card.records.push(record)
  card.stats.added = (Number(card.stats.added) || 0) + 1
  card.updatedAt = iso(now)
  return { ok: true, record, reasons: scored.reasons }
}


/**
 * 找出与新文本最相近的一条已有记忆（仅用于提示，不做任何替换）。
 *
 * 算法：字符二元组（bigram）的 Jaccard 重合度。
 * 为什么不用分词：中文没有空格，引入分词库会让插件多一个依赖；
 * 二元组对「电脑不保证24小时开机」/「电脑经常不关机」这类改写足够敏感，
 * 而且中英文都能跑。
 *
 * 阈值 0.55：太低会把「今天心情不错」和「今天写完了代码」也报成相近，
 * 日志会被噪音淹掉。这个值宁可漏报也不要天天报假警。
 *
 * @returns {{record: object, score: number}|null}
 */
function findNearDuplicate(card, text) {
  if (!Array.isArray(card?.records) || card.records.length === 0) return null

  const grams = (s) => {
    const clean = String(s ?? '').replace(/\s+/g, '').toLowerCase()
    if (clean.length < 2) return clean === '' ? new Set() : new Set([clean])
    const out = new Set()
    for (let i = 0; i < clean.length - 1; i += 1) out.add(clean.slice(i, i + 2))
    return out
  }

  const a = grams(text)
  if (a.size === 0) return null

  let best = null
  for (const record of card.records) {
    const b = grams(record?.text)
    if (b.size === 0) continue
    // 只对长度接近的做比较，省掉大部分无意义的计算
    if (Math.min(a.size, b.size) / Math.max(a.size, b.size) < 0.4) continue
    let inter = 0
    for (const g of a) if (b.has(g)) inter += 1
    const score = inter / (a.size + b.size - inter)
    if (score >= 0.55 && (best === null || score > best.score)) best = { record, score }
  }
  return best
}


/** 往上升一档（不越过 vivid）。 */
function stepUp(record) {  const index = CLARITY_ORDER.indexOf(record.clarity)
  if (index > 0) record.clarity = CLARITY_ORDER[index - 1]
}


/** 往下降一档；降到 forgotten 返回 true（调用方负责移出）。 */
function stepDown(record) {
  const index = CLARITY_ORDER.indexOf(record.clarity)
  if (index < 0 || index >= CLARITY_ORDER.length - 1) return record.clarity === 'forgotten'
  record.clarity = CLARITY_ORDER[index + 1]
  return record.clarity === 'forgotten'
}


/**
 * 复习：被再次提及时刷新。
 * @param {string[]} ids 命中的记录 id
 */
export function touchRecords(card, ids, now = Date.now()) {
  const set = new Set(ids)
  let touched = 0
  for (const record of card.records) {
    if (!set.has(record.id)) continue
    record.lastSeenAt = iso(now)
    record.recallCount = (Number(record.recallCount) || 0) + 1
    stepUp(record)
    touched += 1
  }
  if (touched > 0) card.updatedAt = iso(now)
  return touched
}


/** 固定 / 取消固定（永久锚点）。 */
export function setPinned(card, id, pinned = true) {
  const record = card.records.find((item) => item.id === id)
  if (record === undefined || record === null) return false
  record.pinned = pinned === true
  if (record.pinned) record.clarity = 'vivid'
  return true
}


/**
 * 忘记某条（真的删，同时进档案件）。
 *
 * R01：改成「先归档、成功才删」，结果从 record|null 换成 { ok, record?, error? }。
 * 以前归档失败返回不了任何信息，调用方会当成「删掉了」，而记录其实已经
 * 从卡里消失、档案里也没有 —— 重启后连「曾经有过这条」都查不到。
 *   · ok:true                   归档成功（或未提供归档器，保持旧行为），record 是被删的那条
 *   · ok:false / not-found      卡里没这条
 *   · ok:false / archive-failed 归档没写进去，记录**仍在卡里**，card.updatedAt 未变
 */
export function forgetRecord(card, id, archive, now = Date.now()) {
  const index = card.records.findIndex((item) => item.id === id)
  if (index < 0) return { ok: false, error: 'not-found' }
  const record = card.records[index]
  const { archived } = archiveAll([record], archive, 'manual-forget', now)
  if (archived.length !== 1) return { ok: false, error: 'archive-failed', record }
  card.records.splice(index, 1)
  card.updatedAt = iso(now)
  return { ok: true, record }
}


// ---- 衰减与压缩 ----

/**
 * 每日遗忘整理。
 *
 * 三个关键点：
 *   ① 一天只跑一次（lastDecayDate 挡着），反复跑会把记忆加速抹掉；
 *   ② 一次只动一格，所以是「慢慢模糊」；
 *   ③ 支持 steps（补跑）：DSH 关了一周，回来最多补 30 天，而不是从原处慢慢爬。
 */
export function applyDecay(card, config = {}, now = Date.now(), { force = false, steps = 1, archive = null } = {}) {
  const cfg = normalizeConfig(config)
  const today = dateKey(now)
  if (!force && card.lastDecayDate === today) return { changed: false, forgotten: [] }

  const passes = clamp(Math.round(Number(steps) || 1), 1, 30)
  // R01：遗忘候选先收集、不立刻从卡里丢掉。归档成功才真删。
  const forgottenCandidates = []
  const seenForgotten = new Set()
  let changedClarity = 0
  let changed = false

  for (let pass = 0; pass < passes; pass += 1) {
    let passChanged = false
    const keep = []
    for (const record of card.records) {
      const current = CLARITY_ORDER.includes(record.clarity) ? record.clarity : 'clear'
      const currentIndex = CLARITY_ORDER.indexOf(current)
      const target = targetClarity(record, cfg, now)
      const targetIndex = CLARITY_ORDER.indexOf(target)
      if (targetIndex > currentIndex) {
        const next = CLARITY_ORDER[currentIndex + 1]
        if (next === 'forgotten') {
          // 同一条只收一次；之后的 pass 再遇到它不再算「这一轮有变化」
          if (!seenForgotten.has(record)) {
            seenForgotten.add(record)
            forgottenCandidates.push(record)
            passChanged = true
          }
          keep.push(record) // 先留着，等归档结果
          continue
        }
        record.clarity = next
        changedClarity += 1
        passChanged = true
      } else if (targetIndex < currentIndex) {
        // 最近被提起 / 重要记忆：一天也只恢复一档
        record.clarity = CLARITY_ORDER[currentIndex - 1]
        changedClarity += 1
        passChanged = true
      }
      keep.push(record)
    }
    card.records = keep
    if (!passChanged) break
  }

  // R01：归档（先）→ 只有成功的才从卡里移除（后）。失败的原样留在卡里，
  // 下次 maintain 会再试一次；不在这里引入节流或重试队列（那是 R04 的事）。
  const write = typeof archive === 'function' ? archive : makeArchiver(archivePath())
  const { archived } = forgottenCandidates.length > 0
    ? archiveAll(forgottenCandidates, write, 'decay', now)
    : { archived: [] }
  if (archived.length > 0) {
    const gone = new Set(archived)
    card.records = card.records.filter((record) => !gone.has(record))
  }

  // changed 只在「确实发生了别的变化」时为 true：全部归档失败时记录还在、
  // 清晰度没动，不能让统计说「已经衰减 / 遗忘了」。
  changed = changedClarity > 0 || archived.length > 0
  card.lastDecayDate = today
  if (changed) {
    card.stats.decayed = (Number(card.stats.decayed) || 0) + 1
    card.stats.lastDecayAt = iso(now)
    card.stats.forgotten = (Number(card.stats.forgotten) || 0) + archived.length
    card.updatedAt = iso(now)
  }

  // 2026-11-06 审计 P1-4：遗忘必须在**引擎里**留档，不能指望调用方。
  // 默认归档器指向真实的 archive.jsonl；调用方仍然可以传自己的 archive
  // （maintain 传的就是那个，行为不变）。R01 起返回值只含真正归档成功的那些。
  return { changed, forgotten: archived }
}


/** 上次整理到现在过了几天（用于补跑；最多 30 天）。 */
export function daysSince(lastDate, now = Date.now()) {
  if (typeof lastDate !== 'string' || lastDate === '') return 1
  const from = Date.parse(`${lastDate}T00:00:00`)
  if (!Number.isFinite(from)) return 1
  return clamp(Math.floor((now - from) / DAY_MS), 1, 30)
}


/**
 * 容量压缩：从最不重要、最老、最模糊的开始降档，降到 trace 的才真删。
 * pinned / isInitial / 高重要度主人记忆永不淘汰。
 *
 * @param archive 可选，`(record, reason, now) => void`。传了就把真删掉的记录写进遗忘档案。
 *   这一步是**程序自己腾空间**删的，用户根本没动手 —— 不记档的话
 *   「她怎么把这件事忘了」永远查不出来。
 */
export function compactCard(card, config = {}, { targetRatio = 0.85, now = Date.now(), archive = null, maxTouchRatio = 0.3 } = {}) {
  const cfg = normalizeConfig(config)
  const budget = cfg.warnChars > 0 ? cfg.warnChars : Math.max(2000, cfg.injectMaxChars * 6)
  const targetChars = Math.max(600, Math.floor(budget * clamp(targetRatio, 0.3, 0.95)))

  // 2026-11-04 修 B5 的另一半：先把 forgotten 清干净，别让它参与预算博弈。
  //
  // renderCard 的 sectionize 会**跳过** forgotten —— 它们在注入里一个字符都不占。
  // 可它们又进了 candidates，排序还排在最前（清晰度降序），于是每轮压缩都先拿它们开刀：
  // 删掉不省字符（不占预算），却照样消耗「单次最多动 N 条」的配额。
  // 实测 40/60 条 forgotten 的卡：删了 18 条、字数 3503→3503，一次压缩零收益。
  //
  // 它们已经是「遗忘」状态，该清理，但不是「压缩」的对象。放在预算计算之前做，
  // 清完再算 before（renderCard 本来就不含它们，所以数字不变，只是配额不再被白吃）。
  const invisible = card.records.filter((record) => record.clarity === 'forgotten')
  // R01：先归档、只删归档成功的那些。归档失败时 cleanedCount 必须为 0，
  // 否则会出现「记录还在、统计说清掉了」的新不一致。
  let cleanedCount = 0
  if (invisible.length > 0) {
    const { archived } = archiveAll(invisible, archive, 'compact', now)
    cleanedCount = archived.length
    if (cleanedCount > 0) {
      const gone = new Set(archived)
      card.records = card.records.filter((record) => !gone.has(record))
    }
  }

  const before = renderCard(card, { config: cfg, now, full: true }).length
  // 2026-11-04：这里必须返回 cleanedCount 而不是 0。
  // maintain 只在返回值 > 0 时 saveCard（store.js），返回 0 = 上面那批 forgotten
  // 只从内存里删掉了、没落盘 —— 重启后它们回来，然后每次启动又往 archive.jsonl
  // 写一遍同一批（档案会重复膨胀，而且是持续恶化的那种）。
  if (before <= targetChars) return cleanedCount

  const candidates = card.records.filter((record) => record.pinned !== true
    && record.isInitial !== true
    && !ownerImportant(record, cfg))
  // 2026-11-04 第二次修：这里原来 return 0 —— 但上面那批 forgotten 已经删掉了。
  // 整卡都是 pinned / 初始记忆 / 主人重要记忆时，candidates 必然是空的，
  // 于是「删了东西」这件事传不出去，调用方不存盘 → 磁盘上还在 → 重启后又删一遍、
  // 又归档一遍（档案重复膨胀，删除白做）。返回 cleanedCount 才是事实。
  if (candidates.length === 0) return cleanedCount

  // 一次排序（重要度低 → 老 → **越模糊越先动**）。
  // 2026-11-01 审计 A2：原来每个 step 都 candidates.sort + renderCard(full) 重渲染整卡，
  // 600 条的卡要循环几百次、845ms，而且一条要连降四档才删 —— 一次压缩丢掉 83% 的记忆。
  // 现在只有一次排序 + 一次渲染，之后按「这一行省下多少字符」线性推进。
  //
  // 旧排序的清晰度用的是 indexOf 升序，等于 vivid 排最前、最先被删 —— 和注释写的
  // 「从最模糊的开始」正相反。这里改成降序（trace 先）。
  candidates.sort((a, b) => {
    const byImportance = (Number(a.importance) || 0) - (Number(b.importance) || 0)
    if (byImportance !== 0) return byImportance
    const byAge = timeOf(a.createdAt, 0) - timeOf(b.createdAt, 0)
    if (byAge !== 0) return byAge
    return CLARITY_ORDER.indexOf(b.clarity) - CLARITY_ORDER.indexOf(a.clarity)
  })

  // 单次上限：一次丢掉大半张卡不是"慢慢忘"，是"失忆"。
  // 超预算的卡在注入时本来就会被 renderCard 的分区限额挡住，所以宁可多跑几轮。
  const cap = Math.max(5, Math.min(200, Math.ceil(candidates.length * clamp(maxTouchRatio, 0.02, 1))))
  let chars = before
  let touched = 0
  const removed = []

  for (const victim of candidates) {
    if (chars <= targetChars || touched >= cap) break
    touched += 1
    // 一条一条地处理（和旧算法一样：同一条连降到 trace 才删），
    // 但每一步都先看预算够没够 —— 只是变短就够了的话，这条就留住。
    let line = recordLine(victim, { full: true }).length + 3
    // 2026-11-04 修 B5：这条一开始是不是「看得见」的。
    // `before`（以及这里的 chars）来自 renderCard，而 renderCard 的 sectionize
    // **会跳过 forgotten** —— 这类记录从来没被计入预算。删掉它却在这里 `chars -= line`，
    // 等于虚报「省下了一大段」：实测 60 条里 20 条 forgotten，渲染 6843 字一个字没少，
    // 却判定压缩到预算了，30% 的配额全花在看不见的记录上，容量压缩被无限推迟。
    const wasVisible = victim.clarity !== 'forgotten' && CLARITY_ORDER.indexOf(victim.clarity) >= 0
    let gone = false
    let stalled = false
    while (gone === false) {
      // 2026-11-04 修死循环：这个循环原来只在 clarity==='trace' 时退出，
      // 其余情况一律 stepDown + 算长度。可 stepDown 对 'forgotten'
      //（以及任何不在 CLARITY_ORDER 里的脏值）**返回 true 却不改值** ——
      // 于是 chars 不减、clarity 不变，while 永远转下去。
      //
      // 而 compactCard 是**在注入路径上同步跑的**：真实卡里现在没有 forgotten
      // 所以从没炸过，但只要哪天出现一条（用户手改、旧版本迁移、导入），
      // 整个注入就会卡死，表现是「设置页能开、但每轮对话都无响应」。
      //
      // 判据就一条：**这一轮必须真的改变了什么**（降了档，或者缩短了行）。
      // 改不动就立刻退出，不留「理论上会退出」的循环。
      const rank = CLARITY_ORDER.indexOf(victim.clarity)
      if (victim.clarity === 'trace') {
        stepDown(victim) // trace → forgotten
        gone = true
        break
      }
      if (rank < 0 || rank >= CLARITY_ORDER.length - 1) {
        // 已经是 forgotten，或者是认不出的值
        if (victim.clarity === 'forgotten') {
          // 遗忘状态的记录本来就不该留在卡里（sectionize 会跳过它），清掉
          gone = true
        } else {
          // 陌生值不敢动 —— 既不知道它离遗忘多远，也不该替用户删数据。
          // 跳过这一条，继续处理下一条。
          stalled = true
        }
        break
      }
      stepDown(victim)
      const next = recordLine(victim, { full: true }).length + 3
      const shortened = Math.max(0, line - next)
      chars -= shortened
      line = next
      if (chars <= targetChars) break
    }
    if (gone === true) {
      removed.push(victim)
      // 只有本来被计入 chars 的行才扣 —— 见上面 wasVisible 的注释
      if (wasVisible) chars -= line
    }
    if (stalled === true) {
      // 没动它，就不该占这次的配额
      touched -= 1
      note('memory', `压缩时跳过一条清晰度认不出的记录（clarity=${String(victim.clarity)}），不敢替用户删`)
    }
  }

  // R01：同上，removed 只是「候选」，只有归档成功的才真从卡里移除。
  // 归档失败的仍留在卡里（清晰度已被降到 forgotten），下一轮会再试一次，
  // 但**不会**每跑一次就少几条 —— 失败不删，记录数收敛。
  let archivedRemoved = []
  if (removed.length > 0) {
    const result = archiveAll(removed, archive, 'compact', now)
    archivedRemoved = result.archived
    if (archivedRemoved.length > 0) {
      const gone = new Set(archivedRemoved)
      card.records = card.records.filter((record) => !gone.has(record))
    }
  }

  if (touched > 0 || cleanedCount > 0) {
    card.stats.compacted = (Number(card.stats.compacted) || 0) + (touched > 0 ? 1 : 0)
    // 统计只算真删掉的：归档失败留下的记录不能算进 forgotten
    card.stats.forgotten = (Number(card.stats.forgotten) || 0) + archivedRemoved.length + cleanedCount
    card.updatedAt = iso(now)
    // 压缩是静默操作，必须留一行日志：事后"她怎么把这件事忘了"只能靠它查。
    note('memory', `压缩动 ${touched} 条（上限 ${cap} / 候选 ${candidates.length}），真删 ${archivedRemoved.length} 条`
      + `，顺带清理 ${cleanedCount} 条已遗忘`
      + `，字符 ${before} → ${Math.max(0, chars)}（目标 ${targetChars}）`)
  }
  return touched + cleanedCount
}
