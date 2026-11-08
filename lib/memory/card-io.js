/**
 * 记忆引擎 · card-io.js
 * 由 lib/memory.js 按职责拆出（2026-11-06 模块化重构），函数体保持原样。
 */
import { MEMORY_VERSION } from './constants.js'
import { appendFileSync, chmodSync, closeSync, copyFileSync, existsSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync } from 'node:fs'
import { atomicWrite } from '../paths.js'
import { basename, dirname, join } from 'node:path'
import { countCardWriteFailure, note, noteThrottled } from '../env.js'
import { trimMap } from '../core/lru.js'
import { iso } from './signals.js'
import { legacyKindOf, normalizeCard } from './card.js'

/** 迁移失败后的重试退避表（file → 下次允许尝试的时间戳）。2026-11-08 KNOWN-ISSUES #5。 */
const migrationRetryAfter = new Map()
const MIGRATION_RETRY_MS = 5 * 60 * 1000

/**
 * 本进程成功写过的卡（file → 写盘后的 mtimeMs）。2026-11-08 KNOWN-ISSUES #3。
 * saveCard 备份前原来总要用 readCardJson 完整解析一次旧文件，只为判断「能不能备份」；
 * 自己刚写成功的文件必然可解析，mtime 没被别人动过就直接信任，省掉每次写入的全量解析。
 */
const selfWrittenCards = new Map()
const SELF_WRITTEN_MAX = 200

/** 读文件的 mtimeMs，读不到返回 NaN（视为「被别人动过」）。 */
function mtimeMsSafe(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return NaN
  }
}


/**
 * 损坏保护（2026-11-01，审计 A1）。
 *
 * 旧行为：解析失败直接返回 null，注释写着「调用方新建，不覆盖原文件」——
 * **这个承诺从来没人兑现**。调用方（store.loadCached）拿到 null 就兜底成
 * createCard() 空卡并缓存，接着任何一次写入（自动提取、维护、手写记忆）都会
 * 拿这张空卡 atomicWrite 回去，原记录整份消失，连个 .bak 都没有。
 * BOM 那次只是"读不到"；这次是"读到空卡再写回去"，比那次狠。
 *
 * 新行为分两种结局，取决于能否把原文件挪走：
 *   · 能挪 → 重命名为 `<file>.corrupt-<时间戳>`，数据留在盘上，程序用新空卡继续跑
 *   · 挪不动（权限/占用）→ 该文件进入**只读模式**，后续 saveCard 一律跳过写入，
 *     宁可这一轮记不进新记忆，也不拿空卡盖掉可能还能救的原文件
 *
 * 只读状态在内存里，进程重启后重新判断；UI 通过 corruptInfoOf / listCorruptBackups 亮红。
 */
/**
 * R01 / T3：与 memory/card.js 的 revOf 同口径（不新增公共导出，见 03 答复 §3.3）。
 * 写盘前算出「这一版」，成功保留、失败连内存一起回退。
 */
function revOf(raw) {
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER)
}

const corruptState = new Map()


/** 这张卡当前是否处于只读（上次读取受损且安全备份失败）。 */
export function isCardReadonly(file) {
  return corruptState.get(file)?.readonly === true
}


/** 读取失败留下的现场（备份路径 / 原因 / 时间），没坏过返回 null。 */
export function corruptInfoOf(file) {
  const hit = corruptState.get(file)
  return hit === undefined ? null : { ...hit }
}


/** 把坏文件挪到 .corrupt-<时间戳>；挪不动就转只读。返回给 note 用的描述。 */
function parkCorrupt(file, reason) {
  const stamp = iso().replace(/[:.]/g, '-')
  const backup = `${file}.corrupt-${stamp}`
  try {
    renameSync(file, backup)
    corruptState.set(file, { backup, at: iso(), reason, readonly: false })
    return `原文件已另存为 ${basename(backup)}`
  } catch (error) {
    corruptState.set(file, { backup: null, at: iso(), reason, readonly: true })
    return `备份失败（${error?.message ?? error}），该卡进入只读模式`
  }
}


