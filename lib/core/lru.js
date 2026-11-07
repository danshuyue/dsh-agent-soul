/**
 * 有界 Map：只淘汰最旧的，不整体清空。
 *
 * 2026-11-07 R9 / P2-10。原来全仓库有 8 处这样写：
 *
 *   if (map.size > 200) map.clear()
 *
 * 看着像「防止内存无限增长」，实际后果是**集体失忆**：第 201 个会话出现的瞬间，
 * 另外 200 个会话的游标、去重表、注入记录全部作废 —— 它们下一轮会被当成新会话：
 *   · 重注人格（多花一份 token）
 *   · 去重表失效（同一段记忆被再注入一次）
 *   · 游标清空 → **从头重扫全量事件**（extract 那条更糟：丢掉在途的批）
 *
 * 正确做法是只淘汰最旧的那几条。这里给两个最小 API：
 *   · trimMap(map, max)         —— 超限时按插入顺序淘汰最旧的，直到不超
 *   · touchMap(map, key)        —— 把 key 挪到队尾（读一次也算「最近用过」）
 *
 * 为什么不在这一轮改成真正的 LRU：`trimMap` 是一行替换，风险接近零；
 * 而把 8 处调用点全改成「读也刷新」需要逐个确认语义（有些 Map 的读是批量的，
 * 刷新顺序会改变淘汰结果）。先止血，再谈精确。
 */

/** 超过上限时按插入顺序淘汰最旧的键，直到不超。返回淘汰了几个。 */
export function trimMap(map, max) {
  if (map === null || map === undefined || typeof map.keys !== 'function') return 0
  const limit = Math.max(0, Math.trunc(Number(max) || 0))
  let dropped = 0
  // 多淘汰一小批（比如 10%），避免「每加一个就淘汰一个」变成每次都要走一遍
  while (map.size > limit) {
    const oldest = map.keys().next()
    if (oldest.done === true) break
    map.delete(oldest.value)
    dropped += 1
  }
  return dropped
}

/** 把 key 挪到队尾（最近使用）。key 不存在时什么都不做。 */
export function touchMap(map, key) {
  if (map === null || map === undefined || typeof map.has !== 'function') return false
  if (!map.has(key)) return false
  const value = map.get(key)
  map.delete(key)
  map.set(key, value)
  return true
}
