/**
 * 浏览器半侧的加载测试：node tests/client.test.js
 *
 * ── 为什么必须有这个文件 ──
 * 2026-10-28 真事故：client.js 的 factory 里漏了 `var module = { exports: {} }`，
 * `node --check` 全绿（语法合法），但 DSH 一启动就报
 *
 *   web boot: 1 entry did not activate
 *   dsh-agent-soul: import failed: module is not defined
 *
 * 整个桌面应用起不来。这类错误只有「把 factory 真跑一遍」才能抓到，
 * 所以这里 mock 一个最小的 window.__ModuleLoader__ / document / React，
 * 把 bundle 完整执行一次，验证它导出的东西符合宿主期待。
 */
let passed = 0
let failed = 0
function ok(condition, name) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.error(`  ✗ ${name}`)
  }
}
function eq(actual, expected, name) {
  const same = JSON.stringify(actual) === JSON.stringify(expected)
  ok(same, `${name}${same ? '' : `（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`}`)
}

// ---- 伪造宿主环境 ----
const loaded = []
const registeredSlots = []
const effects = []
const effectCalls = []

/**
 * 2026-11-05 修 P1-7：原来 createElement 把函数组件降格成字符串 `type.name`，
 * 函数引用直接丢了 —— 于是「组件首行改成 throw」测试仍 33 过 / 0 败。
 * 现在额外保留 component 引用（type 保持原样，不破坏既有断言），
 * 配合下面的 renderTree 真调用组件。
 * useEffect 记录调度但**不执行回调**：真跑会触发 fetch 链；先钉住「有没有被调度」，
 * 数据流由 s2-hardening.test.js 的契约用例覆盖，别让微任务把测试结果搞成不确定。
 */