/**
 * **无副作用**地读一张卡：不迁移、不备份、不置只读、不动 corruptState。
 *
 * 2026-11-07 R8 / P2-12：合并路径以前调 `loadCard`，而 `loadCard` 的 catch
 * 会 `parkCorrupt` —— 把**主记忆文件改名成 `.corrupt-*` 并置只读**。
 * 于是「写之前看一眼盘上有没有更新」这个动作，在遇到一次瞬时读失败时
 * （Windows 文件被占、杀软扫描）会把用户的记忆整个挪走，随后写盘往空路径写新卡 ——
 * 用户看到的是「记忆突然清空」，而备份还在那儿没人知道。
 *
 * 这条路径只需要「读到就读到，读不到当没有」，不需要抢救现场。
 * 抢救是 `loadCard` 的事，只应该发生在真正的加载路径上。
 *
 * @returns {object|null} 解析好的卡；读不到 / 坏了 / 不存在都返回 null
 */
export function readCardQuietly(file) {
  try {
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    return normalizeCard(raw)
  } catch {
    return null
  }
}


/** 读盘 + 结构收敛。坏文件先落备份再返回 null；备份不了则进入只读。 */
export function loadCard(file) {
  try {
    if (!existsSync(file)) return null
    // 2026-10-30：去掉 UTF-8 BOM 再解析。
    // 实测 ~/.dsh/agents/memory/projects/work-*.json 被 PowerShell 的 ConvertTo-Json
    // 手工改过，文件头带 BOM —— JSON.parse 直接抛，loadCard 返回 null，
    // 注入把卡当空卡、下一次维护再存盘就把用户的记录整份抹了。
    // 迁移（kind）也走这里，读不进老卡等于迁移没发生。
    const raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    const card = normalizeCard(raw)
    corruptState.delete(file) // 本次读得通，之前留下的只读/损坏标记作废
    // 一次性迁移（2026-10-30，v1 → v2）：老记录补 kind 后写回。
    // 只补 kind，其它字段原样保留 —— 迁移不该让一条记忆"变新"或换 id。
    // 失败（只读目录 / 文件被占用）就跳过：内存里的卡已经是对的，不影响这次读取。
    if (raw !== null && typeof raw === 'object' && (Number(raw.version) || 1) < MEMORY_VERSION
      // 2026-11-08 KNOWN-ISSUES #5：迁移失败原来每次 loadCard 都重试 —— 而迁移写盘
      // 会改 mtime，readThrough 的缓存 stamp（load 前取的）从此永远失配，等于每回合
      // 一次失败写 + 一条日志。现在失败后退避 5 分钟；日志走 noteThrottled 分频。
      && (migrationRetryAfter.get(file) ?? 0) <= Date.now()) {
      try {
        const patched = { ...raw, version: MEMORY_VERSION }
        patched.records = (Array.isArray(raw.records) ? raw.records : []).map((item) => (
          // v1 卡上的 kind 一律重新过一遍 legacyKindOf（含旧的 'event' 默认值），
          // 不然写回文件的和内存里的会不一致，下次加载（v2）又翻回 event。
          item !== null && typeof item === 'object' ? { ...item, kind: legacyKindOf(item) } : item
        ))
        const migrated = atomicWrite(file, `${JSON.stringify(patched, null, 2)}\n`)
        if (migrated?.ok === true) {
          migrationRetryAfter.delete(file)
        } else {
          migrationRetryAfter.set(file, Date.now() + MIGRATION_RETRY_MS)
          trimMap(migrationRetryAfter, 200)
          noteThrottled('memory', `migrate:${basename(file)}`, `⚠️ v1→v2 迁移写盘失败（5 分钟内不再重试）：${migrated?.error ?? '未知原因'}`)
        }
      } catch (error) {
        migrationRetryAfter.set(file, Date.now() + MIGRATION_RETRY_MS)
        trimMap(migrationRetryAfter, 200)
        noteThrottled('memory', `migrate:${basename(file)}`, `⚠️ v1→v2 迁移写盘失败（5 分钟内不再重试）：${error instanceof Error ? error.message : error}`)
        /* 写不进去就算了，退避窗口过后还会再试（迁移本身是幂等的） */
      }
    }
    return card
  } catch (error) {
    // 2026-11-01 审计 A1：这里原来就一句 return null，等于把「读坏了」和
    // 「本来就没有」混成一件事，调用方分不清，于是拿空卡盖掉了还能救的文件。
    // 现在先把现场保住（重命名 / 转只读），再返回 null 让调用方建新卡。
    const reason = String(error?.message ?? error)
    // ⚠️ note(tag, message) 是两个参数：单参数的写法会让日志行末尾多一个 undefined
    const where = parkCorrupt(file, reason)
    note('memory', `读不出 ${basename(file)}（${reason}）—— ${where}`)
    return null
  }
}


