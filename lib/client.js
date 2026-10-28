/**
 * client.js —— 浏览器半侧：设置页（手写 __ModuleLoader__ bundle，不需要构建工具）。
 *
 * 六个标签（模块化：各模块的配置就在各自页签里，「设置」只留总开关）：
 *   概览  这一刻到底生效了什么（人格来源 / 记忆容量 / 目的状态）—— 先回答「有没有用」
 *   人格  全局与项目的 Markdown 编辑 + 人格注入设置（合并模式等）
 *   记忆  记忆列表 + 注入预算 / 整理
 *   目的  四个驱动值 + 心里惦记的事 + 目的开关
 *   心情  心情值 / 七情 / 时间线 / 判断配置（不注入提示词、无挂饰）
 *   设置  总开关
 *
 * 与宿主只走同源 HTTP（/api/soul/*），不碰 RPC：失败模式最少。
 * 改完用 `node --check lib/client.js` 验语法（它是表达式不是语句）。
 */

window.__ModuleLoader__.load({
  id: 'dsh-agent-soul',
  factory: function (require) {
    // ⚠️ 这两行不能省：宿主只提供 require，不提供 CommonJS 的 module/exports。
    // 少了它们，factory 里一碰 module.exports 就是 "module is not defined"，
    // 而 DSH 的启动日志只会说「1 entry did not activate」—— 整个应用起不来。
    // node --check 查不出这个问题：它是语法层面合法的，只有真跑一次才炸。
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var h = React.createElement
    var useCallback = React.useCallback
    var useEffect = React.useEffect
    var useState = React.useState

    var API = '/api/soul'
    var NS = 'dsh-agent-soul'

    // ---- 同源 API ---------------------------------------------------------

    function readJson(res) {
      return res.text().then(function (text) {
        var data = null
        try { data = text === '' ? null : JSON.parse(text) } catch (e) { data = null }
        if (!res.ok) {
          var err = new Error(data && data.error ? data.error : 'HTTP ' + res.status)
          err.status = res.status
          throw err
        }
        return data
      })
    }
    function apiGet(path) {
      return fetch(API + path, { cache: 'no-store' }).then(readJson)
    }
    function apiPost(path, body) {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      }).then(readJson)
    }

    /** 从会话上下文里刨出 cwd —— 刨不到就全局视图，再不够还有服务端兜底与手选。 */
    function cwdOf(props) {
      var p = props || {}
      var candidates = [
        p.cwd,
        p.session && p.session.header && p.session.header.cwd,
        p.session && p.session.cwd,
        p.agent && p.agent.session && p.agent.session.header && p.agent.session.header.cwd,
      ]
      for (var i = 0; i < candidates.length; i += 1) {
        if (typeof candidates[i] === 'string' && candidates[i] !== '') return candidates[i]
      }
      return ''
    }

    /** ISO 时间 → 「10月26日 12:48」（设置页文件栏用）。 */
    function timeLabel(iso) {
      if (!iso) return ''
      var d = new Date(iso)
      if (isNaN(d.getTime())) return ''
      var pad = function (n) { return (n < 10 ? '0' : '') + n }
      return (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }

    // ---- 样式 -------------------------------------------------------------

    var CSS = [
      // 变量全部走 DSH 真实的 --dsw-alias-*，并给出硬编码 fallback。
      // 2026-10-28 踩过的坑：一开始用的是另一套 --color-* 名字，DSH 里根本不存在，
      // 结果颜色全回退、没有边框、也没有层次 —— 看起来像"裸控件"，但代码不报错。
      '.soul-app{',
      '--soul-fg:var(--dsw-alias-label-primary,#1f1c18);',
      '--soul-muted:var(--dsw-alias-label-secondary,#6f6558);',
      '--soul-faint:var(--dsw-alias-label-tertiary,#8a7f6e);',
      '--soul-line:var(--dsw-alias-border-l2,#e3daca);',
      '--soul-line-soft:var(--dsw-alias-border-l1,#ece5d8);',
      '--soul-bg:var(--dsw-alias-bg-layer-1,#fffdf8);',
      '--soul-bg2:var(--dsw-alias-bg-layer-2,#f4efe4);',
      '--soul-brand:var(--dsw-alias-brand-primary,#1f6feb);',
      '--soul-ok:var(--dsw-alias-state-success-primary,#2f6b46);',
      '--soul-warn:var(--dsw-alias-state-warn-primary,#8a6a2f);',
      '--soul-err:var(--dsw-alias-state-error-primary,#a83a2c);',
      'font-family:var(--dsw-font-family-sans,var(--dsw-font-family,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif));',
      'color:var(--soul-fg);font-size:13px;line-height:20px;box-sizing:border-box;max-width:100%;',
      'border:1px solid var(--soul-line);border-radius:14px;overflow:hidden;background:rgba(127,127,127,.04)}',

      '.soul-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;padding:16px 18px 12px;border-bottom:1px solid var(--soul-line);background:rgba(127,127,127,.025)}',
      '.soul-kicker{margin:0 0 2px;font-size:11px;letter-spacing:.13em;text-transform:uppercase;color:var(--soul-faint)}',
      '.soul-title{margin:0;font-size:17px;font-weight:600;line-height:24px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.soul-sub{margin:4px 0 0;font-size:12px;color:var(--soul-faint)}',
      '.soul-dots{display:flex;gap:6px;margin-left:auto;flex-wrap:wrap}',
      '.soul-dot{display:inline-flex;align-items:center;gap:5px;font-size:11px;color:var(--soul-muted);background:rgba(127,127,127,.10);padding:3px 9px;border-radius:999px;white-space:nowrap}',
      '.soul-dot i{width:7px;height:7px;border-radius:50%;background:#8a8f98;display:inline-block}',
      '.soul-dot.ok i{background:#2fbf71}',
      '.soul-dot.warn i{background:#ffb020}',
      '.soul-dot.bad i{background:#ff5c5c}',

      '.soul-tabs{display:flex;gap:2px;padding:8px 12px 0;border-bottom:1px solid var(--soul-line);overflow-x:auto;background:rgba(127,127,127,.02)}',
      '.soul-tab{border:none;background:transparent;color:var(--soul-muted);font-size:12.5px;padding:8px 12px 9px;border-bottom:2px solid transparent;cursor:pointer;white-space:nowrap;border-radius:6px 6px 0 0;font-family:inherit}',
      '.soul-tab:hover{background:rgba(127,127,127,.08);color:var(--soul-fg)}',
      '.soul-tab.on{color:var(--soul-fg);border-bottom-color:var(--soul-brand);font-weight:600}',

      '.soul-body{padding:14px 18px 16px;display:flex;flex-direction:column;gap:12px;max-height:min(64vh,720px);overflow:auto}',
      '.soul-card{border:1px solid var(--soul-line-soft);border-radius:10px;padding:12px 13px;background:rgba(127,127,127,.03)}',
      '.soul-card-h{display:flex;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:wrap}',
      '.soul-card-t{margin:0;font-size:13px;font-weight:600}',
      '.soul-card-m{margin-left:auto;font-size:11px;color:var(--soul-faint)}',
      '.soul-note{margin:5px 0 0;font-size:11.5px;line-height:17px;color:var(--soul-faint)}',

      '.soul-kv{display:flex;justify-content:space-between;gap:10px;padding:5px 0;border-bottom:.5px solid var(--soul-line-soft);font-size:12px}',
      '.soul-kv:last-child{border-bottom:none}',
      '.soul-kv>span{color:var(--soul-faint);flex:0 0 auto}',
      '.soul-kv>b{font-weight:500;text-align:right;word-break:break-all}',

      '.soul-meter{height:6px;border-radius:3px;background:rgba(127,127,127,.16);overflow:hidden;margin:7px 0 3px}',
      '.soul-meter-fill{height:100%;border-radius:3px;background:var(--soul-brand);transition:width .18s ease}',
      '.soul-meter-fill.warn{background:#ffb020}',
      '.soul-meter-fill.bad{background:#ff5c5c}',

      '.soul-badge{font-size:11px;padding:1px 7px;border-radius:6px;white-space:nowrap;background:rgba(127,127,127,.12);color:var(--soul-muted)}',
      '.soul-badge.vivid{background:rgba(47,191,113,.15);color:#1f7a4d}',
      '.soul-badge.clear{background:rgba(31,111,235,.13);color:#1f6feb}',
      '.soul-badge.fuzzy{background:rgba(255,176,32,.17);color:#8a6a2f}',
      '.soul-badge.trace{background:rgba(255,92,92,.14);color:#a83a2c}',

      '.soul-list{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
      '.soul-item{display:flex;gap:8px;align-items:flex-start;border:1px solid var(--soul-line-soft);border-radius:8px;padding:9px 10px;background:var(--soul-bg)}',
      '.soul-item:hover{border-color:var(--soul-line)}',
      '.soul-item-text{flex:1 1 auto;min-width:0;word-break:break-word}',
      '.soul-meta{margin-top:3px;font-size:11px;line-height:16px;color:var(--soul-faint)}',

      '.soul-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.soul-grow{flex:1 1 auto;min-width:0}',
      '.soul-btn{font-family:inherit;font-size:12px;line-height:18px;padding:4px 10px;border:1px solid var(--soul-line);background:var(--soul-bg);color:var(--soul-fg);border-radius:6px;cursor:pointer;white-space:nowrap}',
      '.soul-btn:hover{background:rgba(127,127,127,.09);border-color:var(--soul-muted)}',
      '.soul-btn.on{background:var(--soul-brand);border-color:var(--soul-brand);color:#fff}',
      '.soul-btn.danger{color:var(--soul-err)}',
      '.soul-btn.danger:hover{background:rgba(255,92,92,.10);border-color:var(--soul-err)}',

      '.soul-input,.soul-textarea{width:100%;box-sizing:border-box;font-family:inherit;font-size:12.5px;padding:6px 9px;border:1px solid var(--soul-line);border-radius:7px;background:var(--soul-bg);color:var(--soul-fg)}',
      '.soul-input:focus,.soul-textarea:focus{outline:none;border-color:var(--soul-brand)}',
      '.soul-textarea{min-height:300px;resize:vertical;line-height:1.65;font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,monospace)}',

      '.soul-empty{padding:18px 0;text-align:center;font-size:12px;color:var(--soul-faint)}',
      '.soul-err{margin:0;padding:6px 0;font-size:12px;color:var(--soul-err)}',
      '.soul-pill{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--soul-line-soft);color:var(--soul-muted);white-space:nowrap}',
      '.soul-hint{font-size:11px;color:var(--soul-faint)}',

      '.soul-banner{border:1px solid var(--soul-line-soft);border-radius:9px;padding:8px 11px;background:rgba(127,127,127,.05)}',
      '.soul-banner-line{display:flex;gap:10px;padding:3px 0;font-size:12px;align-items:flex-start}',
      '.soul-banner-key{flex:0 0 92px;color:var(--soul-faint);white-space:nowrap}',
      '.soul-banner-val{flex:1 1 auto;min-width:0;word-break:break-all;color:var(--soul-fg)}',
      '.soul-banner-val.warn{color:var(--soul-warn)}',
      '.soul-steps{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:9px 11px;border:1px solid var(--soul-line-soft);border-radius:9px;background:rgba(127,127,127,.02)}',
      '.soul-step{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:6px;border:1px solid transparent;font-size:12px;color:var(--soul-faint)}',
      '.soul-step.on{background:rgba(47,191,113,.13);color:#1f7a4d;border-color:rgba(47,191,113,.32)}',
      '.soul-step.eff{font-weight:600}',
      '.soul-step i{width:6px;height:6px;border-radius:50%;background:currentColor;opacity:.55;display:inline-block}',
      '.soul-arrow{color:var(--soul-faint);font-size:12px;padding:0 1px}',
      '.soul-pill-tab{font-family:inherit;font-size:12.5px;padding:5px 13px;border-radius:999px;border:1px solid var(--soul-line);background:var(--soul-bg);color:var(--soul-muted);cursor:pointer}',
      '.soul-pill-tab:hover{border-color:var(--soul-muted);color:var(--soul-fg)}',
      '.soul-pill-tab.on{background:var(--soul-brand);border-color:var(--soul-brand);color:#fff;font-weight:600}',
      '.soul-pill-tab:disabled{opacity:.45;cursor:not-allowed}',
      '.soul-switch{display:inline-flex;align-items:center;gap:7px;font-size:12px;color:var(--soul-muted);cursor:pointer;white-space:nowrap}',
      '.soul-switch input{appearance:none;-webkit-appearance:none;width:34px;height:19px;border-radius:10px;background:rgba(127,127,127,.30);position:relative;cursor:pointer;transition:background .15s;margin:0;border:none;flex:0 0 auto}',
      '.soul-switch input:checked{background:var(--soul-brand)}',
      '.soul-switch input::after{content:"";position:absolute;top:2px;left:2px;width:15px;height:15px;border-radius:50%;background:#fff;transition:transform .15s}',
      '.soul-switch input:checked::after{transform:translateX(15px)}',
      '.soul-select{font-family:inherit;font-size:12px;padding:5px 8px;border:1px solid var(--soul-line);border-radius:7px;background:var(--soul-bg);color:var(--soul-fg);flex:1 1 auto;min-width:0;max-width:100%}',
      '.soul-row-label{flex:0 0 52px;font-size:12px;color:var(--soul-faint);white-space:nowrap}',
      '.soul-filebar{display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid var(--soul-line-soft);border-radius:8px;background:rgba(127,127,127,.04);font-size:11.5px;color:var(--soul-faint);flex-wrap:wrap}',
      '.soul-filebar-path{flex:1 1 auto;min-width:0;word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,monospace);color:var(--soul-muted)}',
      '.soul-section-title{font-size:14px;font-weight:600;margin:0}',
      '.soul-legend{display:flex;gap:9px;align-items:flex-start;padding:8px 0;border-bottom:.5px solid var(--soul-line-soft)}',
      '.soul-legend:last-child{border-bottom:none}',
      '.soul-lv{flex:0 0 auto;width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10.5px;font-weight:600;background:rgba(127,127,127,.14);color:var(--soul-muted);margin-top:1px}',
      '.soul-legend.on .soul-lv{background:var(--soul-brand);color:#fff}',
      '.soul-legend-body{flex:1 1 auto;min-width:0}',
      '.soul-legend-name{display:flex;align-items:center;gap:6px;flex-wrap:wrap;font-size:12.5px}',
      '.soul-path{margin-top:2px;font-size:11px;line-height:15px;color:var(--soul-faint);word-break:break-all;font-family:var(--dsw-font-family-mono,ui-monospace,Menlo,monospace)}',
      '.soul-warn-box{margin-top:9px;padding:8px 10px;border:1px solid rgba(255,176,32,.45);border-radius:8px;background:rgba(255,176,32,.10);font-size:11.5px;line-height:17px;color:var(--soul-warn)}',
      '.soul-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.soul-priority{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--soul-faint)}',

      // 心情页（参考 feiyu-mood 的布局：大数字 hero + 七情 + 时间线 + 判断配置）
      '.soul-mood-hero{display:flex;align-items:center;gap:14px;flex-wrap:wrap}',
      '.soul-mood-emoji{font-size:38px;line-height:1}',
      '.soul-mood-num{font-size:34px;font-weight:650;line-height:1;letter-spacing:-.02em}',
      '.soul-mood-label{font-size:13px;color:var(--soul-muted);margin-top:3px}',
      '.soul-mood-reason{flex:1 1 220px;min-width:0;font-size:12px;line-height:18px;color:var(--soul-muted);border-left:2px solid var(--soul-line);padding-left:10px}',
      '.soul-dim{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:12px}',
      '.soul-dim-name{flex:0 0 46px;color:var(--soul-faint)}',
      '.soul-dim-val{flex:0 0 30px;text-align:right;color:var(--soul-muted)}',
      '.soul-tl{display:flex;flex-direction:column;gap:0;max-height:320px;overflow:auto}',
      '.soul-tl-item{display:flex;gap:9px;padding:8px 2px;border-bottom:.5px solid var(--soul-line-soft);font-size:11.5px;line-height:17px}',
      '.soul-tl-item:last-child{border-bottom:none}',
      '.soul-tl-time{flex:0 0 88px;color:var(--soul-faint);white-space:nowrap}',
      '.soul-tl-delta{flex:0 0 40px;text-align:right;font-weight:600}',
      '.soul-tl-delta.up{color:#c0392b}',
      '.soul-tl-delta.down{color:#2f6b46}',
      '.soul-tl-body{flex:1 1 auto;min-width:0;color:var(--soul-muted);word-break:break-word}',

      // 宿主一个 --dsw-* 都没提供时的兜底（极少数情况，比如自定义主题）
      '@supports not (color:var(--dsw-alias-label-primary)){.soul-app{--soul-fg:#241f18;--soul-muted:#6f6558;--soul-faint:#9a9084;--soul-line:#e0d7c8;--soul-line-soft:#ece5d8;--soul-bg:#fffdf8;--soul-bg2:#f6f2ea;--soul-brand:#1f6feb;--soul-ok:#2f6b46;--soul-warn:#8a6a2f;--soul-err:#a83a2c}}'
    ].join('\n')

    function ensureStyles(ctx) {
      var id = 'dsh-agent-soul-styles'
      if (document.getElementById(id) !== null) return function () {}
      var style = document.createElement('style')
      style.id = id
      style.textContent = CSS
      document.head.appendChild(style)
      return function () {
        var el = document.getElementById(id)
        if (el !== null && el.parentNode !== null) el.parentNode.removeChild(el)
      }
    }

    // ---- 小组件 -----------------------------------------------------------

    var CLARITY_LABEL = { vivid: '清晰', clear: '清楚', fuzzy: '模糊', trace: '只剩印象', forgotten: '已遗忘' }
    var NEED_LABEL = { curiosity: '想弄明白', care: '在乎', share: '想分享', mastery: '想搞懂' }
    var KIND_LABEL = { question: '想弄明白', promise: '答应过的', curious: '想试试', followup: '还没聊完' }
    // 七情顺序跟 lib/mood.js 的 DIMS 一致（界面按这个排）
    var MOOD_DIMS = [
      ['happy', '开心'], ['calm', '踏实'], ['sweet', '甜蜜'], ['heartache', '心疼'],
      ['worry', '担心'], ['sad', '难过'], ['jealous', '吃醋'],
    ]

    function Badge(props) {
      return h('span', { className: 'soul-badge ' + (props.clarity || '') }, props.children)
    }

    function Card(props) {
      return h('div', { className: 'soul-card' },
        props.title
          ? h('div', { className: 'soul-card-h' },
            h('p', { className: 'soul-card-t' }, props.title),
            props.meta ? h('span', { className: 'soul-card-m' }, props.meta) : null
          )
          : null,
        props.children
      )
    }

    /** 状态点：绿=正常、黄=要留意、红=有问题。 */
    function Dot(props) {
      return h('span', { className: 'soul-dot ' + (props.tone || '') },
        h('i', null),
        props.children
      )
    }

    /** 药丸页签（跟原人格插件一致的交互）。 */
    function Pill(props) {
      return h('button', {
        className: 'soul-pill-tab' + (props.active ? ' on' : ''),
        disabled: props.disabled === true,
        title: props.title || '',
        onClick: props.onClick,
      }, props.children)
    }

    /** 开关（带文字状态，比裸 checkbox 清楚）。 */
    function Switch(props) {
      return h('label', { className: 'soul-switch' },
        h('input', {
          type: 'checkbox',
          checked: props.checked === true,
          disabled: props.disabled === true,
          onChange: props.onChange,
        }),
        h('span', null, props.label)
      )
    }

    /** 一行键值（比裸 div 好读）。 */
    function Kv(props) {
      return h('div', { className: 'soul-kv' },
        h('span', null, props.label),
        h('b', null, props.value)
      )
    }

    // ---- 概览 -------------------------------------------------------------

    function OverviewTab(props) {
      var state = props.state
      if (state === null) return h('div', { className: 'soul-empty' }, '正在加载…')
      var mem = state.memory || {}
      var g = mem.global || {}
      var p = mem.project
      var purpose = state.purpose || {}
      var sources = (state.persona && state.persona.sources) || []
      var ratio = Math.round((g.ratio || 0) * 100)

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '这一刻生效了什么' },
          h('p', { className: 'soul-note' }, '人格来源：' + (sources.length === 0 ? '还没写人格文件' : sources.length + ' 份')),
          sources.length > 0
            ? h('div', { className: 'soul-list' }, sources.map(function (src, i) {
              return h('div', { key: i, className: 'soul-item' },
                h('span', { className: 'soul-item-text', style: { fontSize: 12 } }, src)
              )
            }))
            : h('p', { className: 'soul-note' }, '去「人格」标签写一份，或者在 ' + '~/.dsh/AGENT.md 里写'),
          h('p', { className: 'soul-meta' }, '合并模式：' + (state.persona && state.persona.mode === 'exclusive' ? '互斥（有项目就不注入全局）' : '叠加（项目覆盖同名小节，全局其余照常生效）') + ' · 正文 ' + ((state.persona && state.persona.chars) || 0) + ' 字')
        ),

        h(Card, { title: '记忆' },
          h('div', { className: 'soul-row', style: { marginBottom: 8 } },
            h('div', { className: 'soul-grow' },
              h('div', { className: 'soul-row' },
                h('span', { style: { fontWeight: 500 } }, String(g.count || 0) + ' 条'),
                h('span', { className: 'soul-pill' }, '固定 ' + (g.pinned || 0)),
                p ? h('span', { className: 'soul-pill' }, '本项目 ' + (p.count || 0)) : null
              ),
              h('div', { className: 'soul-meter', style: { marginTop: 6 } },
                h('div', { className: 'soul-meter-fill', style: { width: Math.min(100, ratio) + '%' } })
              ),
              h('p', { className: 'soul-meta' }, (g.chars || 0) + ' / ' + (g.warnChars || 0) + ' 字（' + ratio + '%）' + (g.level === 'ok' ? '' : ' · 该整理了'))
            )
          ),
          h('div', { className: 'soul-row', style: { gap: 6 } },
            Object.keys(g.byClarity || {}).filter(function (k) { return g.byClarity[k] > 0 }).map(function (k) {
              return h(Badge, { key: k, clarity: k }, CLARITY_LABEL[k] + ' ' + g.byClarity[k])
            })
          ),
          h('p', { className: 'soul-meta' }, '上次整理：' + (g.lastDecayDate || '还没跑过'))
        ),

        h(Card, { title: '心里惦记的事' },
          purpose.mood
            ? h('div', { className: 'soul-row' },
              h('span', { className: 'soul-pill' }, '状态：' + purpose.mood.label),
              h('span', { className: 'soul-pill' }, '待办 ' + (purpose.open || 0) + ' 件')
            )
            : null,
          (purpose.goals || []).length === 0
            ? h('p', { className: 'soul-note', style: { marginTop: 6 } }, '暂时没惦记什么。她答应过的事、没弄明白的事会自动长出来。')
            : h('div', { className: 'soul-list' }, (purpose.goals || []).slice(0, 5).map(function (goal) {
              return h('div', { key: goal.id, className: 'soul-item' },
                h('span', { className: 'soul-badge' }, KIND_LABEL[goal.kind] || '想试试'),
                h('span', { className: 'soul-item-text' }, goal.text)
              )
            })),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            Object.keys(purpose.drives || {}).map(function (need) {
              var value = purpose.drives[need] || 0
              return h('div', { key: need, style: { flex: '1 1 100px', minWidth: 90 } },
                h('span', { className: 'soul-meta' }, NEED_LABEL[need] + ' ' + Math.round(value * 100)),
                h('div', { className: 'soul-meter', style: { marginTop: 3 } },
                  h('div', { className: 'soul-meter-fill', style: { width: Math.round(value * 100) + '%' } })
                )
              )
            })
          )
        )
      )
    }

    // ---- 人格 -------------------------------------------------------------

    /**
     * 人格页 —— 布局照着 dsh-agent-md 的来（横幅 + 横向优先级条 + 药丸页签）。
     *
     * 为什么抄它的布局而不是自己另设计一套：
     *   用户在这个页面上已经形成肌肉记忆了 ——「本会话当前生效」在哪、页签在哪、
     *   打开原文件在哪。换插件时把这些位置全改掉，等于让人重新学一遍。
     *   差异只应该出现在**内容**上（叠加 vs 互斥、三层各自的路径与状态）。
     */
    function PersonaTab(props) {
      var workspace = props.workspace || null
      var config = props.config || {}
      var workspaces = props.workspaces || []
      // 项目人格不再灰：就算宿主没传 cwd，也能从下拉/任意目录里挑（学 dsh-agent-md）
      var [kind, setKind] = useState('global')
      var [text, setText] = useState('')
      var [path, setPath] = useState('')
      var [updatedAt, setUpdatedAt] = useState(null)
      var [status, setStatus] = useState('')
      var [loading, setLoading] = useState(false)
      var [busy, setBusy] = useState('')
      var [projectCwd, setProjectCwd] = useState('')
      var [pathDraft, setPathDraft] = useState('')
      var enabled = config.enabled !== false

      // 首帧之后把「宿主/服务端解析到的工作目录」种进 projectCwd（下拉默认选中它）
      useEffect(function () {
        if (projectCwd === '') {
          var seed = props.cwd || (workspace && workspace.cwd) || ''
          if (seed !== '') setProjectCwd(seed)
        }
      }, [props.cwd, workspace])

      // 正在编辑哪一份：全局不挑 cwd，项目用 projectCwd
      var effCwd = kind === 'project' ? projectCwd : ''

      var load = useCallback(function () {
        setLoading(true)
        setStatus('')
        apiGet('/persona?kind=' + kind + (effCwd ? '&cwd=' + encodeURIComponent(effCwd) : ''))
          .then(function (data) {
            setText(data.text || '')
            setPath(data.path || '')
            setUpdatedAt(data.updatedAt || null)
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
          .then(function () { setLoading(false) })
      }, [kind, effCwd])

      useEffect(function () { load() }, [load])

      function save() {
        setStatus('保存中…')
        apiPost('/persona', { kind: kind, cwd: effCwd, text: text })
          .then(function (data) { setStatus('已保存（' + data.chars + ' 字），下一个回合生效') })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function openFile() {
        setStatus('正在打开…')
        apiPost('/open', { kind: kind, cwd: effCwd })
          .then(function () { setStatus('已在文件管理器中选中') })
          .catch(function (e) { setStatus(e.message) })
      }

      /** 让宿主弹系统「选择文件夹」，结果填进输入框（不直接切，防手滑）。 */
      function doPick() {
        setBusy('pick')
        apiPost('/pick', {})
          .then(function (res) {
            if (res && res.picked) {
              setPathDraft(res.picked)
              setStatus('已选中：' + res.picked + '（再点「使用」切过去）')
            } else {
              setStatus('已取消选择。')
            }
          })
          .catch(function (e) { setStatus('打不开选择器：' + e.message) })
          .then(function () { setBusy('') })
      }

      /** 用手填/选中的目录当工作区（登记 + 切过去 + 拉它的项目人格）。 */
      function usePickedCwd() {
        var cwd = pathDraft.trim()
        if (cwd === '') {
          setStatus('先填一个目录，或者点「选择文件夹」。')
          return
        }
        setBusy('pick')
        apiPost('/register', { cwd: cwd, active: true })
          .then(function () {
            setProjectCwd(cwd)
            setKind('project')
            if (typeof props.onSelectCwd === 'function') props.onSelectCwd(cwd)
            setStatus('已切到工作区：' + cwd)
          })
          .catch(function (e) { setStatus('登记失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function toggleEnabled(next) {
        var merged = {}
        Object.keys(config).forEach(function (k) { merged[k] = config[k] })
        merged.enabled = next
        apiPost('/config', { config: merged })
          .then(function () {
            setStatus(next ? '已启用，下一个回合生效' : '已停用 —— 不会再注入任何人格')
            if (typeof props.reload === 'function') props.reload()
          })
          .catch(function (e) { setStatus('切换失败：' + e.message) })
      }

      var layers = (workspace && workspace.layers) || []
      var byLevel = {}
      layers.forEach(function (layer) { byLevel[layer.level] = layer })

      // 项目层实际生效的是哪一份（1 优先于 2）—— 结论由宿主算好，这里只负责显示
      var effProject = null
      if (workspace && workspace.projectEffective === 'local') effProject = byLevel[1]
      if (workspace && workspace.projectEffective === 'stored') effProject = byLevel[2]
      var effectiveText
      if (!enabled) effectiveText = '人格已停用 —— 当前不会注入任何人格'
      else if (effProject) effectiveText = effProject.name + ' · ' + effProject.path + '（＋叠加全局底座）'
      else if (byLevel[3] && byLevel[3].exists) effectiveText = '全局人格 · ' + byLevel[3].path
      else effectiveText = '尚未写入任何人格（写一份即生效）'

      /** 横向优先级条：每一步带「有 / 没有」，正在生效的那步加粗。 */
      function step(level) {
        var layer = byLevel[level]
        if (layer === undefined) return null
        var isEff = effProject !== null && effProject.level === level
          || (effProject === null && level === 3 && byLevel[3] && byLevel[3].exists && enabled)
        return h('span', {
          key: 'l' + level,
          className: 'soul-step' + (layer.exists ? ' on' : '') + (isEff ? ' eff' : ''),
          title: layer.path ? layer.path + '\n' + layer.scope : layer.scope,
        }, h('i', null), layer.name)
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 11 } },

        // ---- 头部：标题 + 总开关 ----
        h('div', { className: 'soul-row' },
          h('div', { className: 'soul-grow' },
            h('p', { className: 'soul-section-title' }, '人格 · AGENT.md'),
            h('p', { className: 'soul-note' }, '用 Markdown 写她是谁。项目里只写和其它项目不同的部分，其余从全局继承。')
          ),
          h(Switch, {
            checked: enabled,
            label: enabled ? '已启用' : '已停用',
            onChange: function (e) { toggleEnabled(e.target.checked) },
          })
        ),

        // ---- 横幅：本会话当前生效 / 当前工作目录 ----
        h('div', { className: 'soul-banner' },
          h('div', { className: 'soul-banner-line' },
            h('span', { className: 'soul-banner-key' }, '本会话当前生效'),
            h('span', { className: 'soul-banner-val' + (enabled && effectiveText.indexOf('尚未') === 0 ? ' warn' : '') }, effectiveText)
          ),
          h('div', { className: 'soul-banner-line' },
            h('span', { className: 'soul-banner-key' }, '当前工作目录'),
            h('span', { className: 'soul-banner-val' + (workspace && workspace.cwd ? '' : ' warn') },
              workspace && workspace.cwd
                ? workspace.cwd
                  + (workspace.cwdSource === 'recent' ? '（本页拿不到会话 → 用最近活跃工作区兜底）' : '')
                  + (workspace.cwdSource === 'path' ? '（手动指定）' : '')
                : '未解析到 —— 切到「项目人格」，从下面的工作区下拉或任意目录里挑一个')
          )
        ),

        // ---- 横向优先级条 ----
        layers.length > 0
          ? h('div', { className: 'soul-steps' },
            step(1),
            h('span', { className: 'soul-arrow' }, '›'),
            step(2),
            h('span', { className: 'soul-arrow' }, '›'),
            step(3),
            h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '6px 0 0' } },
              '项目层取前两步里优先级最高的那一份；本插件再把全局底座按小节叠加上来（同名小节以项目为准）。')
          )
          : null,

        // ---- 覆盖警告 ----
        workspace && workspace.localOverridesStored
          ? h('div', { className: 'soul-warn-box' },
            '这个工作目录里有 AGENT.md，它的优先级高于「项目人格（本机）」。'
            + '你在下面第 2 层改的内容不会生效 —— 要么直接改那个文件，要么删掉它。'
          )
          : null,

        // ---- 页签与操作 ----
        h('div', { className: 'soul-row' },
          h(Pill, { active: kind === 'global', onClick: function () { setKind('global') } }, '全局人格'),
          h(Pill, {
            active: kind === 'project',
            onClick: function () { setKind('project') },
          }, '项目人格'),
          h('span', { className: 'soul-grow' }),
          h('button', { className: 'soul-btn', onClick: openFile, disabled: path === '' }, '打开原文件'),
          h('button', { className: 'soul-btn', onClick: load }, '重新读取'),
          h('button', { className: 'soul-btn on', onClick: save }, '保存')
        ),

        // ---- 项目专属：工作区下拉 + 任意目录（学 dsh-agent-md，不再依赖宿主传 cwd） ----
        kind === 'project' ? h('div', { className: 'soul-row' },
          h('span', { className: 'soul-row-label' }, '工作区'),
          workspaces.length > 0
            ? h('select', {
              className: 'soul-select',
              value: projectCwd,
              onChange: function (e) {
                var next = e.target.value
                setProjectCwd(next)
                if (typeof props.onSelectCwd === 'function') props.onSelectCwd(next)
              },
            }, workspaces.map(function (w) {
              var tags = []
              tags.push(w.exists === true ? '已有人格' : '空')
              if (w.sources && w.sources.indexOf('persona') >= 0) tags.push('已登记')
              return h('option', { key: w.key || w.cwd, value: w.cwd }, (w.displayName || w.cwd) + '（' + tags.join('·') + '） — ' + w.cwd)
            }))
            : h('span', { className: 'soul-note' }, '还没发现本机的工作区——下面手填一个目录即可。')
        ) : null,

        kind === 'project' ? h('div', { className: 'soul-row' },
          h('span', { className: 'soul-row-label' }, '任意目录'),
          h('input', {
            className: 'soul-input',
            value: pathDraft,
            spellCheck: false,
            placeholder: '例：D:\\team（也可以点右边用系统选择器挑）',
            onChange: function (e) { setPathDraft(e.target.value) },
            onKeyDown: function (e) { if (e.key === 'Enter') usePickedCwd() },
          }),
          h('button', { className: 'soul-btn', onClick: doPick, disabled: busy === 'pick' }, '选择文件夹'),
          h('button', { className: 'soul-btn', onClick: usePickedCwd, disabled: busy === 'pick' }, '使用')
        ) : null,

        // ---- 文件栏：路径 + 上次改动 ----
        path !== '' ? h('div', { className: 'soul-filebar' },
          h('span', { className: 'soul-filebar-path', title: path }, path),
          h('span', null, updatedAt ? '上次改动 ' + timeLabel(updatedAt) : '文件尚未创建')
        ) : null,

        h('p', { className: 'soul-note' },
          kind === 'global'
            ? '全局是底座：所有会话都会吃到。项目里没有同名小节时，这里的内容照样生效。'
            : (projectCwd !== ''
              ? '只对上面那个工作目录生效。同名小节覆盖全局，其余自动继承。'
              : '先在上面选一个工作区，或者手填一个目录。')
        ),
        h('textarea', {
          className: 'soul-textarea',
          value: text,
          spellCheck: false,
          disabled: !enabled || (kind === 'project' && projectCwd === ''),
          placeholder: kind === 'global'
            ? '# 你是谁\n你是一个……\n\n# 语气与形态\n……\n\n# 工程约定\n……'
            : '# 工程约定\n这个项目用 ……，不要 ……\n\n（只写和其它项目不同的部分，其余从全局继承）',
          onChange: function (e) { setText(e.target.value) },
        }),
        h('p', { className: 'soul-meta' },
          text.length + ' 字' + (loading ? ' · 读取中' : '') + (status ? ' · ' + status : '')
        ),

        // ---- 人格模块自己的配置（从「设置」页挪进来，模块化） ----
        h(Card, { title: '人格注入设置' },
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '合并模式'),
            h('select', {
              className: 'soul-input',
              style: { maxWidth: 160 },
              value: config.mode === 'exclusive' ? 'exclusive' : 'stack',
              onChange: function (e) {
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.mode = e.target.value
                apiPost('/config', { config: merged })
                  .then(function () { setStatus('合并模式已保存'); if (typeof props.reload === 'function') props.reload() })
                  .catch(function (err) { setStatus('保存失败：' + err.message) })
              },
            },
              h('option', { value: 'stack' }, '叠加（推荐）'),
              h('option', { value: 'exclusive' }, '互斥')
            )
          ),
          h('p', { className: 'soul-note' }, '叠加 = 项目覆盖同名小节、全局其余照常生效；互斥 = 有项目人格时全局整份不注入（dsh-agent-md 的老行为）'),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '全局人格参与注入'),
              h('p', { className: 'soul-note' }, '关掉就变成「纯项目制」，没有项目人格的会话将没有人格')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.includeGlobal !== false,
              onChange: function (e) {
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.includeGlobal = e.target.checked
                apiPost('/config', { config: merged })
                  .then(function () { setStatus('已保存'); if (typeof props.reload === 'function') props.reload() })
                  .catch(function (err) { setStatus('保存失败：' + err.message) })
              },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '启用项目人格'),
              h('p', { className: 'soul-note' }, '关掉只吃全局那份')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.projectPersonaEnabled !== false,
              onChange: function (e) {
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.projectPersonaEnabled = e.target.checked
                apiPost('/config', { config: merged })
                  .then(function () { setStatus('已保存'); if (typeof props.reload === 'function') props.reload() })
                  .catch(function (err) { setStatus('保存失败：' + err.message) })
              },
            })
          )
        )
      )
    }

    // ---- 记忆 -------------------------------------------------------------

    function MemoryTab(props) {
      var [scope, setScope] = useState('global')
      var [query, setQuery] = useState('')
      var [data, setData] = useState(null)
      var [status, setStatus] = useState('')
      var [draft, setDraft] = useState('')
      var cwd = props.cwd
      var config = props.config || {}

      function patchConfig(next) {
        var merged = {}
        Object.keys(config).forEach(function (k) { merged[k] = config[k] })
        Object.keys(next).forEach(function (k) { merged[k] = next[k] })
        apiPost('/config', { config: merged })
          .then(function () { setStatus('配置已保存'); if (typeof props.reload === 'function') props.reload() })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      var load = useCallback(function () {
        var url = '/memory?scope=' + scope + (cwd ? '&cwd=' + encodeURIComponent(cwd) : '') + (query ? '&query=' + encodeURIComponent(query) : '')
        apiGet(url).then(setData).catch(function (e) { setStatus('读取失败：' + e.message) })
      }, [scope, cwd, query])

      useEffect(function () { load() }, [load])

      function act(action, id, extra) {
        var body = { scope: scope, cwd: cwd, action: action, id: id }
        if (extra) Object.keys(extra).forEach(function (k) { body[k] = extra[k] })
        apiPost('/memory', body)
          .then(function () { setStatus('已' + (action === 'delete' ? '删除' : action === 'pin' ? '固定' : '更新')); load() })
          .catch(function (e) { setStatus('操作失败：' + e.message) })
      }

      function add() {
        if (draft.trim() === '') return
        apiPost('/memory', { scope: scope, cwd: cwd, action: 'edit', id: '', text: draft })
          .catch(function () {
            // edit 需要 id，新增走 write：这里直接用 write 语义
            return apiPost('/memory', { scope: scope, cwd: cwd, action: 'write', text: draft })
          })
          .then(function () { setDraft(''); setStatus('记下了'); load() })
          .catch(function (e) { setStatus('添加失败：' + e.message) })
      }

      var records = (data && data.records) || []

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 10 } },
        h('div', { className: 'soul-row' },
          h('button', { className: 'soul-btn' + (scope === 'global' ? ' on' : ''), onClick: function () { setScope('global') } }, '全局记忆'),
          h('button', { className: 'soul-btn' + (scope === 'project' ? ' on' : ''), onClick: function () { setScope('project') } }, '本项目'),
          h('input', {
            className: 'soul-input soul-grow',
            placeholder: '搜关键词',
            value: query,
            style: { maxWidth: 220 },
            onChange: function (e) { setQuery(e.target.value) },
          }),
          h('button', { className: 'soul-btn', onClick: load }, '刷新')
        ),
        h('p', { className: 'soul-meta' }, (data ? data.total : 0) + ' 条' + (status ? ' · ' + status : '')),

        h(Card, { title: '手动记一条' },
          h('div', { className: 'soul-row' },
            h('input', {
              className: 'soul-input soul-grow',
              placeholder: '写一件值得记住的事（会按重要度自动定衰减速度）',
              value: draft,
              onChange: function (e) { setDraft(e.target.value) },
              onKeyDown: function (e) { if (e.key === 'Enter') add() },
            }),
            h('button', { className: 'soul-btn', onClick: add }, '记下来')
          ),
          h('p', { className: 'soul-note' }, '主人的偏好/目标、约定、"第一次"类的事会自动判高重要度，衰减得慢。')
        ),

        records.length === 0
          ? h('div', { className: 'soul-empty' }, query ? '没搜到' : '还没有记忆。多聊几句，值得记的会自动进来')
          : h('div', { className: 'soul-list' }, records.map(function (r) {
            return h('div', { key: r.id, className: 'soul-item' },
              h(Badge, { clarity: r.clarity }, CLARITY_LABEL[r.clarity] || r.clarity),
              h('div', { className: 'soul-item-text' },
                h('div', null, r.text),
                h('div', { className: 'soul-meta' },
                  '重要度 ' + r.importance +
                  ' · 提到过 ' + r.recallCount + ' 次' +
                  ' · ' + (r.source === 'auto' ? '自动记的' : r.source === 'tool' ? '她自己记的' : '手动') +
                  (r.pinned ? ' · 已固定' : '') +
                  (r.tags && r.tags.length ? ' · ' + r.tags.join('/') : '')
                )
              ),
              h('button', { className: 'soul-btn', onClick: function () { act('pin', r.id, { pinned: !r.pinned }) }, title: '固定后永不遗忘' }, r.pinned ? '取消固定' : '固定'),
              h('button', { className: 'soul-btn danger', onClick: function () { act('delete', r.id) } }, '删')
            )
          })),

        // ---- 记忆模块自己的配置（从「设置」页挪进来，模块化） ----
        h(Card, { title: '记忆注入与整理' },
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '注入预算（字）'),
            h('input', {
              className: 'soul-input',
              type: 'number',
              style: { maxWidth: 110 },
              value: config.injectMaxChars || 1600,
              onChange: function (e) { patchConfig({ injectMaxChars: Number(e.target.value) || 1600 }) },
            })
          ),
          h('p', { className: 'soul-note' }, '这段**每回合重发**，是常驻成本。中文按 DSH 口径的 1.4~1.9 倍算：1600 字约 1100~1500 token。'),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '注入记忆'),
              h('p', { className: 'soul-note' }, '关掉后记忆不再进提示词，但仍在后台记录')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.memoryEnabled !== false,
              onChange: function (e) { patchConfig({ memoryEnabled: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '项目记忆独立一张卡'),
              h('p', { className: 'soul-note' }, '关掉则所有记忆都进全局卡')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.projectMemoryEnabled !== false,
              onChange: function (e) { patchConfig({ projectMemoryEnabled: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            h('button', {
              className: 'soul-btn',
              onClick: function () {
                setStatus('整理中…')
                apiPost('/maintain', { cwd: cwd })
                  .then(function (data) {
                    var r = data.report || {}
                    setStatus('整理完成：衰减 ' + (r.decayed || []).length + ' 张，压缩 ' + (r.compacted || []).length + ' 处')
                    if (typeof props.reload === 'function') props.reload()
                  })
                  .catch(function (e) { setStatus('失败：' + e.message) })
              }
            }, '立即整理一次')
          )
        )
      )
    }

    // ---- 目的 -------------------------------------------------------------

    function PurposeTab(props) {
      var state = props.state
      if (state === null) return h('div', { className: 'soul-empty' }, '正在加载…')
      var purpose = state.purpose || {}
      var drives = purpose.drives || {}

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '此刻的状态' },
          h('p', { className: 'soul-note' }, '四个维度各有 0~100 的驱动值：8 小时落一半，聊到相关的东西会涨。她"想说点什么"的冲动就来自这里。'),
          h('div', { className: 'soul-list' },
            Object.keys(drives).map(function (need) {
              var value = drives[need] || 0
              return h('div', { key: need, className: 'soul-row' },
                h('span', { style: { width: 72, fontSize: 12 } }, NEED_LABEL[need] || need),
                h('div', { className: 'soul-meter soul-grow' },
                  h('div', { className: 'soul-meter-fill', style: { width: Math.round(value * 100) + '%' } })
                ),
                h('span', { className: 'soul-meta', style: { width: 32, textAlign: 'right' } }, String(Math.round(value * 100)))
              )
            })
          ),
          purpose.mood ? h('p', { className: 'soul-meta', style: { marginTop: 8 } }, '当前偏向：' + purpose.mood.label) : null
        ),
        h(Card, { title: '心里惦记的事（' + (purpose.open || 0) + ' 件）' },
          h('p', { className: 'soul-note' }, '这些会出现在她的提示词里，但明确写了「不需要每轮都提」——所以不会变成复读。'),
          (purpose.goals || []).length === 0
            ? h('div', { className: 'soul-empty' }, '暂时没有。她答应过的事、没弄明白的事会自动长出来')
            : h('div', { className: 'soul-list' }, (purpose.goals || []).map(function (goal) {
              return h('div', { key: goal.id, className: 'soul-item' },
                h('span', { className: 'soul-badge' }, KIND_LABEL[goal.kind] || '想试试'),
                h('div', { className: 'soul-item-text' },
                  h('div', null, goal.text),
                  h('div', { className: 'soul-meta' }, '权重 ' + goal.weight + ' · 来源 ' + (goal.source === 'memory' ? '从记忆里长出来的' : goal.source))
                ),
                h('button', {
                  className: 'soul-btn',
                  onClick: function () {
                    apiPost('/goal', { id: goal.id }).then(function () { props.reload() }).catch(function () {})
                  }
                }, '放下了')
              )
            }))
        ),

        // ---- 目的模块自己的开关（从「设置」页挪进来，模块化） ----
        h(Card, { title: '目的机制' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '启用「心里惦记的事」'),
              h('p', { className: 'soul-note' }, '从记忆里提炼没闭合的事，让她的主动有连续性。关掉后不再注入这一段')
            ),
            h('input', {
              type: 'checkbox',
              checked: !state.config || state.config.purposeEnabled !== false,
              onChange: function (e) {
                var config = state.config || {}
                var merged = {}
                Object.keys(config).forEach(function (k) { merged[k] = config[k] })
                merged.purposeEnabled = e.target.checked
                apiPost('/config', { config: merged })
                  .then(function () { props.reload() })
                  .catch(function () {})
              },
            })
          )
        )
      )
    }

    // ---- 心情 -------------------------------------------------------------
    //
    // 布局参考 feiyu-mood 的设置页：hero（表情 + 大数字 + 最近理由）→ 七情 → 时间线 → 判断配置。
    // 跟它不一样的两处（都是刻意的）：
    //   · 没有「每回合注入」区块 —— 心情只记账，不进提示词；
    //   · 没有「挂饰」页 —— 不要右下角那套。
    function MoodTab(props) {
      var cwd = props.cwd
      var [data, setData] = useState(null)
      var [config, setConfig] = useState(props.state && props.state.config ? props.state.config : null)
      var [status, setStatus] = useState('')
      var [busy, setBusy] = useState('')

      var load = useCallback(function () {
        apiGet('/mood' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''))
          .then(function (res) {
            setData(res.state || null)
            if (res.config) setConfig(res.config)
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
      }, [cwd])

      useEffect(function () { load() }, [load])
      // 20 秒轻轮询 + 回到前台立刻刷：判定是对话结束后异步落盘的，停在旧数字会显得没在动
      useEffect(function () {
        var timer = setInterval(load, 20000)
        function onShow() { if (document.visibilityState === 'visible') load() }
        document.addEventListener('visibilitychange', onShow)
        return function () {
          clearInterval(timer)
          document.removeEventListener('visibilitychange', onShow)
        }
      }, [load])

      if (config === null && data === null) return h('div', { className: 'soul-empty' }, '正在加载…')

      function patch(next) {
        var base = config || {}
        var merged = {}
        Object.keys(base).forEach(function (k) { merged[k] = base[k] })
        Object.keys(next).forEach(function (k) { merged[k] = next[k] })
        setConfig(merged)
        apiPost('/config', { config: merged })
          .then(function () { setStatus('已保存，下一个回合生效') })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function reset() {
        setBusy('reset')
        apiPost('/mood/reset', { cwd: cwd })
          .then(function () { setStatus('已重置回基准心情'); load() })
          .catch(function (e) { setStatus('重置失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function numRow(key, label, note, min, max, step) {
        return h('div', { className: 'soul-row' },
          h('span', { className: 'soul-grow' }, label),
          h('input', {
            className: 'soul-input',
            type: 'number',
            style: { maxWidth: 100 },
            min: min,
            max: max,
            step: step || 1,
            value: (config && config[key] != null) ? config[key] : '',
            onChange: function (e) {
              var v = Number(e.target.value)
              if (!isNaN(v)) patch({ [key]: v })
            },
          }),
          note ? h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } }, note) : null
        )
      }

      function textRow(key, label, placeholder, note) {
        return h('div', { className: 'soul-row' },
          h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, label),
          h('input', {
            className: 'soul-input',
            style: { maxWidth: 220 },
            value: (config && config[key]) || '',
            spellCheck: false,
            placeholder: placeholder,
            onChange: function (e) { patch({ [key]: e.target.value }) },
          }),
          note ? h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } }, note) : null
        )
      }

      var dims = (data && data.dims) || {}
      var timeline = (data && data.timeline) || []
      var enabled = !config || config.moodEnabled !== false

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        // ---- hero：此刻心情 ----
        h(Card, {
          title: '此刻心情',
          meta: data && data.updatedAt ? '上次变动 ' + timeLabel(new Date(data.updatedAt).toISOString()) : ''
        },
          h('div', { className: 'soul-mood-hero' },
            h('div', null,
              h('div', { className: 'soul-mood-emoji' }, (data && data.emoji) || '·'),
              h('div', { className: 'soul-mood-num' }, data ? String(data.mood) : '—'),
              h('div', { className: 'soul-mood-label' }, (data && data.label) || '还没判过')
            ),
            h('div', { className: 'soul-mood-reason' }, (data && data.lastReason) || '还没聊出变化。多说几轮，她的心情会自己动起来。'),
            h('button', {
              className: 'soul-btn danger',
              disabled: busy === 'reset',
              onClick: reset,
              title: '心情回到基准值，时间线清空'
            }, busy === 'reset' ? '重置中…' : '重置')
          ),
          h('p', { className: 'soul-note' }, '心情是基调，每轮只挪判定值的 1/3，几轮才走得动一格；七情即时变、时间上慢慢平复。**不注入提示词**，只记账。')
        ),

        // ---- 七情 ----
        h(Card, { title: '七情', meta: data && data.top && data.top.length ? '最突出：' + data.top.map(function (t) { return t.label }).join(' / ') : '' },
          h('div', null, MOOD_DIMS.map(function (pair) {
            var value = Math.round(dims[pair[0]] || 0)
            return h('div', { key: pair[0], className: 'soul-dim' },
              h('span', { className: 'soul-dim-name' }, pair[1]),
              h('div', { className: 'soul-meter soul-grow', style: { margin: 0 } },
                h('div', {
                  className: 'soul-meter-fill',
                  style: {
                    width: value + '%',
                    background: value >= 40 ? 'var(--soul-brand)' : value >= 15 ? '#ffb020' : 'rgba(127,127,127,.25)'
                  }
                })
              ),
              h('span', { className: 'soul-dim-val' }, String(value))
            )
          }))
        ),

        // ---- 时间线 ----
        h(Card, { title: '时间线', meta: (data ? data.timelineCount : 0) + ' 条 · 显示最近 40 条' },
          timeline.length === 0
            ? h('div', { className: 'soul-empty' }, '还没有记录')
            : h('div', { className: 'soul-tl' }, timeline.slice(0, 40).map(function (t, i) {
              var up = (t.delta || 0) > 0
              var flat = (t.delta || 0) === 0
              return h('div', { key: t.at + '-' + i, className: 'soul-tl-item' },
                h('span', { className: 'soul-tl-time' }, timeLabel(new Date(t.at).toISOString()) + (t.kind === 'decay' ? ' 平复' : '')),
                h('span', {
                  className: 'soul-tl-delta ' + (flat ? '' : up ? 'up' : 'down')
                }, flat ? '±0' : (up ? '+' : '') + t.delta),
                h('span', { className: 'soul-tl-body' },
                  (t.reason || '') + (t.minor ? ' · 小波动' : '')
                )
              )
            }))
        ),

        // ---- 判断配置 ----
        h(Card, { title: '判断配置' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '每轮判断心情变化'),
              h('p', { className: 'soul-note' }, '关掉后不再判断，已有记录保留，时间衰减照跑。')
            ),
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: function (e) { patch({ moodEnabled: e.target.checked }) },
            })
          ),
          h('p', { className: 'soul-note', style: { margin: '4px 0 6px' } }, '称呼（判断提示词里用，写她怎么自称、怎么叫你）'),
          textRow('moodSelfName', '自称', '例：小糖'),
          textRow('moodOwnerName', '叫你', '例：树树'),
          textRow('moodSelfAliases', '别名', '例：糖糖、小糖'),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '判断模型（留空 = 跟随会话模型）'),
          textRow('moodJudgeProvider', 'provider', '例：deepseek'),
          textRow('moodJudgeModel', 'model', '例：deepseek-chat'),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '数值'),
          numRow('moodBase', '基准心情', '心情漂移后往这里回落（0~100）', 30, 100),
          numRow('moodFloor', '心情下限', '再难过也不跌破这条线（0~100）', 0, 100),
          numRow('moodDecayHalfHours', '回落半衰期（小时）', '心情向基准回落一半要多久；七情固定 90 分钟归零', 1, 168),
          numRow('moodSigMood', '显著阈值（心情）', '判定值绝对变化 ≥ 这个才算显著；以下记为小波动', 1, 30),
          numRow('moodSigDim', '显著阈值（七情）', '单根七情绝对变化 ≥ 这个才算显著', 1, 100)
        ),

        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }

    // ---- 设置 -------------------------------------------------------------
    //
    // 模块化之后这页只剩「跨模块」的项：总开关。
    // 各模块自己的配置在各自页签里（人格模式在人格页、注入预算在记忆页、心情参数在心情页）。
    function SettingsTab(props) {
      var [config, setConfig] = useState(props.state ? props.state.config : null)
      var [status, setStatus] = useState('')
      useEffect(function () {
        if (props.state && props.state.config) setConfig(props.state.config)
      }, [props.state])
      if (config === null) return h('div', { className: 'soul-empty' }, '正在加载…')

      function patch(next) {
        var merged = {}
        Object.keys(config).forEach(function (k) { merged[k] = config[k] })
        Object.keys(next).forEach(function (k) { merged[k] = next[k] })
        setConfig(merged)
        apiPost('/config', { config: merged })
          .then(function () { setStatus('已保存，下一个回合生效') })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function toggle(key, label, note) {
        return h('div', { className: 'soul-row', style: { padding: '6px 0' } },
          h('div', { className: 'soul-grow' },
            h('div', null, label),
            h('p', { className: 'soul-note' }, note)
          ),
          h('input', {
            type: 'checkbox',
            checked: config[key] !== false,
            onChange: function (e) { patch({ [key]: e.target.checked }) },
          })
        )
      }

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },
        h(Card, { title: '总开关' },
          toggle('enabled', '启用灵魂插件', '关掉后人格 / 记忆 / 目的 / 心情全部停摆，只剩设置页与工具（工具写的数据会留着）。'),
          h('p', { className: 'soul-note' }, '各模块的开关与参数在各自页签：人格 → 「人格」，注入预算与整理 → 「记忆」，惦记的事 → 「目的」，心情 → 「心情」。')
        ),
        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }

    // ---- 外壳 -------------------------------------------------------------

    function SoulSection(props) {
      var [tab, setTab] = useState('overview')
      var [state, setState] = useState(null)
      var [error, setError] = useState('')
      // 手选工作区覆盖：设置页是全局弹层，宿主经常不给 cwd —— 用户从下拉/任意目录挑一个后，全页跟着切
      var [cwdOverride, setCwdOverride] = useState('')
      var cwd = cwdOverride !== '' ? cwdOverride : cwdOf(props)

      var reload = useCallback(function () {
        apiGet('/state' + (cwd ? '?cwd=' + encodeURIComponent(cwd) : ''))
          .then(function (data) { setState(data); setError('') })
          .catch(function (e) { setError('读取失败：' + e.message + '（插件可能还没加载完）') })
      }, [cwd])

      useEffect(function () { reload() }, [reload])

      var tabs = [
        ['overview', '概览'],
        ['persona', '人格'],
        ['memory', '记忆'],
        ['purpose', '目的'],
        ['mood', '心情'],
        ['settings', '设置'],
      ]

      // 头部三个状态点：一眼看出哪里没配好
      var personaOk = Boolean(state && state.persona && state.persona.sources && state.persona.sources.length > 0)
      var memCount = state && state.memory && state.memory.global ? state.memory.global.count : 0
      var memRatio = state && state.memory && state.memory.global ? (state.memory.global.ratio || 0) : 0
      var memTone = memRatio >= 1 ? 'bad' : memRatio >= 0.8 ? 'warn' : 'ok'
      var goalCount = state && state.purpose ? state.purpose.open : 0
      var moodInfo = state && state.mood ? state.mood : null

      return h('div', { className: 'soul-app' },
        h('div', { className: 'soul-head' },
          h('div', null,
            h('p', { className: 'soul-kicker' }, 'agent soul'),
            h('h1', { className: 'soul-title' }, '灵魂'),
            h('p', { className: 'soul-sub' }, cwd === '' ? '当前没有工作目录 · 只用全局人格与全局记忆' : '工作目录：' + cwd)
          ),
          h('div', { className: 'soul-dots' },
            h(Dot, { tone: personaOk ? 'ok' : 'warn' }, personaOk ? '人格已注入' : '人格未配置'),
            h(Dot, { tone: memCount === 0 ? 'warn' : memTone }, memCount + ' 条记忆'),
            h(Dot, { tone: 'ok' }, goalCount + ' 件惦记'),
            h(Dot, { tone: moodInfo && moodInfo.mood >= 42 ? 'ok' : 'warn' }, '心情 ' + (moodInfo ? moodInfo.mood : '—'))
          )
        ),
        h('div', { className: 'soul-tabs' }, tabs.map(function (item) {
          return h('button', {
            key: item[0],
            className: 'soul-tab' + (tab === item[0] ? ' on' : ''),
            onClick: function () { setTab(item[0]) },
          }, item[1])
        })),
        h('div', { className: 'soul-body' },
          error ? h('p', { className: 'soul-err' }, error) : null,
          tab === 'overview' ? h(OverviewTab, { state: state, cwd: cwd }) : null,
          tab === 'persona' ? h(PersonaTab, {
            cwd: cwd,
            workspace: state && state.workspace,
            workspaces: state && state.workspaces,
            config: state && state.config,
            reload: reload,
            onSelectCwd: setCwdOverride,
          }) : null,
          tab === 'memory' ? h(MemoryTab, { cwd: cwd, config: state && state.config, reload: reload }) : null,
          tab === 'purpose' ? h(PurposeTab, { state: state, cwd: cwd, reload: reload }) : null,
          tab === 'mood' ? h(MoodTab, { cwd: cwd, state: state, reload: reload }) : null,
          tab === 'settings' ? h(SettingsTab, { state: state, cwd: cwd, reload: reload }) : null
        )
      )
    }

    /** 错误边界：设置页崩了要看得见原因，而不是整块白屏。 */
    function ErrorBoundary(props) {
      var [err, setErr] = useState(null)
      useEffect(function () {
        function onError(e) { setErr(e && e.message ? e.message : String(e)) }
        window.addEventListener('error', onError)
        return function () { window.removeEventListener('error', onError) }
      }, [])
      if (err !== null) {
        return h('div', { className: 'soul-app' },
          h('div', { className: 'soul-body' },
            h('div', { className: 'soul-card-h' }, h('p', { className: 'soul-card-t' }, '设置页出错了')),
            h('p', { className: 'soul-err' }, err),
            h('p', { className: 'soul-note' }, '这不影响人格与记忆本身，注入和记录都还在跑。可以点「继续」重试，或者重新加载页面。'),
            h('div', { className: 'soul-row', style: { marginTop: 10 } },
              h('button', { className: 'soul-btn', onClick: function () { setErr(null) } }, '继续'),
              h('button', { className: 'soul-btn', onClick: function () { window.location.reload() } }, '重新加载页面')
            )
          )
        )
      }
      return props.children
    }

    function apply(ctx) {
      if (typeof ctx.effect === 'function') ctx.effect(function () { return ensureStyles(ctx) }, NS + ': styles')

      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'soul',
          order: 47,
          locale: NS,
          label: function () { return '灵魂' },
        }, function (props) {
          var p = props !== null && props !== undefined ? props : {}
          return h(ErrorBoundary, null, h(SoulSection, p))
        })
      })
    }

    module.exports = { name: 'soul', inject: ['slots'], apply: apply }
    return module.exports
  },
})
