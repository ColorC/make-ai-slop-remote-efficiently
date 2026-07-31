// termView.js — 终端屏(推入页,app 内自渲染 xterm + PTY WS,不再 iframe)。
//   契约导出:init() / open(meta)(§9),meta=PTY to_meta。
//   xterm 用全局 window.Terminal / window.FitAddon(index.html 已 script 引入,不 ES import vendor)。
//   WS 走 ws.js 的 openReconnectingWs + core.termWsUrl;wire 见 §2b:
//     服→客 snapshot(重画)/output/exit;客→服 input/resize。
//   附加键条纯逻辑在 termKeys.js;终端是内容层,容器实底无玻璃。

import { esc, termWsUrl, store, apiJson, api, toast, promptModal, confirmModal } from './core.js'
import { icons, openMenu, openSheet, banner } from './ui.js'
import { openReconnectingWs } from './ws.js'
import * as router from './router.js'
import { KEY_ROWS, keySequence, createModifierState } from './termKeys.js'
import { installTerminalTouchScroller, isTerminalViewportAtBottom } from './terminalTouchScroller.js'

const FONT_KEY = 'lofa.termFontSize'
const FONT_MIN = 9, FONT_MAX = 20, FONT_DEFAULT = 13
const NAME_KEY = (id) => 'lofa.termName.' + id

// 终端配色:Windows Terminal 精确色值(Campbell 16 色;PowerShell 风=同色盘换 #012456 蓝底)
// + 「跟随应用」深色玻璃风。默认 PowerShell 风,可在三点菜单切换。
const CAMPBELL = {
  black: '#0C0C0C', red: '#C50F1F', green: '#13A10E', yellow: '#C19C00',
  blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
  brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5',
  brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
  foreground: '#CCCCCC', cursor: '#FFFFFF', selectionBackground: 'rgba(255,255,255,.35)',
}
const THEMES = {
  ps: { label: 'PowerShell 蓝', theme: Object.assign({}, CAMPBELL, { background: '#012456', cursorAccent: '#012456' }) },
  campbell: { label: 'Campbell 深黑', theme: Object.assign({}, CAMPBELL, { background: '#0C0C0C', cursorAccent: '#0C0C0C' }) },
  app: {
    label: '跟随应用', theme: {
      background: '#0e1420', foreground: '#f0f4fa',
      cursor: '#5b9dff', cursorAccent: '#05101f',
      selectionBackground: 'rgba(91,157,255,.30)',
      black: '#1a2130', red: '#f4726d', green: '#34d399', yellow: '#f5b942',
      blue: '#5b9dff', magenta: '#a78bfa', cyan: '#38bdf8', white: '#a9b4c6',
      brightBlack: '#6b7890', brightRed: '#f4726d', brightGreen: '#4ade80', brightYellow: '#f5b942',
      brightBlue: '#5b9dff', brightMagenta: '#a78bfa', brightCyan: '#38bdf8', brightWhite: '#f0f4fa',
    },
  },
}
const THEME_KEY = 'lofa.termTheme'
function getThemeId() { try { return THEMES[localStorage.getItem(THEME_KEY)] ? localStorage.getItem(THEME_KEY) : 'ps' } catch (e) { return 'ps' } }
function saveThemeId(id) { try { localStorage.setItem(THEME_KEY, id) } catch (e) {} }
// 内嵌 Cascadia Mono 在前(系统 monospace 缺 braille/框线字形),兜底只留 generic monospace
// (VS Code 同款两段式;链里混入比例字体会破坏 TUI 依赖的等宽格栅)。CJK 落到 generic 是预期回退。
const FONT_FAMILY = "'Cascadia Mono', monospace"

