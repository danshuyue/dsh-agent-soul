// ---- 心情 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / apiGet / apiPost / useState / useEffect / useCallback /
    //       timeLabel / MOOD_DIMS / MOOD_FACE_URL。
    //
    // 布局参考 feiyu-mood 的设置页：hero（表情 + 大数字 + 最近理由）→ 七情 → 时间线 → 判断配置。
    // 跟它不一样的两处（都是刻意的）：
    //   · 没有「每回合注入」区块 —— 心情只记账，不进提示词；
    //   · 没有「挂饰」页 —— 不要右下角那套。
    function MoodTab(props) {
      var cwd = cwdWithFallback(props)
      var [data, setData] = useState(null)
      var [config, setConfig] = useState(props.state && props.state.config ? props.state.config : null)
      var [status, setStatus] = useState('')
      var [busy, setBusy] = useState('')
      // 密钥输入草稿：只活在页面上，保存后立刻清空，绝不留明文在内存里过夜
      var [secretDraft, setSecretDraft] = useState({})
      function setSecretDraftFor(name, value) {
        var next = {}
        Object.keys(secretDraft || {}).forEach(function (k) { next[k] = secretDraft[k] })
        next[name] = value
        setSecretDraft(next)
      }

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
        // 2026-11-07 R8（P2-25/26）：
        //   ① 只把**改动过的键**发上去 —— 服务端 saveConfig 是按 key 合并的，
        //      发全量会让「另一个标签页刚改的项」被这份旧快照覆盖；
        //   ② 同一个输入框连续敲键只发最后一次（300ms 防抖）。
        var changed = {}
        Object.keys(next).forEach(function (k) {
          if (next[k] !== base[k]) changed[k] = next[k]
        })
        if (Object.keys(changed).length === 0) {
          setStatus('已保存，下一个回合生效')
          return
        }
        apiPostDebounced('config:mood', '/config', { config: changed }, 300)
          .then(function () { setStatus('已保存，下一个回合生效') })
          .catch(function (e) { setStatus('保存失败：' + e.message) })
      }

      function reset() {
        // 2026-11-04 修 B8：重置是**不可逆**的 —— 200 条时间线一起没，
        // 而且服务端直接拿空状态覆盖。这种操作必须有二次确认。
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('把心情重置回基准？时间线里记着的那些情绪会一起清掉，不能撤销。')) return
        }
        setBusy('reset')
        apiPost('/mood/reset', { cwd: cwd })
          .then(function () { setStatus('已重置回基准心情'); load() })
          .catch(function (e) { setStatus('重置失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      // 2026-11-04：`min`/`max` 对 type=number 只是**校验提示**，不会拦住输入，
      // 也不会纠正已有的越界值。所以这里自己做一遍夹取 —— 显示和保存都夹。
      // 起因：「每几轮挂一次」滑块下限写 1，可选 1，但运行时恒按 2 执行（语气消息
      // 要到下一个 step 才被取走，1 会自持），界面却不给任何提示。
      // 与其在 UI 上留一个永远不生效的选项，不如直接不给选。
      function clampVal(raw, lo, hi) {
        var n = Number(raw)
        if (isNaN(n)) return raw
        if (typeof lo === 'number' && n < lo) return lo
        if (typeof hi === 'number' && n > hi) return hi
        return n
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
            value: (config && config[key] != null) ? clampVal(config[key], min, max) : '',
            onChange: function (e) {
              var v = Number(e.target.value)
              if (!isNaN(v)) patch({ [key]: clampVal(v, min, max) })
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

      // 密钥行：输入框永远是空的，只显示「已保存/未配置」。
      // 已经存过的密钥不会再回显 —— 服务端只报状态，不回明文。
      function secretRow(name, label, note) {
        var info = (data && data.secrets) ? data.secrets[name] : null
        var saved = !!(info && info.exists)
        return h('div', { className: 'soul-row' },
          h('span', { style: { flex: '0 0 92px', fontSize: 12 } }, label),
          h('input', {
            className: 'soul-input',
            type: 'password',
            style: { maxWidth: 220 },
            value: secretDraft[name] || '',
            spellCheck: false,
            autoComplete: 'off',
            placeholder: saved ? '已保存（重新输入可覆盖）' : '粘贴密钥后点保存',
            onChange: function (e) { setSecretDraftFor(name, e.target.value) },
          }),
          h('button', {
            className: 'soul-btn',
            style: { marginLeft: 8 },
            onClick: function () {
              var value = secretDraft[name] || ''
              if (!value) { setStatus('先粘贴密钥'); return }
              apiPost('/secret', { name: name, value: value })
                .then(function (res) {
                  setSecretDraftFor(name, '')
                  setStatus(res.encrypted ? '密钥已加密保存（DPAPI）' : '密钥已保存（明文+0600，本机）')
                  load()
                })
                .catch(function (e) { setStatus('保存密钥失败：' + e.message) })
            },
          }, '保存'),
          h('span', { className: 'soul-meta', style: { marginLeft: 8 } },
            saved ? (info.encrypted ? '已保存 · 加密' : '已保存') : '未配置'),
          note ? h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } }, note) : null
        )
      }

      // 七情显示用百分比（后端按「满格 20」折算好），原始值只在后台算
      var dimsPct = (data && data.dimsPercent) || {}
      var timeline = (data && data.timeline) || []
      var enabled = !config || config.moodEnabled !== false

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        // ---- hero：此刻心情 ----
        h(Card, {
          title: '此刻心情',
          meta: data && data.updatedAt ? '上次变动 ' + timeLabel(new Date(data.updatedAt).toISOString()) : ''
        },
          h('div', { className: 'soul-mood-hero' },
            h('div', { className: 'soul-mood-face' },
              h('img', {
                src: MOOD_FACE_URL + ((data && data.face) || 'ok') + '.png',
                alt: (data && data.label) || '心情',
                title: (data && data.label) || ''
              })),
            h('div', null,
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
          h('p', { className: 'soul-note' }, '心情是基调，每轮只挪判定值的 1/3，几轮才走得动一格；七情即时变、90 分钟散一半。**不注入提示词**，只记账 —— 但会喂给日记当底色、推着「惦记」的驱动。')
        ),

        // ---- 七情 ----
        h(Card, { title: '七情', meta: data && data.top && data.top.length ? '最突出：' + data.top.map(function (t) { return t.label + ' ' + t.p + '%' }).join(' / ') : '' },
          h('div', null, MOOD_DIMS.map(function (pair) {
            var pct = Math.round(dimsPct[pair[0]] || 0)
            return h('div', { key: pair[0], className: 'soul-dim' },
              h('span', { className: 'soul-dim-name' }, pair[1]),
              h('div', { className: 'soul-meter soul-grow', style: { margin: 0 } },
                h('div', {
                  className: 'soul-meter-fill',
                  style: {
                    width: pct + '%',
                    background: pct >= 60 ? 'var(--soul-brand)' : pct >= 30 ? '#ffb020' : 'rgba(127,127,127,.25)'
                  }
                })
              ),
              h('span', { className: 'soul-dim-val' }, pct + '%')
            )
          })),
          h('p', { className: 'soul-note' }, '百分比按「满格 20」折算：判定单次上限 ±10，实测一天峰值在 13 上下 —— 所以「踏实 60%」已经是很踏实了，不是刚过一半。')
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
          // 2026-11-04：字段统一成 ownerName（旧的 moodOwnerName 只做迁移）。
          // 留空时提示词里「关系 / 性别 / 称呼」那几句整句不注入。
          textRow('ownerName', '叫你', '去「设置」页填', '留空 = 提示词里关系 / 性别那几句不注入'),
          textRow('moodSelfAliases', '别名', '例：糖糖、小糖'),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '判断模型（留空 = 跟随会话模型）'),
          textRow('moodJudgeProvider', 'provider', '例：siliconflow'),
          textRow('moodJudgeModel', 'model', '例：Qwen/Qwen2.5-7B-Instruct'),
          secretRow('siliconflow', '硅基流动密钥', 'provider 填 siliconflow 时用这个；密钥加密后存在本机，页面上不会再显示'),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } },
            '心情语气（挂在消息后，系统提示一个字不动）'),
          h('div', { className: 'soul-row' },
            h('span', { className: 'soul-grow' }, '往消息后挂一行心情'),
            h('input', {
              type: 'checkbox',
              checked: config ? config.moodToneInject !== false : true,
              onChange: function (e) { patch({ moodToneInject: e.target.checked }) },
            })
          ),
          // 下限 2：语气是往下一条消息上挂的（inbox next-step），要到下一个 step 才被取走 ——
          // 设成 1 等于每步都投、每步又催生下一步，会自持循环。所以界面上不给 1 这个选项。
          numRow('moodToneEveryTurns', '每几轮挂一次', '中档不挂；心情偏高或偏低时才挂，隔这么多轮盖一次戳。最低 2 —— 每轮都挂会自己催生下一轮', 2, 50),
          numRow('moodToneThreshold', '偏离多少算低/高', '离基准超过这个值才分档，否则算中档（什么都不挂）', 3, 40),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '数值'),
          numRow('moodBase', '基准心情', '心情漂移后往这里回落（0~100）', 30, 100),
          numRow('moodFloor', '心情下限', '再难过也不跌破这条线（0~100）', 0, 100),
          numRow('moodDecayHalfHours', '回落半衰期（小时）', '心情向基准回落一半要多久；七情固定 90 分钟归零', 1, 168),
          numRow('moodSigMood', '显著阈值（心情）', '判定值绝对变化 ≥ 这个才算显著；以下记为小波动', 1, 30),
          numRow('moodSigDim', '显著阈值（七情）', '单根七情绝对变化 ≥ 这个才算显著（按原始判定值算，满格 20）', 1, 100)
        ),

        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }