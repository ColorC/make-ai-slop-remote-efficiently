// ui.js — 液态玻璃组件套件(lg-)。全部纯 vanilla,函数式 API。
//   浮层:openSheet / openMenu / openModal(入栈 layers,closeTopLayer 给返回键)
//   构造:listRow / emptyState / fab / segmented / swipeRow / largeHeader
//   全局:banner(连接状态条,由 core 连接健康驱动)
// 玻璃只属于浮层/导航;内容层(行/卡/正文)实底。CSS 在 css/components.css。

import { esc } from './core.js'

const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : ((cb) => setTimeout(cb, 0))

// ── 常用图标(供各 view 复用,统一线条风格:24 viewBox · stroke=currentColor · 2 宽 · 圆角线帽) ──
export const icons = {
  back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/></svg>',
  chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  term: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>',
  link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  // W2 emoji 清零补充:长按菜单/启动器回退/详情徽标/工具卡状态/终端键盘钮
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
  flag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7"/></svg>',
  compress: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>',
  archive: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/></svg>',
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16zM3.27 6.96L12 12.01l8.73-5.05M12 22.08V12"/></svg>',
  warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0zM12 9v4M12 17h.01"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z"/></svg>',
  keyboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  // V2 波二:filterbar/picker/TOC 补充
  filter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16M7 12h10M10 18h4"/></svg>',
  chevD: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  list: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5h12M9 12h12M9 19h12M4 5h.01M4 12h.01M4 19h.01"/></svg>',
}

// ── 层栈管理:sheet/menu/modal 入栈,closeTopLayer 给返回键兜底 ────────────────
export const layers = []
function pushLayer(obj) { layers.push(obj); return obj }
function popLayer(obj) { const i = layers.indexOf(obj); if (i >= 0) layers.splice(i, 1) }
export function closeTopLayer() {
  const top = layers[layers.length - 1]
  if (!top) return false
  top.close()
  return true
}

// 长按(触屏 550ms / 鼠标右键)→ 回调,带 500ms 移动取消
function longpress(el, fn) {
  let t = null, sx = 0, sy = 0
  const clear = () => { if (t) { clearTimeout(t); t = null } }
  el.addEventListener('touchstart', (e) => {
    sx = e.touches[0].clientX; sy = e.touches[0].clientY
    t = setTimeout(() => { t = null; fn(e) }, 550)
  }, { passive: true })
  el.addEventListener('touchmove', (e) => {
    if (t && (Math.abs(e.touches[0].clientX - sx) > 10 || Math.abs(e.touches[0].clientY - sy) > 10)) clear()
  }, { passive: true })
  el.addEventListener('touchend', clear)
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(e) })
}