function getFontSize() {
  let n = FONT_DEFAULT
  try { n = parseInt(localStorage.getItem(FONT_KEY), 10) || FONT_DEFAULT } catch (e) {}
  return Math.max(FONT_MIN, Math.min(FONT_MAX, n))
}
function saveFontSize(n) { try { localStorage.setItem(FONT_KEY, String(n)) } catch (e) {} }
function localName(id) { try { return localStorage.getItem(NAME_KEY(id)) || '' } catch (e) { return '' } }
function saveLocalName(id, v) { try { if (v) localStorage.setItem(NAME_KEY(id), v); else localStorage.removeItem(NAME_KEY(id)) } catch (e) {} }
function cwdTail(cwd) { const s = String(cwd || ''); const parts = s.split(/[\\/]/).filter(Boolean); return parts.length ? parts[parts.length - 1] : s }

const raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : ((cb) => setTimeout(cb, 0))

// 触屏后浏览器会补发 mouse 事件;鼠标兜底分支在此窗口内让路,防重复触发。
let _lastTouch = 0
function recentTouch() { return Date.now() - _lastTouch < 700 }

// 单实例运行态:同一时刻只挂一个终端会话。切换/离开时 teardown。
let cur = null   // { meta, term, fit, ws, els, mods, fontSize, alive, ... }

export function init() {
  // 离开终端屏(硬件返回 pop / 切 tab)时收 WS 与 xterm,避免后台空跑。
  router.onChange((p) => { if (cur && p.view !== 'termView') teardown() })
}

function teardown() {
  if (!cur) return
  const c = cur; cur = null
  try { if (c.ws) c.ws.leave() } catch (e) {}
  try { if (c._disposeTouchScroll) c._disposeTouchScroll() } catch (e) {}
  try { if (c._scrollSubscription) c._scrollSubscription.dispose() } catch (e) {}
  try { if (c._vvh) window.visualViewport && window.visualViewport.removeEventListener('resize', c._vvh) } catch (e) {}
  try { window.removeEventListener('resize', c._winResize) } catch (e) {}
  try { if (c.term) c.term.dispose() } catch (e) {}
}

export function reconnectNow() {
  if (!cur || !cur.ws) return false
  return cur.ws.reconnectNow()
}

export function open(meta) {
  meta = meta || {}
  teardown()
  const view = document.getElementById('termView')
  const id = meta.id
  const cmdName = (meta.cmd && meta.cmd[0]) || '终端'
  const title = localName(id) || meta.name || cmdName
  const sub = [cwdTail(meta.cwd), '连接中'].filter(Boolean).join(' · ')

  view.innerHTML =
    '<div class="lg-nav">' +
    '<button class="lg-nav-back" aria-label="返回">' + icons.back + '</button>' +
    '<div class="lg-nav-mid">' +
    '<div class="lg-nav-title" data-t="title">' + esc(title) + '</div>' +
    '<div class="lg-nav-sub"><span class="term-dot" data-t="dot"></span><span data-t="sub">' + esc(sub) + '</span></div>' +
    '</div>' +
    '<div class="lg-nav-actions"><button class="lg-icon-btn" data-t="menu" aria-label="更多">' + icons.dots + '</button></div>' +
    '</div>' +
    '<div class="term-wrap" data-t="wrap">' +
    '<div class="term-body">' +
    '<div class="term-screen" id="termScreen"></div>' +
    '<div class="term-overlay show" data-t="overlay"><div class="term-overlay-card"><div class="term-overlay-title" data-t="ovtitle">连接中…</div><div class="term-overlay-actions" data-t="ovactions"></div></div></div>' +
    '<button class="term-latest" data-t="latest" aria-label="回到最新内容">↓ 最新</button>' +
    '<button class="term-kfab" data-t="kfab" aria-label="呼出键盘">' + icons.keyboard + '</button>' +
    '</div>' +
    buildKeysBar() +
    '</div>'

  const els = {
    view, title: view.querySelector('[data-t="title"]'), sub: view.querySelector('[data-t="sub"]'),
    dot: view.querySelector('[data-t="dot"]'), menu: view.querySelector('[data-t="menu"]'),
    wrap: view.querySelector('[data-t="wrap"]'), screen: view.querySelector('#termScreen'),
    overlay: view.querySelector('[data-t="overlay"]'), ovtitle: view.querySelector('[data-t="ovtitle"]'),
    ovactions: view.querySelector('[data-t="ovactions"]'), keys: view.querySelector('#termKeys'),
    kfab: view.querySelector('[data-t="kfab"]'), latest: view.querySelector('[data-t="latest"]'),
  }
  view.querySelector('.lg-nav-back').addEventListener('click', () => router.pop())

  const c = { meta, id, els, mods: createModifierState(), fontSize: getFontSize(), alive: true, term: null, fit: null, ws: null, kb: 0, pin: false, snapshot: null, snapshotEpoch: 0 }
  cur = c
  // 附加键条默认收起:软键盘弹起(kb>阈值)或键盘钮手动钉住才出现,不常驻占屏。
  if (els.kfab) els.kfab.addEventListener('click', () => { c.pin = true; syncKeys(c); if (c.term) { try { c.term.focus() } catch (e) {} } })

  if (!window.Terminal) {
    setStatus(c, 'ended', '终端组件未加载')
    showOverlay(c, '终端组件未加载', false)
    wireKeys(c); wireMenu(c)
    return
  }

  setStatus(c, 'connecting', '连接中')
  wireKeys(c)
  wireMenu(c)
  wirePinch(c)
  wireResize(c)
  mountTerm(c)
}

