/**
 * api.js —— 设置页用的同源 HTTP 接口。
 *
 * 为什么走同源 HTTP 而不是 RPC：
 *   浏览器半侧只要能 fetch 就能用，不需要理解宿主的 RPC 协议；
 *   而且插件被卸载/重装时，页面顶多拿到 404，不会把宿主会话搞坏。
 *
 * 路由（前缀 /api/soul）：
 *   GET  /state          配置 + 人格来源 + 记忆统计 + 目的摘要 + 心情摘要（页面首屏一次拿全）
 *   POST /config         保存配置
 *   GET  /persona        读人格文件
 *   POST /persona        写人格文件
 *   GET  /memory         列记忆（?scope=global|project&cwd=...&query=...）
 *   POST /memory         增 / 改 / 删一条记忆
 *   POST /maintain       手动跑一次衰减与压缩
 *   GET  /mood           心情全量（值 + 七情 + 时间线）
 *   POST /mood/reset     重置心情
 *   POST /mood/decay     手动跑一次时间衰减
 *   POST /diary          手动触发日记（{ date?: "YYYY-MM-DD", note?: "备注" }）
 *   GET  /diary/list     日记列表（最近 N 天，公开日记带预览，私密只报存在性）
 *   GET  /diary/read     读某一天的日记（公开全文，私密只报存在性）
 *   GET  /diary/private  读私密正文（2026-10-31；仅回环 + diaryPrivateVisible=true）
 *   GET  /diary/sessions 可选会话列表（设置页的日记会话下拉用，最多 50 条）
 *   POST /diary/bind     把会话绑定成日记会话（{ sessionId? }，缺省取当前会话）
 *   POST /diary/unbind   清除日记会话绑定
 */
  // 2026-11-04：/config 的键白名单要用它（只允许写入声明过的配置项）

/**
 * 公共 API 门面：实现已迁到 lib/http/，这里固定对外导出集合，
 * 是宿主与测试唯一稳定的 import 路径，**永久保留，不再删除**。
 * 内部模块可任意重组；改这里的导出必须同步 tests/contract/exports.snapshot.json
 * 并带 SOUL_SNAPSHOT_REASON 留痕（门禁见 exports.snapshot.test.js）。
 */
export { API_PREFIX, ASSET_PREFIX } from './http/constants.js'
export { isLoopbackRequest, privateDiaryView, shouldAllowApiRequest, validateConfigEntry } from './http/middleware.js'
export { pickFolder, registerApi, registerAssets } from './http/server.js'
