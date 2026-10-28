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

/** 极简 React 替身：只要能 createElement 和那几个 hook 就行。 */
const ReactStub = {
  createElement: function (type, props) {
    var children = Array.prototype.slice.call(arguments, 2)
    return { type: typeof type === 'function' ? (type.name || 'fn') : type, props: props || {}, children: children }
  },
  useCallback: function (fn) { return fn },
  useEffect: function () {},
  useState: function (initial) { return [typeof initial === 'function' ? initial() : initial, function () {}] },
  useMemo: function (fn) { return fn() },
  useRef: function (value) { return { current: value } },
  Component: function Component() {},
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

  // 组件本身能创建元素（不渲染，只验它不炸）
  let renderError = null
  try {
    const element = registerCall.component({ sessionId: 'test', cwd: '' })
    ok(element !== null && typeof element === 'object', '组件能创建元素')
  } catch (error) {
    renderError = error
    ok(false, `组件创建元素失败：${error.message}`)
  }
  ok(registerResult !== undefined, 'inject 回调有返回值')
}

console.log('清理：')
{
  for (const effect of effects) {
    if (typeof effect === 'function') {
      try { effect() } catch { /* 忽略 */ }
    }
  }
  ok(true, 'disposer 可调用')
}

console.log(`\n结果：${passed} 过 / ${failed} 败`)
process.exit(failed === 0 ? 0 : 1)