// 字体就绪后再建 xterm(swap 时用兜底字体量宽会永久错格),随后 unicode11 修宽度、
// webgl 提帧率(context 丢失即 dispose 退回 DOM 渲染器)。
async function mountTerm(c) {
  try {
    await Promise.race([
      (document.fonts && document.fonts.load) ? document.fonts.load('13px "Cascadia Mono"') : Promise.resolve(),
      new Promise((r) => setTimeout(r, 1500)),
    ])
  } catch (e) {}
  if (cur !== c) return

  const themeId = getThemeId()
  const theme = THEMES[themeId].theme
  const term = new window.Terminal({
    fontFamily: FONT_FAMILY, fontSize: c.fontSize, fontWeight: 400, fontWeightBold: 700,
    cursorBlink: true, cursorStyle: 'bar', lineHeight: 1.0, letterSpacing: 0,
    theme, scrollback: 9001, allowProposedApi: true, convertEol: false,
    rescaleOverlappingGlyphs: true,
    // 后端是 pywinpty/ConPTY:必须声明,否则 xterm 按 Unix pty 换行语义猜 reflow,
    // 正是 Windows 后端排版错乱的根源类(VS Code 同款做法;build<21376 时自动禁 reflow)。
    windowsPty: { backend: 'conpty', buildNumber: 19045 },
    // VS Code 的可读性来自它自己把最小对比度设到 WCAG AA,xterm 默认 1 是不干预。
    minimumContrastRatio: 4.5,
  })
  // vendor UMD 全局名见 VENDOR.md(命名空间对象或直挂类,两种都兼容取)。
  const pick = (ns, name) => (ns && (ns[name] || ns))
  const fit = new (pick(window.FitAddon, 'FitAddon'))()
  term.loadAddon(fit)
  // 宽度表:grapheme 群集(emoji ZWJ/组合记号按整簇算宽)优先,失效退 unicode11。
  try {
    const G = pick(window.UnicodeGraphemesAddon, 'UnicodeGraphemesAddon')
    if (G) { term.loadAddon(new G()); term.unicode.activeVersion = '15-graphemes' }
  } catch (e) {
    try {
      const U = pick(window.Unicode11Addon, 'Unicode11Addon')
      if (U) { term.loadAddon(new U()); term.unicode.activeVersion = '11' }
    } catch (e2) {}
  }
  term.open(c.els.screen)
  try {
    const W = window.WebglAddon && (window.WebglAddon.WebglAddon || window.WebglAddon)
    if (W) { const wa = new W(); wa.onContextLoss(() => { try { wa.dispose() } catch (e) {} }); term.loadAddon(wa) }
  } catch (e) { /* WebGL 不可用:留在 DOM 渲染器 */ }
  syncThemeBg(c, theme)
  c.term = term; c.fit = fit
  c._disposeTouchScroll = installTerminalTouchScroller(c.els.screen, term)
  const syncLatest = () => {
    if (cur !== c || !c.els.latest) return
    c.els.latest.classList.toggle('show', !isTerminalViewportAtBottom(term))
  }
  c._scrollSubscription = term.onScroll(syncLatest)
  if (c.els.latest) {
    c.els.latest.addEventListener('click', () => {
      term.scrollToBottom()
      syncLatest()
    })
  }
  try { window.__lofaTerm = term } catch (e) {}   // e2e/远程调试句柄(WebGL 渲染下 DOM 无文本,查屏走 buffer)
  raf(() => { try { fit.fit() } catch (e) {} })

  // 键入 → input;xterm 原生选择复制走系统长按(此处只发输入)。
  term.onData((data) => { if (c.ws) c.ws.send({ type: 'input', data }) })

  if (!store.base || !c.id) { showOverlay(c, '连接中…', false); return }
  connectWs(c)
}