/**
 * 存盘。
 *
 * 2026-11-04 修 ①：**返回值改成 { ok } 这样的结果**，不再只回传 card。
 * 原来的问题：写盘失败只记一行日志，调用方（extract 的游标、API 的「已保存」）
 * 完全看不出来，于是「这轮的新记忆没进磁盘」被当成写成功继续往下走。
 * 现在调用方能拿到 ok:false 做正确的事（不推游标 / 回非 200）。
 */
export function saveCard(file, card) {
  // 只读模式（见 parkCorrupt）：宁可这轮记不进新记忆，也不拿空卡盖掉还能救的文件。
  // 不抛异常 —— 这条路径在提示词装配里跑，抛出去会把整个回合炸掉，
  // 那就从「丢记忆」升级成「不回话」了。失败靠 note 日志 + 设置页亮红暴露。
  if (isCardReadonly(file) === true) {
    note('memory', `${basename(file)} 处于只读模式，本次写入已跳过（先人工处理 .corrupt 备份）`)
    countCardWriteFailure()
    return { ok: false, error: '只读模式：上次读取失败且无法安全备份，这轮不写' }
  }
  // 上一版留个单代备份（审计 A1 提到的「无 .bak」）。
  // 只在旧文件**能解析**时才备份：坏文件不该把好备份冲掉。
  //
  // 2026-11-06 审计 P2-10：.bak 里是明文记忆，权限必须和正式文件一致（0600）。
  // copyFileSync 会继承源的权限，但源若是历史遗留的宽权限文件，备份就跟着宽 —— 显式补一次。
  try {
    // 2026-11-08 KNOWN-ISSUES #3：备份前的可解析检查原来**每次写入都全量解析**旧文件。
    // 自己刚写成功的文件（mtime 未被外部改动）必然可解析，直接信任；只有来历不明的
    // 文件（进程首次写它 / mtime 对不上）才走 readCardJson 完整解析。
    const selfStamp = selfWrittenCards.get(file)
    const trusted = selfStamp !== undefined && mtimeMsSafe(file) === selfStamp
    if (existsSync(file) && (trusted || readCardJson(file) !== null)) {
      const backup = `${file}.bak`
      copyFileSync(file, backup)
      try { chmodSync(backup, 0o600) } catch { /* Windows 下不支持，忽略 */ }
    }
  } catch {
    /* 备份失败不影响本次写入本身 */
  }
  card.updatedAt = iso()
  // R01 / T3：一个 rev 增量 = 一次成功持久化。写盘**之前**把新值放进要落盘的
  // 对象；失败则连内存一起回退，绝不出现「rev 变了但盘上没变」。
  const beforeRev = revOf(card.rev)
  card.rev = beforeRev + 1
  let written
  try {
    written = atomicWrite(file, `${JSON.stringify(card, null, 2)}\n`)
  } catch (error) {
    // atomicWrite 的第一步（写 .tmp）也可能抛（目录被删、盘满、权限没了）。
    // 以前这里没有 try —— 抛出去会把提示词装配炸掉。现在收成失败结果，一路往上报。
    written = { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
  if (written?.ok !== true) {
    card.rev = beforeRev
    // 上面那条注释早就写着「失败靠 note 日志暴露」，但 atomicWrite 原来是静默的，
    // 这行日志一直等不到。B10 之后能看见了。
    // 2026-11-04 修 ①：这一行改走分频 —— 磁盘满/卡只读时每个回合都会失败，
    // 逐条记会把 soul.log 刷满，第一次那条真实原因反而找不到。
    noteThrottled('memory', `card-write-${basename(file)}`, `${basename(file)} 写盘失败：${written?.error ?? '未知原因'}（这轮的新记忆没进磁盘；rev 已回退到 ${beforeRev}）`)
    selfWrittenCards.delete(file)
    countCardWriteFailure()
    return { ok: false, error: String(written?.error ?? '未知原因') }
  }
  // 写成功：记下这份文件此刻的 mtime，下次备份前就不用再全量解析它（#3）
  selfWrittenCards.set(file, mtimeMsSafe(file))
  trimMap(selfWrittenCards, SELF_WRITTEN_MAX)
  return { ok: true }
}


/** 只判断「能不能解析」，不落任何副作用（备份轮换用）。 */
function readCardJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}


// ---- 档案件（遗忘的不是消失） ----

/**
 * 把遗忘的记录追加进 JSONL 档案。
 *
 * 为什么还要留档：DSH 里「她忘了某件事」应该是可解释、可追溯的 ——
 * 万一发现某条不该忘，能从档案件里捞回来重新加进去。
 * append-only 也意味着这里永远不会有「写坏整份」的风险。
 */
export function makeArchiver(file) {
  return (record, reason = 'decay', now = Date.now()) => {
    try {
      const line = JSON.stringify({
        archivedAt: iso(now),
        reason,
        record: record ?? null
      })
      // 2026-11-05 S2 / P1-5：归档里是「被忘掉」的记忆正文，同样按 0o600 落盘。
      appendFileSync(file, `${line}\n`, { encoding: 'utf8', mode: 0o600 })
      try { chmodSync(file, 0o600) } catch { /* Windows 忽略 */ }
      return true
    } catch {
      return false
    }
  }
}


/**
 * 档案件里按关键词找（找回来用）。
 *
 * 2026-11-06 P12：启用归档分片后，旧记录在 `archive.jsonl.<时间戳>` 里。
 * 这里把「旧分片（时间正序）→ 当前主文件」的行合并后再倒序取最新，
 * 保证「忘了也能查回来」不因分片而失效。没有分片时与原来逐行等价。
 */
/**
 * 读一个归档文件的**尾部**（2026-11-08 KNOWN-ISSUES #4）。
 * recallArchived 只用最后几百行，原来却把所有分片整文件读进来 —— 分片攒多后
 * 一次「查回」要读几十 MB。分片按文件名正序即内容正序，每个文件只读尾块即可。
 */
function readTailLines(f, bytes = 256 * 1024) {
  let fd
  try {
    const stat = statSync(f)
    const want = Math.min(stat.size, bytes)
    const buf = Buffer.alloc(want)
    fd = openSync(f, 'r')
    readSync(fd, buf, 0, want, stat.size - want)
    const lines = buf.toString('utf8').split('\n').filter((line) => line.trim() !== '')
    // 尾块是从中间开始的：第一行大概率被截成半行，掐掉（半行 JSON.parse 必失败，
    // 与其留给大家猜，不如这里就丢）
    if (want < stat.size && lines.length > 0) lines.shift()
    return lines
  } catch {
    return []
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { /* 关不掉就算 */ } }
  }
}

export function recallArchived(file, query, { limit = 20, maxBytes = 8 * 1024 * 1024 } = {}) {
  try {
    const files = []
    try {
      const dir = dirname(file)
      const prefix = `${basename(file)}.`
      const shards = readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && /^\d{4}-\d{2}-\d{2}T/.test(name.slice(prefix.length)))
        .sort()
      for (const name of shards) files.push(join(dir, name))
    } catch {
      /* 目录读不了就只查主文件 */
    }
    files.push(file)

    const raw = []
    for (const f of files) {
      if (!existsSync(f)) continue
      raw.push(...readTailLines(f))
    }
    if (raw.length === 0) return []
    const tail = raw.slice(-Math.max(100, Math.floor(maxBytes / 200)))
    const term = String(query ?? '').toLowerCase()
    const out = []
    for (const line of tail.reverse()) {
      try {
        const item = JSON.parse(line)
        const text = String(item?.record?.text ?? '')
        if (term !== '' && !text.toLowerCase().includes(term)) continue
        out.push(item)
        if (out.length >= limit) break
      } catch {
        /* 坏行跳过 */
      }
    }
    return out
  } catch {
    return []
  }
}