// ════ 底部 sheet ════
// openSheet({ title?, rows, onClose?, id? }) → { close, el }
// rows[i] 类型:header / divider / empty / row / action / radio / item / big
//   row:   { label, value?, muted?, disabled?, chev?, sub?, k?, onTap }
//   action:{ icon?, label, danger?, k?, onTap }   icon 为可信 html 片段(图标 SVG),不转义
//   radio: { label, on?, disabled?, sub?, k?, onTap }   点选即生效并自动收起
//   item:  { html, k?, onTap }
//   big:   { label, sub?, k?, onTap }                   醒目主行(继续上次配置等)
// onTap(close) 收到关闭函数,便于"关 sheet → 再开别的层"。
export function openSheet(opts) {
  opts = opts || {}
  const rows = opts.rows || []
  const ov = document.createElement('div'); ov.className = 'lg-ov lg-sheet-ov'
  const idAttr = opts.id ? (' id="' + esc(opts.id) + '"') : ''
  const parts = ['<div class="lg-sheet"' + idAttr + ' role="dialog"><div class="lg-sheet-handle"></div>']
  if (opts.title) parts.push('<div class="lg-sheet-title">' + esc(opts.title) + '</div>')
  parts.push('<div class="lg-sheet-body">')
  rows.forEach((r, i) => {
    const k = r.k ? (' data-k="' + esc(r.k) + '"') : ''
    if (r.type === 'divider') { parts.push('<div class="lg-sheet-div"></div>'); return }
    if (r.type === 'header') { parts.push('<div class="lg-sheet-header">' + esc(r.label) + '</div>'); return }
    if (r.type === 'empty') { parts.push('<div class="lg-sheet-empty">' + esc(r.label) + '</div>'); return }
    if (r.type === 'action') {
      parts.push('<button class="lg-sheet-action' + (r.danger ? ' danger' : '') + '" data-i="' + i + '"' + k + '>' +
        (r.icon != null ? '<span class="lg-sheet-action-ic">' + r.icon + '</span>' : '') +
        '<span class="lg-sheet-l">' + esc(r.label) + '</span></button>')
      return
    }
    if (r.type === 'radio') {
      parts.push('<button class="lg-sheet-radio' + (r.on ? ' on' : '') + (r.disabled ? ' disabled' : '') + '" data-i="' + i + '"' + k +
        (r.disabled ? ' aria-disabled="true"' : '') + '>' +
        '<span class="lg-sheet-l">' + esc(r.label) + (r.sub ? '<span class="lg-sheet-sub">' + esc(r.sub) + '</span>' : '') + '</span>' +
        '<span class="lg-radio-mark"></span></button>')
      return
    }
    if (r.type === 'item') {
      parts.push('<button class="lg-sheet-item" data-i="' + i + '"' + k + '>' + (r.html || '') + '</button>')
      return
    }
    if (r.type === 'big') {
      parts.push('<button class="lg-sheet-row lg-sheet-big" data-i="' + i + '"' + k + '>' +
        '<span class="lg-sheet-l">' + esc(r.label) + (r.sub ? '<span class="lg-sheet-sub">' + esc(r.sub) + '</span>' : '') + '</span></button>')
      return
    }
    parts.push('<button class="lg-sheet-row' + (r.chev ? ' chev' : '') + (r.disabled ? ' disabled' : '') + '" data-i="' + i + '"' + k +
      (r.disabled ? ' aria-disabled="true"' : '') + '>' +
      '<span class="lg-sheet-l">' + esc(r.label) + (r.sub ? '<span class="lg-sheet-sub">' + esc(r.sub) + '</span>' : '') + '</span>' +
      '<span class="lg-sheet-v' + (r.muted ? ' muted' : '') + '">' + esc(r.value != null ? r.value : '') + '</span></button>')
  })
  parts.push('</div></div>')
  ov.innerHTML = parts.join('')
  document.body.appendChild(ov)
  raf(() => ov.classList.add('show'))

  let closed = false
  const close = () => {
    if (closed) return; closed = true
    popLayer(layer)
    ov.classList.remove('show'); ov.style.pointerEvents = 'none'
    setTimeout(() => { try { document.body.removeChild(ov) } catch (e) {} }, 220)
    if (typeof opts.onClose === 'function') opts.onClose()
  }
  const layer = pushLayer({ close })

  Array.prototype.forEach.call(ov.querySelectorAll('[data-i]'), (el) => {
    const r = rows[Number(el.getAttribute('data-i'))]
    if (!r || r.disabled) return
    el.addEventListener('click', () => {
      if (typeof r.onTap === 'function') r.onTap(close)
      if (r.type === 'radio') close()   // radio 即选即收起
    })
  })
  ov.addEventListener('click', (e) => { if (e.target === ov) close() })

  const handle = ov.querySelector('.lg-sheet-handle')
  if (handle) {
    let y0 = null
    handle.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY }, { passive: true })
    handle.addEventListener('touchmove', (e) => { if (y0 != null && e.touches[0].clientY - y0 > 60) { y0 = null; close() } }, { passive: true })
    handle.addEventListener('touchend', () => { y0 = null })
  }
  return { close, el: ov }
}

