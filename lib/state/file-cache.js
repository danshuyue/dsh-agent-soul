/**
 * 状态与持久化编排 · 文件 mtime 缓存原语
 *
 * 2026-11-06 P9：之前「按文件 mtime 判缓存」这个模式在四处各写了一遍 ——
 *   loadCached（记忆卡）/ moodState（心情）/ purposeState（目的）/ loadConfig（配置）。
 * 四份实现长得几乎一样，但**写失败后的处理各不相同**：有的清缓存、有的留下新值。
 * 2026-11-05 DSH 复核抓到的「半修 bug」正是从这个分叉里长出来的：
 * savePurposeState / saveMoodState 写盘失败仍清缓存，state 当场回退到磁盘旧值。
 *
 * 现在把「读穿透 / 写后结算 / 失效」收成下面 4 个纯函数，四处调用点只描述
 * 自己的加载与归一化逻辑，不再各自判断 stamp。行为与 P9 前逐项等价：
 *   · 命中条件：存在条目且 stamp 等于当前 mtime（文件不存在时 mtime=0，也能命中）
 *   · 未命中：调用 load(file)，把 {stamp, value} 写回
 *   · 写成功：invalidate（下次按新 mtime 重读）或 settle（直接缓存已知新值）
 *   · 写失败：settle(内存新值, 当前磁盘 mtime) —— 保住内存视图，不回退、不丢改动
 *
 * store 一律是 Map，仍由各模块自己持有并导出（cardCache / moodCache 是公共契约，
 * 不能改成不透明对象）。单值缓存用固定 key 'value'。
 */
import { statSync } from 'node:fs'
import { exists } from '../paths.js'


/** 文件 mtime（毫秒）；文件不存在或读不到一律 0，绝不抛。 */
export function mtimeOf(file) {
  try {
    return exists(file) ? statSync(file).mtimeMs : 0
  } catch {
    return 0
  }
}


/**
 * 读穿透：命中直接返回缓存值，否则 load(file) 并写入缓存。
 * @param {Map} store
 * @param {string} key
 * @param {string} file
 * @param {(file: string) => any} load 只在未命中时调用
 */
export function readThrough(store, key, file, load) {
  const stamp = mtimeOf(file)
  const hit = store.get(key)
  if (hit !== undefined && hit.stamp === stamp) return hit.value
  const value = load(file)
  store.set(key, { stamp, value })
  return value
}


/**
 * 写后结算：把「已知的新值」与文件当前 mtime 绑定。
 * 两种场景都用它 ——
 *   · 写成功：此时 mtime 是刚写完的文件，缓存值与磁盘一致；
 *   · 写失败：此时 mtime 还是旧文件，缓存值是内存里的新状态，
 *     后续读会命中而不是回盘读旧值（不回退），改动留待重试。
 */
export function settle(store, key, file, value) {
  store.set(key, { stamp: mtimeOf(file), value })
}


/** 让某条缓存失效，下次 readThrough 强制重读磁盘。 */
export function invalidate(store, key) {
  store.delete(key)
}


/** 测试用：清空一个缓存。 */
export function clearAll(store) {
  store.clear()
}