const ReactStub = {
  createElement: function (type, props) {
    var children = Array.prototype.slice.call(arguments, 2)
    return {
      type: typeof type === 'function' ? (type.name || 'fn') : type,
      component: typeof type === 'function' ? type : null,
      props: props || {},
      children: children
    }
  },
  useCallback: function (fn) { return fn },
  useEffect: function (fn, deps) {
    effectCalls.push({ fn, deps })
    return function () {}
  },
  useState: function (initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
  useMemo: function (fn) { return fn() },
  useRef: function (value) { return { current: value } },
  Component: function Component() {},
}

/** 递归展开元素树，真正调用每个函数组件；抛错收集到 errors。 */
const renderedComponents = new Set()
function renderTree(node, depth, errors) {
  if (node === null || node === undefined || depth > 3) return
  if (Array.isArray(node)) {
    for (const child of node) renderTree(child, depth, errors)
    return
  }
  if (typeof node !== 'object') return
  if (typeof node.component === 'function') {
    const name = node.component.name || 'anonymous'
    renderedComponents.add(name)
    const props = Object.assign({}, node.props || {})
    const children = node.children || []
    if (props.children === undefined && children.length > 0) {
      props.children = children.length === 1 ? children[0] : children
    }
    try {
      renderTree(node.component(props), depth + 1, errors)
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  for (const child of node.children || []) renderTree(child, depth, errors)
}

globalThis.window = {
  __ModuleLoader__: {
    load: function (definition) {
      loaded.push(definition)
    },
  },
  addEventListener: function () {},
  removeEventListener: function () {},
}
globalThis.document = {
  getElementById: function () { return null },
  createElement: function () { return { id: '', textContent: '', setAttribute: function () {} } },
  head: { appendChild: function () {} },
}
globalThis.fetch = function () {
  return Promise.resolve({ ok: true, status: 200, text: function () { return Promise.resolve('{}') } })
}

// ---- 加载 bundle ----
let loadError = null
try {
  await import('../lib/client.js')
} catch (error) {
  loadError = error
}

console.log('bundle 加载：')
ok(loadError === null, `文件能被执行${loadError === null ? '' : `（${loadError.message}）`}`)
eq(loaded.length, 1, '调用了一次 __ModuleLoader__.load')
const definition = loaded[0] || {}
eq(definition.id, 'dsh-agent-soul', 'id 与插件名一致')
ok(typeof definition.factory === 'function', '有 factory')

console.log('factory 执行（这里是上次崩的地方）：')
let exported = null
let factoryError = null
try {
  exported = definition.factory(function (name) {
    if (name === 'react') return ReactStub
    throw new Error(`意外的 require：${name}`)
  })
} catch (error) {
  factoryError = error
}
ok(factoryError === null, `factory 能跑完${factoryError === null ? '' : `（${factoryError.message}）`}`)

console.log('导出契约：')
ok(exported !== null && typeof exported === 'object', '导出的是对象')
ok(typeof exported?.name === 'string' && exported.name !== '', `有 name（${exported?.name}）`)
eq(exported?.inject, ['slots'], 'inject 声明了 slots（注册设置页要靠它）')
ok(typeof exported?.apply === 'function', '有 apply')

console.log('apply 真跑一次：')
const ctx = {
  effect: function (fn) {
    const disposer = fn()
    effects.push(disposer)
    return disposer
  },
  slots: {
    inject: function (name, factory) {
      registeredSlots.push({ phase: 'inject', name, factory })
    },
    register: function (definition, component) {
      registeredSlots.push({ phase: 'register', definition, component })
      return function () {}
    },
  },
}
let applyError = null
try {
  exported.apply(ctx)
} catch (error) {
  applyError = error
}
ok(applyError === null, `apply 没抛错${applyError === null ? '' : `（${applyError.message}）`}`)

console.log('设置页注册：')
{
  const injectCall = registeredSlots.find((item) => item.phase === 'inject')
  ok(injectCall !== undefined, '往 settings.section 注入了')
  eq(injectCall?.name, 'settings.section', '注入点正确')

  // inject 的回调要真的能产出 register 调用
  const registerResult = injectCall.factory()
  const registerCall = registeredSlots.find((item) => item.phase === 'register')
  ok(registerCall !== undefined, '回调里注册了设置页')
  eq(registerCall?.definition?.name, 'settings.section', 'slot 名对')
  eq(registerCall?.definition?.id, 'soul', 'slot id 是 soul')
  ok(typeof registerCall?.definition?.label === 'function', 'label 是函数（跟随语言）')
  eq(registerCall?.definition?.label(), '灵魂', 'label 显示「灵魂」')
  ok(typeof registerCall?.component === 'function', '提供了组件函数')

  // 真渲染：递归调用组件函数，而不是只看返回值是个对象。
  // 这样「把任一组件首行改成 throw」会立刻变成失败断言。
  const renderErrors = []
  let element = null
  try {
    element = registerCall.component({
      sessionId: 'test',
      cwd: '',
      state: { workspace: { cwd: '' } },
      close: function () {}
    })
  } catch (error) {
    renderErrors.push(`根组件: ${error instanceof Error ? error.message : String(error)}`)
  }
  ok(element !== null && typeof element === 'object', '组件能创建元素')
  renderTree(element, 0, renderErrors)
  ok(renderedComponents.has('ErrorBoundary'), '真调用了 ErrorBoundary（不是只看元素对象）')
  ok(renderedComponents.has('SoulSection'), '真调用了 SoulSection')
  ok(renderedComponents.size >= 3, `递归渲染覆盖了 ${renderedComponents.size} 个组件（≥3）`)
  ok(effectCalls.length > 0, `useEffect 被调度了 ${effectCalls.length} 次（空 stub 时代为 0）`)
  ok(renderErrors.length === 0, `所有被调用的组件都没抛错${renderErrors.length === 0 ? '' : `：${renderErrors.join('；')}`}`)

  // 元测试：故意抛错的组件必须被探针捕获 —— 证明上面这条不是恒真断言。
  function BoomComponent() { throw new Error('元测试故意抛错') }
  const probeErrors = []
  renderTree({ component: BoomComponent, type: BoomComponent, props: {}, children: [] }, 0, probeErrors)
  eq(probeErrors.length, 1, '渲染探针能捕获组件异常（组件里写 throw 不会再全绿）')
  ok(expectedThrowCount(probeErrors, '元测试故意抛错'), '捕获到的正是注入的那个异常')

  ok(registerResult !== undefined, 'inject 回调有返回值')
}

/** 元测试辅助：确认探针抓到的错误内容对得上。 */
function expectedThrowCount(errors, text) {
  return errors.some((line) => String(line).includes(text))
}

console.log('八个标签页都进了 bundle：')
{
  // bundle 是生成物，这里直接读它做完整性检查：
  // 少拼一个片段（比如忘了加进 build-client 的 ORDER）时，factory 不会报错，
  // 只是那个标签页点开是空白 —— 只有查字符串能提前发现。
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { join, dirname } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const bundle = readFileSync(join(root, 'lib', 'client.js'), 'utf8')

  // 原来只列 7 个，漏了 notes（P1-7）；实际是 8 个 tab。
  const tabs = ['overview', 'persona', 'memory', 'purpose', 'mood', 'diary', 'notes', 'settings']
  for (const key of tabs) {
    ok(bundle.includes(`['${key}',`), `标签页 ${key} 注册了`)
  }
  ok(bundle.includes('function DiaryTab('), 'DiaryTab 组件拼进了 bundle')
  ok(bundle.includes(`tab === 'diary'`), '外壳里渲染了 DiaryTab')
  ok(bundle.includes('/diary/list'), '日记页请求了 /diary/list 接口')
  ok(bundle.includes('/diary/read'), '日记页请求了 /diary/read 接口')
  ok(bundle.includes('/diary'), '日记页请求了 /diary 触发接口')
}

console.log('清理：')
{
  let disposed = 0
  for (const effect of effects) {
    if (typeof effect === 'function') {
      effect()
      disposed += 1
    }
  }
  ok(effectCalls.every((call) => typeof call.fn === 'function'), 'useEffect 收到的都是函数回调（不执行，避免异步 fetch）')
  // 原来这里是无条件 ok(true) 的恒真断言，换成真计数。
  ok(disposed > 0, `apply 注册的 ${disposed} 个 disposer 都能调用（恒真断言已删除）`)
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