// ════ 锚点上下文菜单 ════
// openMenu({ anchor, items }) → { close }。items=[{icon?,label,danger?,onTap}];icon 为可信 html 片段(图标 SVG),不转义
export function openMenu(opts) {
  opts = opts || {}
  const items = opts.items || []
  const ov = document.createElement('div'); ov.className = 'lg-menu-ov'
  const menu = document.createElement('div'); menu.className = 'lg-menu'
  menu.innerHTML = items.map((it, i) =>
    '<button class="lg-menu-item' + (it.danger ? ' danger' : '') + '" data-i="' + i + '">' +
    (it.icon != null ? '<span class="lg-menu-ic">' + it.icon + '</span>' : '') +
    '<span>' + esc(it.label) + '</span></button>').join('')
  ov.appendChild(menu); document.body.appendChild(ov)

  // 锚点定位:菜单右上角对齐锚点右下,越界回夹
  const a = opts.anchor && opts.anchor.getBoundingClientRect ? opts.anchor.getBoundingClientRect() : { right: window.innerWidth - 12, bottom: 60 }
  const mw = menu.offsetWidth, mh = menu.offsetHeight
  let left = Math.max(8, Math.min(a.right - mw, window.innerWidth - mw - 8))
  let top = a.bottom + 6
  if (top + mh > window.innerHeight - 8) top = Math.max(8, a.top - mh - 6)
  menu.style.left = left + 'px'; menu.style.top = top + 'px'
  raf(() => menu.classList.add('show'))

  let closed = false
  const close = () => {
    if (closed) return; closed = true
    popLayer(layer)
    menu.classList.remove('show')
    setTimeout(() => { try { document.body.removeChild(ov) } catch (e) {} }, 180)
  }
  const layer = pushLayer({ close })
  Array.prototype.forEach.call(menu.querySelectorAll('[data-i]'), (el) => {
    const it = items[Number(el.getAttribute('data-i'))]
    el.addEventListener('click', () => { close(); if (typeof it.onTap === 'function') it.onTap() })
  })
  ov.addEventListener('click', (e) => { if (e.target === ov) close() })
  return { close }
}

// ════ 确认 / 输入弹窗 ════
// openModal({ title, body?, input?, textarea?, value?, placeholder?, okText?, cancelText?, danger?, onOk?, onCancel? }) → { close }
export function openModal(opts) {
  opts = opts || {}
  const ov = document.createElement('div'); ov.className = 'lg-ov lg-modal-ov'
  const wantInput = !!(opts.input || opts.textarea)
  const field = opts.textarea
    ? '<textarea class="lg-modal-in" rows="4" placeholder="' + esc(opts.placeholder || '') + '">' + esc(opts.value || '') + '</textarea>'
    : (opts.input ? '<input class="lg-modal-in" placeholder="' + esc(opts.placeholder || '') + '" value="' + esc(opts.value || '') + '">' : '')
  ov.innerHTML =
    '<div class="lg-modal" role="dialog">' +
    '<div class="lg-modal-title">' + esc(opts.title || '') + '</div>' +
    (opts.body ? '<div class="lg-modal-body">' + esc(opts.body) + '</div>' : '') +
    field +
    '<div class="lg-modal-btns">' +
    '<button class="lg-btn ghost lg-modal-cancel">' + esc(opts.cancelText || '取消') + '</button>' +
    '<button class="lg-btn lg-modal-ok' + (opts.danger ? ' danger' : '') + '">' + esc(opts.okText || '确定') + '</button>' +
    '</div></div>'
  document.body.appendChild(ov)
  raf(() => ov.classList.add('show'))
  const inp = ov.querySelector('.lg-modal-in')
  if (inp) setTimeout(() => { try { inp.focus() } catch (e) {} }, 60)

  let closed = false
  const close = () => {
    if (closed) return; closed = true
    popLayer(layer)
    ov.classList.remove('show'); ov.style.pointerEvents = 'none'
    setTimeout(() => { try { document.body.removeChild(ov) } catch (e) {} }, 180)
  }
  const layer = pushLayer({ close })
  const cancel = () => { close(); if (typeof opts.onCancel === 'function') opts.onCancel() }
  ov.querySelector('.lg-modal-cancel').addEventListener('click', cancel)
  ov.querySelector('.lg-modal-ok').addEventListener('click', () => {
    const v = wantInput ? (inp ? inp.value : '') : true
    close(); if (typeof opts.onOk === 'function') opts.onOk(v)
  })
  ov.addEventListener('click', (e) => { if (e.target === ov) cancel() })
  return { close }
}

