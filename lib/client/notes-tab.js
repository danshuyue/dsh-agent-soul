// ---- 笔记 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。
    // 可用：h / Card / Switch / apiGet / apiPost / useState / useEffect / useCallback。
    //
    // 这是她自己写的东西，所以界面只做「看 / 改 / 删」，不去评价内容好坏 ——
    // 加个"质量分"之类的反而变成在替她打分，不是这个功能该干的事。

    function NotesTab(props) {
      var [notes, setNotes] = useState(null)
      var [selected, setSelected] = useState('')
      var [draftTitle, setDraftTitle] = useState('')
      var [draftContent, setDraftContent] = useState('')
      var [status, setStatus] = useState('')
      var [busy, setBusy] = useState(false)
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
        apiGet('/notes/list')
          .then(function (data) { setNotes(data.notes || []); setStatus('') })
          .catch(function (e) { setStatus('读取失败：' + e.message); setNotes([]) })
      }, [])

      useEffect(function () { load() }, [load])

      function open(entry) {
        apiGet('/notes/read?title=' + encodeURIComponent(entry.title))
          .then(function (data) {
            setSelected(entry.title)
            setDraftTitle(entry.title)
            setDraftContent(data.text || '')
            setStatus('')
          })
          .catch(function (e) { setStatus('打开失败：' + e.message) })
      }

      function newNote() {
        setSelected('')
        setDraftTitle('')
        setDraftContent('')
        setStatus('新的一篇：填个标题就能写')
      }

      function save() {
        var title = draftTitle.trim()
        if (title === '') { setStatus('标题不能空'); return }
        if (draftContent.trim() === '') { setStatus('正文不能空'); return }
        setBusy(true)
        // 改了标题要先把文件改名，再按新标题保存 —— 否则会变成"新建一篇 + 旧的那篇还在"
        var renamed = selected !== '' && selected !== title
          ? apiPost('/notes/rename', { title: selected, newTitle: title })
          : Promise.resolve(null)
        renamed.then(function () {
          // overwrite:true 是必须的（2026-11-04 回归修复）：
          // 后端在 B8 之后默认拒绝覆盖已存在的笔记（跟 soul_note 工具口径一致），
          // 但设置页点「保存」本来就是人看着正文点的，语义就是「用我改的这版替换掉」。
          // 少了这个字段，改一个字都会 400「已经存在」。
          return apiPost('/notes/save', { title: title, content: draftContent, overwrite: true })
        }).then(function () {
          setSelected(title)
          setStatus('已保存')
          load()
        }).catch(function (e) {
          setStatus('保存失败：' + e.message)
        }).then(function () { setBusy(false) })
      }

      function remove() {
        if (selected === '') return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm('删掉《' + selected + '》？（会放进回收站，还能找回来）')) return
        }
        apiPost('/notes/delete', { title: selected })
          .then(function () {
            setSelected('')
            setDraftTitle('')
            setDraftContent('')
            setStatus('已删除（在 notes/trash/ 里）')
            load()
          })
          .catch(function (e) { setStatus('删除失败：' + e.message) })
      }

      var list = notes || []

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12 } },

        h(Card, { title: '她的笔记本（' + list.length + ' 篇）', meta: '她自己写的，不会淡忘' },
          h('p', { className: 'soul-note' },
            '这个标签页只做三件事：看她写了什么、改、删。写是她自己的事 —— 她在对话里觉得有话要说时，会自己用 soul_note 建一篇。'
            + '文件放在 ~/.dsh/agents/notes/，你也能直接用编辑器打开。'
          ),
          list.length === 0
            ? h('div', { className: 'soul-empty' }, '还没写过东西。等她在对话里想到什么，这里就会长出来')
            : h('div', { className: 'soul-list' }, list.map(function (entry) {
              return h('div', {
                key: entry.slug,
                className: 'soul-item',
                style: { cursor: 'pointer' },
                onClick: function () { open(entry) },
              },
                h('div', { className: 'soul-item-text' },
                  h('div', { style: { fontWeight: selected === entry.slug ? 500 : 400 } }, entry.title),
                  h('div', { className: 'soul-meta' },
                    entry.chars + ' 字 · ' + timeLabel(entry.updatedAt)
                    + (entry.summary ? ' · ' + entry.summary : '')
                  )
                ),
                h('span', { className: 'soul-badge' }, selected === entry.slug ? '正在看' : '打开')
              )
            })),
          h('div', { className: 'soul-row', style: { marginTop: 10 } },
            h('button', { className: 'soul-btn on', onClick: newNote }, '新建一篇'),
            h('button', { className: 'soul-btn', onClick: load }, '刷新')
          )
        ),

        h(Card, { title: selected === '' ? '写新的一篇' : '编辑《' + selected + '》', meta: draftContent.length + ' 字' },
          h('div', { className: 'soul-row', style: { padding: '4px 0' } },
            h('span', { style: { width: 48, fontSize: 12 } }, '标题'),
            h('input', {
              className: 'soul-input soul-grow',
              value: draftTitle,
              placeholder: '比如：关于树树的观察 / 我想问的事',
              onChange: function (e) { setDraftTitle(e.target.value) },
            })
          ),
          h('textarea', {
            className: 'soul-textarea',
            style: { minHeight: 260, marginTop: 8, width: '100%' },
            value: draftContent,
            placeholder: '写点想留下来的东西。md 格式，可以分段。',
            onChange: function (e) { setDraftContent(e.target.value) },
          }),
          h('div', { className: 'soul-row', style: { marginTop: 10 } },
            h('button', {
              className: 'soul-btn on',
              disabled: busy,
              onClick: save,
            }, busy ? '保存中…' : '保存'),
            selected === ''
              ? null
              : h('button', { className: 'soul-btn danger', disabled: busy, onClick: remove }, '删掉这篇'),
            status === '' ? null : h('span', { className: 'soul-meta' }, status)
          )
        ),

        h(Card, { title: '笔记注入' },
          h('div', { className: 'soul-row', style: { padding: '6px 0' } },
            h('div', { className: 'soul-grow' },
              h('div', null, '把笔记索引注入提示词'),
              h('p', { className: 'soul-note' },
                '只注入「标题 + 字数 + 摘要」，正文她自己要用 soul_note 读。关掉之后她就不知道自己写过什么了 —— 但文件还在。'
              )
            ),
            h(Switch, {
              checked: config.notesEnabled !== false,
              label: config.notesEnabled !== false ? '开' : '关',
              onChange: function (e) { patchConfig({ notesEnabled: e.target.checked }) },
            })
          )
        )
      )
    }
