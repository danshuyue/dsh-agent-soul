/**
 * 契约快照变更策略（2026-11-06 P11）。
 *
 * 三条门禁（导出名快照 / 行为 golden / 依赖图）是「零行为变化重构」的硬证据。
 * 但如果有人为了消掉一条红，随手 `SOUL_UPDATE_SNAPSHOT=1` 把基线刷掉，
 * 门禁就形同虚设。所以更新已有快照必须：
 *   ① 在启动环境里写明理由 `SOUL_SNAPSHOT_REASON="..."`；
 *   ② 自动追加到 SNAPSHOT_CHANGES.md —— PR diff 里必然同时出现
 *      「快照变了」和「为什么允许它变」，reviewer 一眼能看见。
 * 首次生成快照不需要理由（那时还没有基线）。
 */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CHANGELOG = 'SNAPSHOT_CHANGES.md'

export function changelogPath(root) {
  return join(root, 'tests', 'contract', CHANGELOG)
}

/** 更新已有快照前调用；缺理由直接以非零退出码终止，绝不写盘。 */
export function requireSnapshotReason(root, snapshotName) {
  const reason = String(process.env.SOUL_SNAPSHOT_REASON ?? '').trim()
  if (reason === '') {
    console.error(`✗ 更新 ${snapshotName} 必须写明理由：`)
    console.error('  SOUL_UPDATE_SNAPSHOT=1 SOUL_SNAPSHOT_REASON="为什么允许这次行为/导出变化" node <测试文件>')
    console.error('  理由会记入 tests/contract/SNAPSHOT_CHANGES.md，随 PR 一起被 review。')
    process.exit(1)
  }
  const file = changelogPath(root)
  if (!existsSync(file)) {
    writeFileSync(file, '# 契约快照变更记录\n\n> 每次更新已有快照都会自动追加一行；没有对应理由的快照变更不应被合并。\n', 'utf8')
  }
  appendFileSync(file, `\n- ${new Date().toISOString()} · ${snapshotName} · ${reason}\n`, 'utf8')
  console.log(`  · 变更理由已记入 tests/contract/${CHANGELOG}`)
  return reason
}