// ════ 列表行构造器 ════
// listRow({ icon?, iconClass?, title, sub?, metaRight?, side?, info?, dataSt?, statusDot?, onTap?, onLongPress? }) → 行 DOM
// icon/metaRight/side 允许可信 html 片段(内部图标/spinner/徽章);title/sub 转义。
// side = 行尾侧栈(.lg-row-side:dim 时间 + 徽章);info = 行尾 ⓘ 预览钮(点击在 onTap 里 e.target.closest('.lr-info') 分流);
// dataSt = data-st 属性(蓝图边界语言:recover=dashed 未探索)。
export function listRow(o) {
  o = o || {}
  const b = document.createElement('button'); b.className = 'lg-row'
  b.innerHTML =
    '<span class="lg-row-icon ' + (o.iconClass || '') + '">' + (o.icon || '') +
    (o.statusDot ? '<span class="lg-row-dot ' + esc(o.statusDot) + '"></span>' : '') + '</span>' +
    '<span class="lg-row-body"><span class="lg-row-title">' + esc(o.title || '') + '</span>' +
    (o.sub ? '<span class="lg-row-sub">' + esc(o.sub) + '</span>' : '') + '</span>' +
    (o.side ? '<span class="lg-row-side">' + o.side + '</span>' : '') +
    (o.metaRight ? '<span class="lg-row-meta">' + o.metaRight + '</span>' : '') +
    (o.info ? '<span class="lr-info" role="button" aria-label="预览">' + icons.info + '</span>' : '')
  if (o.dataSt) b.setAttribute('data-st', o.dataSt)
  if (typeof o.onTap === 'function') b.addEventListener('click', o.onTap)
  if (typeof o.onLongPress === 'function') longpress(b, o.onLongPress)
  return b
}

// ════ 空态 ════
export function emptyState(o) {
  o = o || {}
  const d = document.createElement('div'); d.className = 'lg-empty'
  d.innerHTML =
    (o.icon ? '<div class="lg-empty-icon">' + o.icon + '</div>' : '') +
    '<div class="lg-empty-title">' + esc(o.title || '暂无内容') + '</div>' +
    (o.hint ? '<div class="lg-empty-hint">' + esc(o.hint) + '</div>' : '')
  if (o.action && o.action.label) {
    const btn = document.createElement('button'); btn.className = 'lg-empty-action'; btn.textContent = o.action.label
    if (typeof o.action.onTap === 'function') btn.addEventListener('click', o.action.onTap)
    d.appendChild(btn)
  }
  return d
}

// ════ FAB ════
export function fab(o) {
  o = o || {}
  const b = document.createElement('button'); b.className = 'lg-fab'
  if (o.id) b.id = o.id
  b.innerHTML = o.icon || icons.plus
  if (typeof o.onTap === 'function') b.addEventListener('click', o.onTap)
  return b
}

// ════ 分段控件 ════
// segmented(el, { options:[{value,label,count?}], value?, onChange? }) → { set, setOptions, value }
// count = 蓝图计数(窄档尺寸标注 ← N →,真实数据);setOptions 保当前值重渲(轮询刷新不丢选中)。
export function segmented(el, o) {
  o = o || {}
  let opts = o.options || []
  let cur = o.value != null ? o.value : (opts[0] && opts[0].value)
  el.className = 'lg-seg'
  const render = () => {
    el.innerHTML = opts.map((op) =>
      '<button data-v="' + esc(op.value) + '"' + (op.value === cur ? ' class="on"' : '') + '>' +
      esc(op.label) +
      (op.count != null ? '<span class="ct"><span class="lg-dim sm"><i></i><b>' + esc(String(op.count)) + '</b><i></i></span></span>' : '') +
      '</button>').join('')
    Array.prototype.forEach.call(el.querySelectorAll('button'), (b) => {
      b.addEventListener('click', () => { cur = b.getAttribute('data-v'); render(); if (typeof o.onChange === 'function') o.onChange(cur) })
    })
  }
  render()
  return {
    set: (v) => { cur = v; render() },
    setOptions: (next) => { opts = next || []; if (!opts.some((op) => op.value === cur)) cur = opts[0] && opts[0].value; render() },
    value: () => cur,
  }
}

