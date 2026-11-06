/**
 * llm-stream.js —— 宿主 LLM 流的统一消费器（P2-11，2026-11-05）。
 *
 * 原来 refine / mood / diary 四处各写一份同构的 `Promise.race([consume, timeout])`：
 * 超时后 `consume` 这个 IIFE **仍在后台把流跑完**，`consume.catch(() => {})` 只是
 * 吞掉晚到的 rejection。注释里也承认了「后台那条流会自己结束，只是结果不再采用」。
 * 后果是：模型挂起时每一轮都留一条永不结束的流，网络请求、内存和宿主并发额度
 * 一起被慢慢吃光；而调用方拿到 null 之后下一轮照样再开一条。
 *
 * 这一版把竞速点从「整个 IIFE」下沉到 **`iterator.next()`**：
 *   - 流不吐字（正是要防的「网络挂起 / provider 卡住」）时也能按时返回；
 *   - 超时/出错后**不再发起下一次 `next()`**，并主动调 `iterator.return()` 通知宿主关闭；
 *   - 晚到的 `next()` rejection 显式挂 catch，不再靠调用方各自吞。
 * 相比旧版，超时后不会再「后台把整条流跑完并继续拼接正文」，也不会继续占着
 * 宿主的吐字通道。
 *
 * ⚠️ 边界（实测过，别写成「真取消」）：`return()` 的效果分两种宿主实现 ——
 *   - 自定义 async iterable（`return()` 是独立方法）→ **立即关闭生效**，实测 closed=1；
 *   - async generator 且卡在 `await iterator.next()` 内部 → `return()` 会**排队**等前一条
 *     `next()` 完成，那个 `finally` 根本不执行（实测 finallyHit=0 / returnResolved=false）。
 *     此时只能保证「插件侧不再消费」，等宿主那条 `next()` 万一恢复，排队的 `return()`
 *     会在后续 yield 之前把它关掉。
 * 底层 HTTP 请求是否真 abort，完全取决于宿主；本仓库看不见也控制不了。要 100% 真取消
 * 必须宿主支持 `signal` —— 下面留了钩子：调用方传入 `options.signal` 时会一并放进
 * `llm.stream` 的参数，宿主将来支持即自动生效，当前四处调用都不传，对旧宿主零行为变化。
 *
 * 本模块不写日志（风格同 prompt-guard.js）：所有失败以结构化结果返回，由调用方
 * 决定记哪一条日志、走哪条降级。对外**永不 reject**。
 */

const DEFAULT_TIMEOUT_MS = 30_000
/**
 * 2026-11-06 第二份审查 H-1：消费点的硬上限。
 * 配置里的超时已经被 `/config` 卡过一次，但配置可以被手改、被旧版本留下、被备份还原；
 * 一旦是 1e12（≈31.7 年），这个 await 就等于永远不返回，而它挂在日记/心情的链上。
 */
const MAX_TIMEOUT_MS = 300_000
/** 等迭代器自己收尾的宽限：宿主若在 finally 里 await 一个挂起的清理，别把调用方拖住。 */
const CLOSE_GRACE_MS = 200

/**
 * 关掉异步迭代器。返回是否真的调到了 `return()`。
 * 故意不无限 await：清理逻辑挂起时，宁可留下宿主侧的资源，也要让本轮按时降级。
 */
async function closeIterator(iterator) {
  if (typeof iterator?.return !== 'function') return false
  let grace = null
  try {
    const closing = Promise.resolve(iterator.return())
    closing.catch(() => {})
    await Promise.race([
      closing,
      // 这个 timer 正被 await，必须保持事件循环存活 —— 不能像超时 timer 那样 unref()，
      // 否则只剩它一个 handle 时 Node 会判定「没有活活儿」直接退出（实测退出码 13）。
      new Promise((resolve) => { grace = setTimeout(resolve, CLOSE_GRACE_MS) })
    ])
  } catch {
    /* 宿主清理自己抛错，不影响我们返回降级值 */
  } finally {
    if (grace !== null) clearTimeout(grace)
  }
  return true
}