// 终端底与内边距区跟随配色背景,避免四周露出应用色缝。
function syncThemeBg(c, theme) {
  const bg = theme.background || '#0e1420'
  const body = c.els.view.querySelector('.term-body')
  if (body) body.style.background = bg
  if (c.els.screen) c.els.screen.style.background = bg
}

// ── WS 接线(§2b) ────────────────────────────────────────────────────────────
function renderSnapshot(c, chunks, meta) {
  if (cur !== c || !c.term) return
  c.snapshot = null
  const epoch = ++c.snapshotEpoch
  try { c.term.reset() } catch (e) {}
  const parts = Array.isArray(chunks) ? chunks : []
  parts.forEach((ch) => c.term.write(String(ch == null ? '' : ch)))
  // xterm parses writes asynchronously. Queue final UI state and an optional
  // SIGWINCH redraw behind every replay chunk so a truncated TUI snapshot gets
  // a fresh self-contained repaint instead of keeping broken ANSI state.
  c.term.write('', () => {
    if (cur !== c || c.snapshotEpoch !== epoch) return
    c.alive = true
    hideOverlay(c)
    setStatus(c, 'connected', '已连接')
    doFit(c)
    if (meta && meta.replay_truncated && c.ws) {
      c.ws.send({ type: 'redraw', cols: c.term.cols, rows: c.term.rows })
    }
  })
}

function connectWs(c) {
  const url = termWsUrl(c.id)
  c.ws = openReconnectingWs(url, {
    onOpen() { if (cur !== c) return; c.snapshot = null; c.snapshotEpoch++; setStatus(c, 'connected', '已连接'); doFit(c) },
    onFrame(f) {
      if (cur !== c || !f || !f.type) return
      if (f.type === 'snapshot_begin') {
        c.snapshotEpoch++
        // Snapshot v2 is streamed in bounded frames. Do not reset xterm until
        // the complete generation has arrived: a mid-stream disconnect must
        // leave the previously visible screen intact rather than half blank.
        c.snapshot = { chunks: [], meta: (f.meta && typeof f.meta === 'object') ? f.meta : {} }
      } else if (f.type === 'snapshot_chunk') {
        if (!c.snapshot) c.snapshot = { chunks: [], meta: {} }
        ;(f.chunks || []).forEach((ch) => c.snapshot.chunks.push(ch))
      } else if (f.type === 'snapshot_end') {
        const snapshot = c.snapshot || { chunks: [], meta: {} }
        renderSnapshot(c, snapshot.chunks, snapshot.meta)
      } else if (f.type === 'snapshot') {
        // v1 compatibility for older ccdaemon instances and offline fixtures.
        renderSnapshot(c, f.chunks || [], f.meta || {})
      } else if (f.type === 'output') {
        c.term.write(f.data || ''); hideOverlay(c)
        if (c.status !== 'connected') setStatus(c, 'connected', '已连接')
      } else if (f.type === 'exit') {
        c.snapshot = null
        c.snapshotEpoch++
        c.alive = false; setStatus(c, 'ended', '已结束')
        try { if (c.ws) c.ws.leave() } catch (e) {}
        showExit(c, f.reason)
      }
    },
    onReconnecting() {
      if (cur !== c) return
      c.snapshot = null
      c.snapshotEpoch++
      setStatus(c, 'disconnected', '重连中')
      banner('disconnected')
      if (c.alive) showOverlay(c, '连接中…', false)
    },
    onError() {},
  })
}