// ════ 标签多选筛选 picker(V2 波二:按钮面计数 + 描图纸弹层 check row) ════
// tagPicker(el, { label, options:[{value,label,count?}], selected?:string[], onChange?(values) })
// → { setOptions, values, close }。多选集合由调用方持有;清除/全选内建。
export function tagPicker(el, o) {
  o = o || {}
  let opts = o.options || []
  let sel = new Set(o.selected || [])
  el.className = 'lg-tagpicker'
  const btnHtml = () =>
    '<button class="tpk-btn" aria-expanded="false" aria-haspopup="true">' + icons.filter +
    '<span>' + esc(o.label || '筛选') + '</span>' +
    '<span class="tpk-n"' + (sel.size ? '' : ' style="display:none"') + '>' + sel.size + '</span>' + icons.chevD + '</button>'
  const rowsHtml = () =>
    '<div class="tpk-h">' + esc(o.label || '筛选') + '(多选)</div>' +
    opts.map((op) =>
      '<button class="lg-check" role="checkbox" data-v="' + esc(op.value) + '" aria-checked="' + (sel.has(op.value) ? 'true' : 'false') + '">' +
      '<span class="cb">' + icons.check + '</span><span class="cr-t">' + esc(op.label) + '</span>' +
      (op.count != null ? '<span class="cr-d">' + esc(String(op.count)) + '</span>' : '') + '</button>').join('') +
    '<div class="tpk-foot"><button data-act="clear">清除</button><button data-act="all">全选</button></div>'
  const render = () => { el.innerHTML = btnHtml() + '<div class="tpk-pop" role="group" aria-label="' + esc(o.label || '筛选') + '">' + rowsHtml() + '</div>' }
  render()
  const fire = () => { if (typeof o.onChange === 'function') o.onChange(Array.from(sel)) }
  const syncBadge = () => {
    const n = el.querySelector('.tpk-n'); if (!n) return
    n.textContent = String(sel.size); n.style.display = sel.size ? '' : 'none'
  }
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('.tpk-btn')
    if (btn) {
      const open = !el.classList.contains('open')
      el.classList.toggle('open', open); btn.setAttribute('aria-expanded', open ? 'true' : 'false')
      return
    }
    const act = e.target.closest('[data-act]')
    if (act) {
      if (act.getAttribute('data-act') === 'all') sel = new Set(opts.map((op) => op.value))
      else sel = new Set()
      render(); syncBadge(); fire(); return
    }
    const row = e.target.closest('.lg-check[data-v]')
    if (row) {
      const v = row.getAttribute('data-v')
      if (sel.has(v)) sel.delete(v); else sel.add(v)
      row.setAttribute('aria-checked', sel.has(v) ? 'true' : 'false')
      syncBadge(); fire()
    }
  })
  // 外部点击收起(捕获阶段,点开别的 picker 也一并收)
  document.addEventListener('click', (e) => { if (!e.target.closest || !e.target.closest('.lg-tagpicker')) close() }, true)
  const close = () => {
    el.classList.remove('open')
    const b = el.querySelector('.tpk-btn'); if (b) b.setAttribute('aria-expanded', 'false')
  }
  return {
    setOptions: (next) => { opts = next || []; sel = new Set(Array.from(sel).filter((v) => opts.some((op) => op.value === v))); render(); syncBadge() },
    values: () => Array.from(sel),
    close,
  }
}

