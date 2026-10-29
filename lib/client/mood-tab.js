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