/**
 * 消费一次宿主 LLM 流。
 *
 * @param {{ stream: Function }} llm 宿主注入的 llm 服务
 * @param {object} params 原样传给 `llm.stream(params)` 的参数对象
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 * @returns {Promise<{
 *   ok: boolean,          // 流完整走完且模型没报 error finish
 *   text: string,         // 已拼接的 text-delta 正文（失败时保留已收到的部分）
 *   finishReason: object|null,
 *   timedOut: boolean,
 *   error: string,        // 供日志用的失败原因；模型自己报 finish 时为空串
 *   closeRequested: boolean // 异常路径上是否调用了迭代器 return()（不代表已关闭）
 * }>}
 */
export async function consumeLlmStream(llm, params, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const result = {
    ok: false,
    text: '',
    finishReason: null,
    timedOut: false,
    error: '',
    closeRequested: false
  }

  if (!llm || typeof llm.stream !== 'function') {
    result.error = '宿主没有可用的 llm 服务（llm.stream 不可用）'
    return result
  }

  // 2026-11-06 第二份审查 H-1 第二道：配置校验在入口，这里再夹一次。
  // 配置可以被手改、被旧版本留下、被备份还原 —— 一旦是 1e12，这里就会等 31 年。
  const limit = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.trunc(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)))
  // signal 是给「宿主将来支持真取消」预留的钩子；不传时参数对象逐字节等同旧版。
  const streamParams = signal ? { ...params, signal } : params

  let iterator
  try {
    const stream = llm.stream(streamParams)
    if (!stream || typeof stream[Symbol.asyncIterator] !== 'function') {
      result.error = 'llm.stream 没有返回异步可迭代对象'
      return result
    }
    iterator = stream[Symbol.asyncIterator]()
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error)
    return result
  }

  // 整个消费过程共用一个 deadline，语义与原来的「整体超时」一致。
  let timer = null
  let timedOut = false
  const timeout = new Promise((_resolve, reject) => {
    // 故意不 unref()：这条 timer 正被下面的 race 等待，是「按时返回」的唯一保障。
    // 旧四份模板都写了 timer.unref()，在宿主里有 HTTP server 兜着看不出问题，但纯脚本
    // 调用（工具、测试、CLI）里流一挂起，Node 会判定没有活跃 handle 直接退出 ——
    // 实测退出码 13 + "Detected unsettled top-level await"。finally 里会 clear，不泄漏。
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`LLM 流超时（超过 ${limit} ms）`))
    }, limit)
  })
  // race 已经 settled 之后 timeout 仍可能 reject，先挂住避免 unhandledRejection。
  timeout.catch(() => {})

  try {
    for (;;) {
      const next = Promise.resolve().then(() => iterator.next())
      // 超时后这条 next() 还在 pending，晚到的 rejection 必须由我们自己消化。
      next.catch(() => {})
      const step = await Promise.race([next, timeout])
      if (step.done === true) break

      const chunk = step.value
      if (!chunk) continue
      if (chunk.type === 'text-delta') result.text += chunk.text
      if (chunk.type === 'finish' && chunk.reason && chunk.reason.kind === 'error') {
        // 模型自己报错（鉴权失败 / 上下文超长 / 适配器拒绝）：原来 consume 返回 false，
        // 调用方直接 return null、不记「调用失败」日志。保持这个区分。
        result.finishReason = chunk.reason
        result.closeRequested = await closeIterator(iterator)
        return result
      }
    }
    result.ok = true
    return result
  } catch (error) {
    if (timedOut) {
      result.timedOut = true
      result.error = `LLM 流超时（超过 ${limit} ms），已关闭迭代器`
    } else {
      result.error = error instanceof Error ? error.message : String(error)
    }
    result.closeRequested = await closeIterator(iterator)
    return result
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

/** 测试钩子：让回归用例能验证「没有定时器泄漏」。 */
export function __llmStreamDefaultsForTest() {
  return { DEFAULT_TIMEOUT_MS, CLOSE_GRACE_MS }
}