// ════ 悬浮预览卡(hover 设备专用;触屏等价=ⓘ 底部 sheet,MAPPING #13) ════
// 单例 + 250ms enter 延迟 + 150ms leave 延迟 + 悬停驻留 + 滚动即收。
let _pv = null, _pvShowT = null, _pvHideT = null
function _pvEl() {
  if (_pv) return _pv
  _pv = document.createElement('div'); _pv.className = 'lg-preview'
  document.body.appendChild(_pv)
  _pv.addEventListener('mouseenter', () => { if (_pvHideT) { clearTimeout(_pvHideT); _pvHideT = null } })
  _pv.addEventListener('mouseleave', schedulePreviewHide)
  return _pv
}
function _pvCanHover() {
  try { return typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches } catch (e) { return false }
}
export function showPreview(anchor, html) {
  if (!_pvCanHover() || !anchor) return
  const el = _pvEl()
  if (_pvShowT) clearTimeout(_pvShowT)
  if (_pvHideT) { clearTimeout(_pvHideT); _pvHideT = null }
  _pvShowT = setTimeout(() => {
    _pvShowT = null
    el.innerHTML = html
    const r = anchor.getBoundingClientRect()
    const w = Math.min(348, window.innerWidth - 32)
    el.style.left = Math.max(12, Math.min(r.left, window.innerWidth - w - 12)) + 'px'
    el.style.top = '0px'; el.style.visibility = 'hidden'
    el.classList.add('show')
    const ph = el.offsetHeight
    let top = r.bottom + 8
    if (top + ph > window.innerHeight - 8) top = Math.max(8, r.top - ph - 8)
    el.style.top = top + 'px'; el.style.visibility = ''
  }, 250)
}
export function schedulePreviewHide() {
  if (_pvShowT) { clearTimeout(_pvShowT); _pvShowT = null }
  if (_pvHideT) clearTimeout(_pvHideT)
  _pvHideT = setTimeout(() => { _pvHideT = null; if (_pv) _pv.classList.remove('show') }, 150)
}
export function hidePreviewNow() {
  if (_pvShowT) { clearTimeout(_pvShowT); _pvShowT = null }
  if (_pvHideT) { clearTimeout(_pvHideT); _pvHideT = null }
  if (_pv) _pv.classList.remove('show')
}
// 行级绑定:enter 出卡 / leave 收;htmlFn 惰性取值(跟随最新数据)。
export function bindRowPreview(el, htmlFn) {
  el.addEventListener('mouseenter', () => { showPreview(el, htmlFn()) })
  el.addEventListener('mouseleave', schedulePreviewHide)
  // Android WebView/adb 点击可能同时合成 mouseenter,使 250ms 预览计时器在导航后才弹出。
  // 点击即取消预览,避免浮卡残留并遮挡新页面正文。
  el.addEventListener('click', hidePreviewNow)
}
if (typeof document !== 'undefined') document.addEventListener('scroll', hidePreviewNow, true)

// ════ 左滑露出操作(增强,长按菜单为主) ════
// swipeRow(el, { actions:[{label,cls,onTap}] })
export function swipeRow(el, o) {
  o = o || {}
  const acts = o.actions || []
  if (!acts.length) return
  el.classList.add('lg-swipe')
  const fg = document.createElement('div'); fg.className = 'lg-swipe-fg'
  while (el.firstChild) fg.appendChild(el.firstChild)
  const bar = document.createElement('div'); bar.className = 'lg-swipe-actions'
  acts.forEach((a) => {
    const btn = document.createElement('button'); btn.className = 'lg-swipe-act ' + (a.cls || ''); btn.textContent = a.label
    btn.addEventListener('click', (e) => { e.stopPropagation(); reset(); if (typeof a.onTap === 'function') a.onTap() })
    bar.appendChild(btn)
  })
  el.appendChild(bar); el.appendChild(fg)
  const w = acts.length * 76
  let x0 = null, open = false
  const reset = () => { fg.style.transform = 'translateX(0)'; open = false }
  fg.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX }, { passive: true })
  fg.addEventListener('touchmove', (e) => {
    if (x0 == null) return
    let dx = e.touches[0].clientX - x0; if (open) dx -= w
    dx = Math.max(-w, Math.min(0, dx)); fg.style.transform = 'translateX(' + dx + 'px)'
  }, { passive: true })
  fg.addEventListener('touchend', (e) => {
    if (x0 == null) return
    const dx = e.changedTouches[0].clientX - x0
    if (!open && dx < -w / 2) { fg.style.transform = 'translateX(-' + w + 'px)'; open = true }
    else if (open && dx > w / 2) reset()
    else fg.style.transform = open ? 'translateX(-' + w + 'px)' : 'translateX(0)'
    x0 = null
  })
}

