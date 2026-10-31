// ---- 日记 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / apiGet / apiPost / useState / useEffect / useCallback /
    //       timeLabel / cwdWithFallback。
    //
    // 设计要点：
    //   · 公开日记带预览，私密日记只显示存在性（不出服务器）
    //   · 手动触发可以带备注
    //   · 开关直接改 config（diaryEnabled）
    function DiaryTab(props) {
      var [data, setData] = useState(null)
      var [config, setConfig] = useState(props.state && props.state.config ? props.state.config : null)
      var [status, setStatus] = useState('')
      var [busy, setBusy] = useState('')
      var [noteText, setNoteText] = useState('')
      var [selectedDate, setSelectedDate] = useState('')
      // 私密正文（2026-10-31）：只在 diaryPrivateVisible=true 且本机回环时取得到
      var [privateText, setPrivateText] = useState('')

      var load = useCallback(function () {
        apiGet('/diary/list?days=14')
          .then(function (res) {
            setData(res.list || [])
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
      }, [])

      useEffect(function () { load() }, [load])

      if (config === null) return h('div', { className: 'soul-empty' }, '正在加载…')

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

      function trigger() {
        var dateStr = selectedDate || ''
        var body = {}
        if (dateStr) body.date = dateStr
        if (noteText.trim()) body.note = noteText.trim()
        setBusy('trigger')
        apiPost('/diary', body)
          .then(function (res) {
            setStatus(res.message || '已触发日记写作')
            setNoteText('')
            load()
          })
          .catch(function (e) { setStatus('触发失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function readDay(dateStr) {
        setBusy('read')
        apiGet('/diary/read?date=' + encodeURIComponent(dateStr))
          .then(function (res) {
            if (res.publicContent) {
              // 把公开日记内容显示在文本框里
              var el = document.getElementById('soul-diary-preview')
              if (el) el.value = res.publicContent
            }
            if (res.hasPrivate) {
              setStatus(config.diaryPrivateVisible === true
                ? res.date + ' 有私密日记，点「看私密」在本机查看'
                : res.date + ' 有私密日记（不出服务器，只能看文件）')
            } else {
              setStatus(res.date + ' 还没有日记')
            }
          })
          .catch(function (e) { setStatus('读取失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      // 私密日记正文（2026-10-31）：只有 diaryPrivateVisible=true 才允许点，
      // 后端还会再判一次「本机回环」。关着时按钮根本不渲染。
      function readPrivate(dateStr) {
        setBusy('private')
        apiGet('/diary/private?date=' + encodeURIComponent(dateStr))
          .then(function (res) {
            setPrivateText(res.content || '')
            var el = document.getElementById('soul-diary-private')
            if (el) el.value = res.content || ''
            setStatus(res.hasPrivate ? '已加载 ' + res.date + ' 的私密日记（仅本机可见）' : res.date + ' 没有私密日记')
          })
          .catch(function (e) { setStatus('读私密失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      // 绑定当前会话（2026-10-31）：不再自建会话，只把已有会话 id 存进配置。
      // 前端拿不到 id 时传空串，由后端取最近更新的会话并把结果回显出来。
      function bindCurrent() {
        setBusy('bind')
        apiPost('/diary/bind', { sessionId: props.sessionId || '' })
          .then(function (res) {
            if (res && res.config) setConfig(res.config)
            setStatus('已绑定日记会话：' + res.sessionId + (res.source === 'recent' ? '（设置页拿不到会话 id，取的是最近活跃会话，请核对）' : ''))
          })
          .catch(function (e) { setStatus('绑定失败：' + e.message) })
          .then(function () { setBusy('') })
      }

      function unbind() {
        setBusy('unbind')
        apiPost('/diary/unbind', {})
          .then(function (res) {
            if (res && res.config) setConfig(res.config)
            setStatus('已清除绑定：日记触发时会跳过并记日志')
          })
          .catch(function (e) { setStatus('清除失败：' + e.message) })
          .then(function () { setBusy('') })
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

      var enabled = !config || config.diaryEnabled !== false

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        // ---- 状态 ----
        // 2026-10-31 改：原来这里是「每天 22:00 到点触发」。
        // 但机器的开机时间不固定（可能一直不关，也可能几天不开），
        // 定点闹钟靠不住。现在改成「第二天写前一天的」：开机看一眼，
        // 昨天没写就补；一直不关机的，看门狗定时兜底。
        h(Card, { title: '日记' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '自动写日记'),
              h('p', { className: 'soul-note' }, '开机时写前一天的那一篇（生成公开 + 私密两篇）。关掉后不写，已有的日记保留。')
            ),
            h('input', {
              type: 'checkbox',
              checked: enabled,
              onChange: function (e) { patch({ diaryEnabled: e.target.checked }) },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('span', { className: 'soul-grow' }, '兜底检查间隔'),
            h('input', {
              className: 'soul-input',
              style: { maxWidth: 120 },
              value: (config && config.diaryWatchdogMinutes) || 30,
              spellCheck: false,
              placeholder: '30',
              onChange: function (e) {
                const n = Number(e.target.value)
                if (Number.isFinite(n) && n > 0) patch({ diaryWatchdogMinutes: n })
              },
            }),
            h('p', { className: 'soul-note', style: { flex: '1 1 100%', margin: '2px 0 0' } },
              '单位分钟，默认 30。电脑一直不关机时，每隔这么久看一眼昨天写没写。只查文件在不在，几乎不花钱。')
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '启动时补写缺失的日记'),
              h('p', { className: 'soul-note' }, '如果昨天没写，启动时会补上昨天那一篇。')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.diaryCatchUp !== false,
              onChange: function (e) { patch({ diaryCatchUp: e.target.checked }) },
            })
          )
        ),

        // ---- 绑定日记会话（2026-10-31） ----
        // 自己 agents.create 出来的会话没有宿主标准工具集，写不出文件；
        // 所以这里只负责把「已有会话」的 id 存进配置，投递时只认这个 id。
        h(Card, { title: '日记写进哪个会话', meta: '绑定已有会话，不自动创建' },
          h('p', { className: 'soul-note', style: { margin: '0 0 8px' } },
            config.diarySessionId
              ? '当前绑定：' + config.diarySessionId
              : '还没有绑定 —— 到点触发时会直接跳过并记日志（不会退回最近活跃会话）'),
          h('div', { className: 'soul-row' },
            h('button', {
              className: 'soul-btn on',
              disabled: busy === 'bind',
              onClick: bindCurrent,
            }, busy === 'bind' ? '正在绑定…' : '把当前会话指定为日记会话'),
            h('button', {
              className: 'soul-btn',
              disabled: busy === 'unbind' || !config.diarySessionId,
              onClick: unbind,
            }, '清除绑定')
          ),
          h('p', { className: 'soul-note' }, '这个 DSH 版本的设置页拿不到会话 id 时会由后端取最近活跃的会话，绑定后上面会显示实际绑定的 id，请核对一下。'),
          h('div', { className: 'soul-row', style: { padding: '6px 0', marginTop: 8 } },
            h('div', { className: 'soul-grow' },
              h('div', null, '允许在本机设置页查看私密日记'),
              h('p', { className: 'soul-note' }, '默认关闭：私密只报「存在」，正文永不出服务器。开启后也只有 127.0.0.1 回环请求能读到正文。')
            ),
            h('input', {
              type: 'checkbox',
              checked: config.diaryPrivateVisible === true,
              onChange: function (e) { patch({ diaryPrivateVisible: e.target.checked }) },
            })
          )
        ),

        // ---- 语气 ----
        h(Card, { title: '语气' },
          textRow('diaryPublicTone', '公开语气', '例：温暖但克制', '公开日记会拿给对方看，语气可以稍微收敛'),
          textRow('diaryPrivateTone', '私密语气', '例：真实、不设防', '私密日记只给自己看，可以放开写')
        ),

        // ---- 手动触发 ----
        h(Card, { title: '手动触发' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, '日期'),
            h('input', {
              className: 'soul-input',
              style: { maxWidth: 140 },
              value: selectedDate,
              spellCheck: false,
              placeholder: 'YYYY-MM-DD（默认今天）',
              onChange: function (e) { setSelectedDate(e.target.value) },
            })
          ),
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('span', { style: { flex: '0 0 72px', fontSize: 12 } }, '备注'),
            h('input', {
              className: 'soul-input',
              style: { maxWidth: 300 },
              value: noteText,
              spellCheck: false,
              placeholder: '可留空；会被加进日记素材里',
              onChange: function (e) { setNoteText(e.target.value) },
            })
          ),
          h('div', { className: 'soul-row', style: { marginTop: 8 } },
            h('button', {
              className: 'soul-btn on',
              disabled: busy === 'trigger',
              onClick: trigger
            }, busy === 'trigger' ? '正在写…' : '现在写日记'),
            h('p', { className: 'soul-note', style: { margin: 0 } }, '默认写今天，日期可以改')
          )
        ),

        // ---- 最近日记 ----
        h(Card, { title: '最近日记', meta: '公开日记可直接看，私密日记不出服务器' },
          data === null || data.length === 0
            ? h('div', { className: 'soul-empty' }, '还没有写过日记')
            : h('div', { className: 'soul-list' }, data.map(function (item) {
              return h('div', { key: item.date, className: 'soul-item' },
                h('div', { className: 'soul-item-text' },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                    h('span', null, item.date),
                    item.hasPublic ? h('span', { className: 'soul-badge vivid' }, '公开') : null,
                    item.hasPrivate ? h('span', { className: 'soul-badge clear' }, '私密') : null
                  ),
                  item.preview ? h('p', { className: 'soul-note', style: { marginTop: 4 } }, item.preview.slice(0, 120) + (item.preview.length > 120 ? '…' : '')) : null
                ),
                h('div', null,
                  item.hasPublic ? h('button', {
                    className: 'soul-btn',
                    style: { fontSize: 11, padding: '2px 8px' },
                    disabled: busy === 'read',
                    onClick: function () { readDay(item.date) }
                  }, '看全文') : null,
                  item.hasPrivate && config.diaryPrivateVisible === true ? h('button', {
                    className: 'soul-btn',
                    style: { fontSize: 11, padding: '2px 8px', marginLeft: item.hasPublic ? 6 : 0 },
                    disabled: busy === 'private',
                    onClick: function () { readPrivate(item.date) }
                  }, '看私密') : null
                )
              )
            }))
        ),

        // ---- 公开日记预览 ----
        h(Card, { title: '公开日记全文' },
          h('textarea', {
            id: 'soul-diary-preview',
            className: 'soul-textarea',
            style: { minHeight: 200, resize: 'vertical' },
            readOnly: true,
            placeholder: '点「看全文」加载某天的公开日记',
          })
        ),

        // ---- 私密日记全文（2026-10-31；开关关着就整块不渲染） ----
        config.diaryPrivateVisible === true ? h(Card, { title: '私密日记全文', meta: '仅本机回环可见' },
          h('textarea', {
            id: 'soul-diary-private',
            className: 'soul-textarea',
            style: { minHeight: 200, resize: 'vertical' },
            readOnly: true,
            value: privateText,
            onChange: function () {},
            placeholder: '点某一天的「看私密」加载',
          })
        ) : null,

        // ---- 数值 ----
        h(Card, { title: '数值' },
          numRow('diaryBackfillDays', '参考天数', '写新日记时读最近几天的旧日记', 1, 14),
          numRow('diaryMaxConversationChars', '对话截断', '摘要前的对话字数上限（超了截断）', 1000, 32000),
          numRow('diaryMaxSummaryChars', '摘要上限', '压缩后摘要的最大字数', 500, 8000),
          numRow('diaryJsonlKeepDays', '对话保留天数', 'JSONL 文件保留多久（超了删掉）', 1, 30),
          h('p', { className: 'soul-note', style: { margin: '8px 0 6px' } }, '摘要模型（留空 = 跟随会话模型）'),
          textRow('diarySummarizeProvider', 'provider', '例：deepseek'),
          textRow('diarySummarizeModel', 'model', '例：deepseek-chat')
        ),

        status ? h('p', { className: 'soul-meta' }, status) : null
      )
    }