// ── 状态点 + 副行状态文字 ────────────────────
// connecting=琥珀呼吸 / connected=绿 / disconnected=红 / ended=灰
function setStatus(c, state, word) {
  c.status = state
  if (c.els.dot) c.els.dot.className = 'term-dot ' + state
  if (c.els.sub) c.els.sub.textContent = [cwdTail(c.meta.cwd), word].filter(Boolean).join(' · ')
}

function showOverlay(c, title, showBack) {
  c.els.ovtitle.textContent = title
  c.els.ovactions.innerHTML = ''
  if (showBack) {
    const b = document.createElement('button'); b.className = 'lg-btn'; b.textContent = '回列表'
    b.addEventListener('click', () => router.pop())
    c.els.ovactions.appendChild(b)
  }
  c.els.overlay.classList.add('show')
}
function hideOverlay(c) { c.els.overlay.classList.remove('show') }
function showExit(c, reason) {
  const r = reason ? String(reason) : ''
  showOverlay(c, '会话已结束' + (r ? '(' + r + ')' : ''), true)
}

// ── 附加键条 DOM(§7d) ────────────────────────────────────────────────────────
function buildKeysBar() {
  const rows = KEY_ROWS.map((row) =>
    '<div class="term-krow">' + row.map((k) => {
      const cls = 'term-key' + (k.mod ? ' term-key-mod' : '')
      const hold = k.hold ? (' data-hold="' + esc(k.hold) + '"') : ''
      const mod = k.mod ? (' data-mod="' + esc(k.mod) + '"') : ''
      return '<button class="' + cls + '" data-key="' + esc(k.id) + '"' + mod + hold + '>' + esc(k.label) + '</button>'
    }).join('') + '</div>').join('')
  return '<div class="lg-keys" id="termKeys">' +
    '<div class="term-krows">' + rows + '</div>' +
    '<button class="term-kb" data-t="kbtoggle" aria-label="键盘">' + icons.keyboard + '</button>' +
    '</div>'
}

function wireKeys(c) {
  const bar = c.els.keys
  const refreshMods = () => {
    Array.prototype.forEach.call(bar.querySelectorAll('.term-key-mod'), (btn) => {
      const m = btn.getAttribute('data-mod')
      btn.classList.toggle('armed', c.mods.state(m) === 'armed')
      btn.classList.toggle('locked', c.mods.state(m) === 'locked')
    })
  }
  Array.prototype.forEach.call(bar.querySelectorAll('.term-key'), (btn) => {
    const keyId = btn.getAttribute('data-key')
    const modName = btn.getAttribute('data-mod')
    const hold = btn.getAttribute('data-hold')

    if (modName) {
      // 修饰键:点=tap(切 armed/off),长按=lock。触屏走 touch,鼠标走 mousedown。
      let lp = null
      btn.addEventListener('touchstart', () => { _lastTouch = Date.now(); lp = setTimeout(() => { lp = null; c.mods.lock(modName); refreshMods() }, 500) }, { passive: true })
      btn.addEventListener('touchend', () => { _lastTouch = Date.now(); if (lp) { clearTimeout(lp); lp = null; c.mods.tap(modName); refreshMods() } })
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); c.mods.lock(modName); refreshMods() })
      btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || recentTouch()) return
        let held = false; const t = setTimeout(() => { held = true; c.mods.lock(modName); refreshMods() }, 500)
        const up = () => { clearTimeout(t); if (!held) { c.mods.tap(modName); refreshMods() }; document.removeEventListener('mouseup', up) }
        document.addEventListener('mouseup', up)
      })
      return
    }

    const sendKey = () => {
      const seq = keySequence(keyId, c.mods.consume())
      if (c.ws) c.ws.send({ type: 'input', data: seq })
      refreshMods()
      if (c.term) { try { c.term.focus() } catch (e) {} }
    }

    if (hold) {
      // 长按二级字符:浮出小泡,点泡发二级;短按发主键。
      let lp = null, fired = false
      btn.addEventListener('touchstart', () => { _lastTouch = Date.now(); fired = false; lp = setTimeout(() => { lp = null; fired = true; showHoldBubble(c, btn, hold) }, 450) }, { passive: true })
      btn.addEventListener('touchend', () => { _lastTouch = Date.now(); if (lp) { clearTimeout(lp); lp = null } if (!fired) sendKey() })
      btn.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || recentTouch()) return
        fired = false; const t = setTimeout(() => { fired = true; showHoldBubble(c, btn, hold) }, 450)
        const up = () => { clearTimeout(t); if (!fired) sendKey(); document.removeEventListener('mouseup', up) }
        document.addEventListener('mouseup', up)
      })
      btn.addEventListener('contextmenu', (e) => { e.preventDefault(); showHoldBubble(c, btn, hold) })
      return
    }

    btn.addEventListener('click', sendKey)
  })

  const kb = bar.querySelector('[data-t="kbtoggle"]')
  if (kb) kb.addEventListener('click', () => toggleKeyboard(c))
  refreshMods()
}

