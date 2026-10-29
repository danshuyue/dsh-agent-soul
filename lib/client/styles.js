// ---- 样式 -------------------------------------------------------------
    // 片段：运行在 client.js 工厂函数作用域内。可用：document、NS（在最外层声明）。

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
      // 心情脸：跟原 dsh-feiyu-mood 同一张图（84×66 的比例），圆角 + 浅底跟它保持一致
      '.soul-mood-face img{width:104px;height:82px;object-fit:contain;border-radius:10px;background:rgba(127,127,127,.10);display:block}',
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