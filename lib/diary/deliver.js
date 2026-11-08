/**
 * 日记 · deliver.js（2026-11-10 KNOWN-ISSUES #26：由 scheduler.js 按职责拆出）
 * 投递与回执判定：shouldAskAgain / askAgentToWrite（含 mtimeMsOf）。
 * 「她写没写」的判据是目标文件在不在、mtime 是否新于本轮基线 —— 事故注释在函数体里。
 * 定时器 / 双层锁 / 业务主流程仍在 scheduler.js；会话获取在 agent.js。
 */
import { statSync } from 'node:fs'
import { exists } from '../paths.js'
import { waitForWrite } from './files.js'
import { note, serviceOf } from '../env.js'


/**
 * 投一条消息给绑定会话，让她自己写日记，然后等文件出现（2026-11-04）。
 *
 * ── 回执为什么用「文件出现」而不是 followup 的返回值 ──
 *   2026-10-31 就是栽在这儿：`agent.followup()` **同步返回 void**，旧判据
 *   「没抛异常就算发送成功」对 void 函数恒为真 —— 日志天天报「已发送」，
 *   取证的时候 335 个事件里 `source.kind='schedule'` 零命中，一个 turn 都没进。
 *
 *   官方 schedule 插件靠 `await sessions.flush(agent.session)` 拿回执，但那是从
 *   打包好的 exe 里逆出来的接口，我在这边没法验证它一定存在。而 flush 也只能证明
 *   「消息进了 turn」，证明不了「她把文章写完了」。
 *
 *   所以判据直接取最终事实：**目标文件在不在**。文件在就是写成了，别的一律不算。
 *
 * ── source.kind 为什么是 'schedule' ──
 *   extract.js 会跳过这个来源（不进记忆），mood.js 也跳过（不影响心情），
 *   日记扫描自己也跳过（不进 JSONL）—— 否则「叫她写日记」这件事本身会被
 *   记成一条对话，越滚越多。
 *
 * @returns {{ asked: boolean, wrote: boolean, reason: string }}
 */
/**
 * 文件的 mtime（毫秒）。读不到就返回 0 —— 调用方据此当成「比任何 since 都旧」，
 * 也就是宁可重写一次，也不要把旧文件当成她的新产出。
 */
function mtimeMsOf(file) {
  try {
    return statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * 决定「还要不要再找她写一次」。
 *
 * 2026-11-07 R05 / P1-D3：抽成纯函数，一是给测试一个确定的入口，
 * 二是把这条判断从 followup 的一大段代码里拎出来单独说清楚。
 *
 * - force（手动重写）→ 一定重新写
 * - 文件不存在 → 要写
 * - 文件存在 + since=0（没有时间基线，老调用方）→ 当她已经写过（保持老行为）
 * - 文件存在 + since>0 → 只有比 since 新才算「她这轮写的」，否则是旧文件，重写
 *
 * @param {string} file
 * @param {{ force?: boolean, since?: number }} [options]
 * @returns {boolean} true = 要问她/重写
 */
export function shouldAskAgain(file, { force = false, since = 0 } = {}) {
  if (force === true) return true
  if (!exists(file)) return true
  if (!(since > 0)) return false
  const mtime = mtimeMsOf(file)
  // mtime 读不到（被删/权限）时按「更旧」处理：宁可重写一次，也不要把旧文件当成新产出
  return mtime < since
}

export async function askAgentToWrite(ctx, agent, text, file, timeoutMs, { force = false, since = 0 } = {}) {
  // 已经写过了就别再投 —— 投了也只能等来一个「已存在」的文件，白打扰她一次。
  //
  // 这条必须排在 agent 检查**之前**：否则没绑定会话的时候，哪怕她早就写好了，
  // 也会一路掉进兜底生成，把她写的日记整篇覆盖掉。
  // force（手动重写某一天）时跳过这个判断 —— 那种场景就是要重新写。
  //
  // ── 2026-11-07 R05 / P1-D3：光看「文件在不在」会把旧文件当成她刚写的 ──
  //
  // 事故链：某天有一篇「写于当天最后一句话之前」的半成品（下午手动补的），
  // startupWork 判它不完整 → 决定重写 → 走到这里看到文件存在 → 认为"她写好了"
  // → 记「日记完成」返回 true → 文件没变 → 下一轮仍不完整 → 再走一遍……
  // 结果是**看门狗每 30 分钟空转一次**，而日志里写的是「日记完成」，看起来一切正常，
  // 那段内容永远补不回来。
  //
  // 现在多一个时间判据：`since` = 这一轮开始重写的时间。文件比它旧，就说明是上一轮
  // 留下的旧文件，不能算「她这次写的」。`since` 为 0 时保持老行为（其它调用方不受影响）。
  if (!shouldAskAgain(file, { force, since })) {
    return { asked: false, wrote: true, reason: '' }
  }
  if (exists(file) && force !== true) {
    // 走到这里 = 文件在、但比 since 旧 → 是上一轮留下的旧文件，这次重新问她
    note('diary', `${file} 是旧文件（写于本轮之前），这次重新找她写`)
  }

  if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
    return { asked: false, wrote: false, reason: '没有可投递的会话（followup 不可用）' }
  }

  let message
  try {
    const blocks = [{ type: 'text', text }]
    const llm = serviceOf(ctx, 'llm')
    message = llm !== undefined && llm !== null && typeof llm.createUserMessage === 'function'
      ? llm.createUserMessage({ content: blocks, source: { kind: 'schedule' } })
      : {
          id: `soul-diary-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          role: 'user',
          content: blocks,
          source: { kind: 'schedule' }
        }
  } catch (error) {
    return { asked: false, wrote: false, reason: `构造消息失败：${error instanceof Error ? error.message : error}` }
  }

  // 记下投递前的 mtime，用来判断「是不是这次写出来的」。
  // followup 有可能是**同步**写盘的（插件内部的工具调用可以在同一个 tick 里跑完），
  // 所以投完要立刻看一眼 —— 不能直接交给 waitForWrite：
  // waitForWrite 的语义是「等 mtime 变化」，它进去时会把当前 mtime 当成基线，
  // 文件要是已经写好了，基线就等于完成后的值，于是永远等不到「变化」。
  const mtimeBefore = (() => {
    try {
      return exists(file) ? statSync(file).mtimeMs : 0
    } catch {
      return 0
    }
  })()

  try {
    agent.followup(message)
  } catch (error) {
    return { asked: false, wrote: false, reason: `投递抛异常：${error instanceof Error ? error.message : error}` }
  }

  // 同步就写完的情况：这里直接认，别再去等一个永远不会来的 mtime 变化
  try {
    if (exists(file) && statSync(file).mtimeMs > mtimeBefore) return { asked: true, wrote: true, reason: '' }
  } catch {
    /* 读不到就往下走，交给异步等待 */
  }

  const wrote = await waitForWrite(file, timeoutMs)
  return {
    asked: true,
    wrote,
    reason: wrote ? '' : `等了 ${Math.round(timeoutMs / 1000)} 秒没见她写出文件`
  }
}