// ════ 蓝图刻度尺(chrome 专用,aria-hidden;唯一实现,各视图不得自画刻度) ════
// bpRuler() → 横向刻度尺条:40px 细 tick / 200px 长 tick + 尺寸数字(0/200/400…),
// 手机数字密度自动减半(CSS :nth-child 处理)。样式在 css/base.css .bp-ruler-top。
export function bpRuler() {
  const r = document.createElement('div'); r.className = 'bp-ruler-top'; r.setAttribute('aria-hidden', 'true')
  let html = ''
  for (let n = 0; n <= 2200; n += 200) html += '<i style="left:' + n + 'px">' + n + '</i>'
  r.innerHTML = html
  return r
}

// ════ 大标题页头 ════
// largeHeader({ title, badge?, searchable?, placeholder?, actions?, onSearch? }) → { el, setBadge, watch }
//   actions=[{icon(html), label(aria), onTap}]。头部作为滚动容器内的普通区块随内容一起滚动,
//   不吸顶、不收缩;各 view 把 el 放进滚动容器顶部。watch 保留为空操作以兼容旧调用点。
export function largeHeader(o) {
  o = o || {}
  const head = document.createElement('div'); head.className = 'lg-head'
  const actionsHtml = (o.actions || []).map((a, i) =>
    '<button class="lg-icon-btn" data-a="' + i + '" aria-label="' + esc(a.label || '') + '">' + (a.icon || '') + '</button>').join('')
  head.innerHTML =
    '<div class="lg-head-row">' +
    '<div class="lg-head-title">' + esc(o.title || '') + '</div>' +
    '<span class="lg-head-badge" style="display:none"></span>' +
    '<div class="lg-head-actions">' + actionsHtml + '</div></div>' +
    (o.searchable
      ? '<div class="lg-search">' + icons.search + '<input type="search" placeholder="' + esc(o.placeholder || '搜索') + '" autocapitalize="off" autocorrect="off" spellcheck="false"></div>'
      : '')
  Array.prototype.forEach.call(head.querySelectorAll('[data-a]'), (el) => {
    const a = (o.actions || [])[Number(el.getAttribute('data-a'))]
    if (a && typeof a.onTap === 'function') el.addEventListener('click', a.onTap)
  })
  if (o.searchable && typeof o.onSearch === 'function') {
    const inp = head.querySelector('.lg-search input')
    inp.addEventListener('input', () => o.onSearch(inp.value))
  }
  const badgeEl = head.querySelector('.lg-head-badge')
  const setBadge = (n) => { if (n) { badgeEl.textContent = n; badgeEl.style.display = ''; } else badgeEl.style.display = 'none' }
  setBadge(o.badge)
  head.appendChild(bpRuler())  // 页头 chrome 底部横向刻度尺(aria-hidden;唯一实现)
  const watch = () => {}
  return { el: head, setBadge, watch }
}

// ════ 连接状态条(由 core 连接健康驱动) ════
// banner(state): 'disconnected' 红常显 / 'connected' 绿一闪 2s / 'connecting' 红中性 / null 隐藏
let _bannerTimer = null
export function banner(state) {
  const bar = document.getElementById('bannerBar'); if (!bar) return
  const txt = bar.querySelector('.lg-banner-text')
  if (_bannerTimer) { clearTimeout(_bannerTimer); _bannerTimer = null }
  bar.classList.remove('ok', 'bad')
  if (state === 'disconnected') { bar.classList.add('show', 'bad'); if (txt) txt.textContent = '连接已断开 · 重连中…' }
  else if (state === 'connecting') { bar.classList.add('show', 'bad'); if (txt) txt.textContent = '连接中…' }
  else if (state === 'connected') {
    bar.classList.add('show', 'ok'); if (txt) txt.textContent = '已连接'
    _bannerTimer = setTimeout(() => bar.classList.remove('show', 'ok'), 2000)
  } else bar.classList.remove('show')
}