function showHoldBubble(c, anchor, ch) {
  const old = c.els.keys.querySelector('.term-hold'); if (old) old.remove()
  const bub = document.createElement('button'); bub.className = 'term-hold'; bub.textContent = ch
  document.body.appendChild(bub)
  const r = anchor.getBoundingClientRect()
  bub.style.left = (r.left + r.width / 2) + 'px'
  bub.style.top = (r.top - 8) + 'px'
  raf(() => bub.classList.add('show'))
  const send = () => {
    const seq = keySequence(ch, c.mods.consume())
    if (c.ws) c.ws.send({ type: 'input', data: seq })
    dismiss(); if (c.term) { try { c.term.focus() } catch (e) {} }
  }
  const dismiss = () => { bub.remove(); document.removeEventListener('click', outside, true) }
  const outside = (e) => { if (e.target !== bub) dismiss() }
  bub.addEventListener('click', (e) => { e.stopPropagation(); send() })
  setTimeout(() => document.addEventListener('click', outside, true), 0)
}

function toggleKeyboard(c) {
  if (!c.term) return
  const ta = c.term.textarea
  const active = document.activeElement === ta
  try { if (active) ta.blur(); else c.term.focus() } catch (e) {}
  if (active) { c.pin = false; syncKeys(c) }   // 收键盘同时解除手动钉住,键条随之收起
}

// 键条显隐 = 软键盘弹起(kb>60) 或 手动钉住;变化会改终端高度,随手 refit。
function syncKeys(c) {
  if (!c.els.wrap) return
  const on = c.kb > 60 || !!c.pin
  if (c.els.wrap.classList.contains('kb-open') !== on) {
    c.els.wrap.classList.toggle('kb-open', on)
    doFit(c)
  }
}

// ── 三点菜单:改名 / 绑定计划 / 复制会话 id / 终端字号 / 杀死会话 ────────────────
function wireMenu(c) {
  c.els.menu.addEventListener('click', () => {
    openMenu({
      anchor: c.els.menu,
      items: [
        { label: '改名', onTap: () => renameSession(c) },
        { label: '绑定计划', onTap: () => bindPlan(c) },
        { label: '复制会话 id', onTap: () => copyId(c) },
        { label: '终端字号', onTap: () => fontSheet(c) },
        { label: '终端配色', onTap: () => themeSheet(c) },
        { label: '杀死会话', danger: true, onTap: () => killSession(c) },
      ],
    })
  })
}
async function renameSession(c) {
  const v = await promptModal('会话显示名', c.els.title.textContent, { okText: '保存' })
  if (v == null) return
  const name = v.trim()
  saveLocalName(c.id, name)
  c.els.title.textContent = name || ((c.meta.cmd && c.meta.cmd[0]) || '终端')
}
async function bindPlan(c) {
  const v = await promptModal('绑定计划(计划 id)', c.meta.active_plan || '', { okText: '绑定' })
  if (v == null) return
  try { await apiJson('/api/cc/sessions/' + encodeURIComponent(c.id) + '/active_plan', 'PATCH', { plan_id: v.trim() }); c.meta.active_plan = v.trim(); toast('已绑定计划', { type: 'ok' }) }
  catch (e) { toast('绑定失败: ' + (e.message || e), { type: 'err' }) }
}
function copyId(c) {
  const t = String(c.id || '')
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('已复制会话 id', { type: 'ok' }), () => toast('复制失败', { type: 'err' }))
  else toast(t)
}
function fontSheet(c) {
  const opts = [11, 12, 13, 14, 16, 18]
  openSheet({
    title: '终端字号',
    rows: opts.map((n) => ({ type: 'radio', label: String(n), on: n === c.fontSize, onTap: () => applyFontSize(c, n) })),
  })
}
function themeSheet(c) {
  const curId = getThemeId()
  openSheet({
    title: '终端配色',
    rows: Object.keys(THEMES).map((id) => ({
      type: 'radio', label: THEMES[id].label, on: id === curId,
      onTap: () => {
        saveThemeId(id)
        if (c.term) { c.term.options.theme = THEMES[id].theme; syncThemeBg(c, THEMES[id].theme) }
      },
    })),
  })
}

async function killSession(c) {
  const ok = await confirmModal('杀死此终端会话?', { body: '会话进程将被终止,不可恢复。', okText: '杀死', danger: true })
  if (!ok) return
  try { await api('/api/cc/sessions/' + encodeURIComponent(c.id), { method: 'DELETE' }); toast('会话已杀死', { type: 'ok' }); router.pop() }
  catch (e) { toast('杀死失败: ' + (e.message || e), { type: 'err' }) }
}

// ── 字号:双指捏合 + radio sheet,9-20 夹取,实时 fit+resize,存档 ────────────────
function applyFontSize(c, n) {
  n = Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)))
  if (n === c.fontSize && c.term && c.term.options.fontSize === n) return
  c.fontSize = n; saveFontSize(n)
  if (c.term) { c.term.options.fontSize = n; doFit(c) }
}
function wirePinch(c) {
  const el = c.els.screen
  let base = null, startSize = c.fontSize
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  el.addEventListener('touchstart', (e) => { if (e.touches.length === 2) { base = dist(e.touches); startSize = c.fontSize } }, { passive: true })
  el.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && base) { e.preventDefault(); applyFontSize(c, startSize * (dist(e.touches) / base)) }
  }, { passive: false })
  const clr = () => { base = null }
  el.addEventListener('touchend', clr); el.addEventListener('touchcancel', clr)
}

// ── fit + resize(300ms debounce)+ 键盘 inset(visualViewport) ────────────────
let _fitTimer = null
function doFit(c) {
  if (cur !== c || !c.fit || !c.term) return
  try { c.fit.fit() } catch (e) {}
  if (_fitTimer) clearTimeout(_fitTimer)
  _fitTimer = setTimeout(() => {
    if (cur !== c || !c.ws) return
    c.ws.send({ type: 'resize', cols: c.term.cols, rows: c.term.rows })
  }, 300)
}
function wireResize(c) {
  c._winResize = () => doFit(c)
  window.addEventListener('resize', c._winResize)
  const vv = window.visualViewport
  if (vv) {
    c._vvh = () => {
      // 键盘弹起:visualViewport 收缩。以 --kb 抬起包裹层底 padding,附加键条随之吸在键盘上方,
      // 终端区同步缩短并重新 fit。键盘收起 kb≈0,键条回落屏底。
      const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))
      c.els.wrap.style.setProperty('--kb', kb + 'px')
      c.kb = kb
      if (kb > 60) c.pin = false   // 真键盘接管后,收起键盘即收起键条
      syncKeys(c)
      doFit(c)
    }
    vv.addEventListener('resize', c._vvh)
  }
}
