// core.js — LOFA 移动端共享地基(后续 tab 都复用)。
//   · 连接/会话状态  · API fetch  · WS 重连封装  · toast/loading/error/banner
//   · 极简 markdown  · 日志回传  · 常驻通知  · OTA 自更新  · 计数轮询  · 弹窗 prompt
// 纯 vanilla, 无构建步骤; Capacitor WebView(Chromium)原生支持 ES module。

export const LS_KEY = 'lofa.baseUrl'
export const DEFAULT_BASE = '10.3.43.246:8210'   // 硬编码默认本机地址(免手输), 设置页可改

// 连接态(单例, 各模块共享)
export const store = { base: null }

export const $ = (id) => document.getElementById(id)
export function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}
export function toast(m) {
  const t = $('toast'); if (!t) return
  t.textContent = m; t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 1600)
}
export function setDot(s) { const d = $('dot'); if (d) d.className = 'dot' + (s ? ' ' + s : '') }
export function setBar(text) { const b = $('barSub'); if (b) b.textContent = text }

// 视图路由 + 顶栏返回键 + tab 可见性
const VIEWS = ['listView', 'detailView', 'settingsView', 'emptyView', 'chatListView', 'convView', 'notesView', 'noteDetailView', 'projectsView', 'projectDetailView']
const CONNECTED_VIEWS = ['listView', 'detailView', 'chatListView', 'convView', 'notesView', 'noteDetailView', 'projectsView', 'projectDetailView']
const BACK_VIEWS = ['detailView', 'convView', 'noteDetailView', 'projectDetailView']
let _curView = null
export function showView(v) {
  _curView = v
  VIEWS.forEach((id) => { const el = $(id); if (el) el.classList.toggle('show', id === v) })
  const back = $('btnBack'); if (back) back.style.display = BACK_VIEWS.includes(v) ? 'block' : 'none'
  const tb = $('tabbar'); if (tb) tb.style.display = CONNECTED_VIEWS.includes(v) ? 'flex' : 'none'
}
export function curView() { return _curView }
export function isView(v) { return _curView === v }

// ── 地址工具 ────────────────────────────────────────────────────────────────
export function normBase(v) {
  v = (v || '').trim().replace(/\/+$/, '')
  if (!v) return ''
  if (!/^https?:\/\//.test(v)) v = 'http://' + v
  return v
}
export function getSaved() { try { return localStorage.getItem(LS_KEY) || '' } catch (e) { return '' } }
export function save(b) { try { localStorage.setItem(LS_KEY, b) } catch (e) {} }
export function hostLabel() { return store.base ? store.base.replace(/^https?:\/\//, '') : '' }

// ── API fetch(统一 base + no-store + json/text 协商) ────────────────────────
export async function api(path, opts) {
  const r = await fetch(store.base + path, Object.assign({ cache: 'no-store' }, opts || {}))
  if (!r.ok) {
    let detail = ''
    try { const j = await r.json(); detail = j.detail || '' } catch (e) {}
    throw new Error(detail || ('HTTP ' + r.status))
  }
  const ct = r.headers.get('content-type') || ''
  return ct.indexOf('application/json') >= 0 ? r.json() : r.text()
}
// 便捷封装
export const apiJson = (path, method, body) =>
  api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

// ── 复用 UI 片段(卡片列表 / loading / error) ───────────────────────────────
export const loadingHtml = (msg) => '<div class="empty">' + esc(msg || '加载中…') + '</div>'
export const errorHtml = (msg) => '<div class="empty">加载失败: ' + esc(msg) + '</div>'
export const emptyHtml = (msg) => '<div class="empty">' + esc(msg || '暂无内容') + '</div>'

// ── 极简 markdown(无外网依赖) ───────────────────────────────────────────────
export function mdToHtml(src) {
  const lines = String(src || '').split(/\r?\n/), out = []
  let inList = false, inCode = false, buf = []
  function flushP() { if (buf.length) { out.push('<p>' + inline(buf.join(' ')) + '</p>'); buf = [] } }
  function inline(t) {
    return esc(t)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (/^```/.test(l)) {
      if (inCode) { out.push('</code></pre>'); inCode = false }
      else { flushP(); if (inList) { out.push('</ul>'); inList = false } out.push('<pre><code>'); inCode = true }
      continue
    }
    if (inCode) { out.push(esc(l) + '\n'); continue }
    const h = l.match(/^(#{1,3})\s+(.*)/)
    if (h) { flushP(); if (inList) { out.push('</ul>'); inList = false } out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue }
    const li = l.match(/^\s*[-*]\s+(.*)/)
    if (li) { flushP(); if (!inList) { out.push('<ul>'); inList = true } out.push('<li>' + inline(li[1]) + '</li>'); continue }
    if (/^\s*$/.test(l)) { flushP(); if (inList) { out.push('</ul>'); inList = false } continue }
    buf.push(l)
  }
  flushP(); if (inList) out.push('</ul>'); if (inCode) out.push('</code></pre>')
  return out.join('')
}

// ── 弹窗 prompt(WebView 里 window.prompt 不可靠, 自建 overlay) ───────────────
export function promptModal(title, value, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-ov'
    ov.innerHTML =
      '<div class="modal">' +
      '<div class="modal-t">' + esc(title) + '</div>' +
      (opts.textarea
        ? '<textarea class="modal-in" rows="4">' + esc(value || '') + '</textarea>'
        : '<input class="modal-in" value="' + esc(value || '') + '">') +
      '<div class="modal-btns">' +
      '<button class="modal-cancel">取消</button>' +
      '<button class="modal-ok">' + esc(opts.okText || '确定') + '</button>' +
      '</div></div>'
    document.body.appendChild(ov)
    const inp = ov.querySelector('.modal-in')
    setTimeout(() => { try { inp.focus() } catch (e) {} }, 30)
    const done = (val) => { try { document.body.removeChild(ov) } catch (e) {}; resolve(val) }
    ov.querySelector('.modal-cancel').onclick = () => done(null)
    ov.querySelector('.modal-ok').onclick = () => done(inp.value)
    ov.onclick = (e) => { if (e.target === ov) done(null) }
  })
}

// 二次确认弹窗(批量动作/删除前用)。resolve(true) 确认, resolve(false) 取消。
export function confirmModal(title, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-ov'
    ov.innerHTML =
      '<div class="modal">' +
      '<div class="modal-t">' + esc(title) + '</div>' +
      (opts.body ? '<div class="modal-body">' + esc(opts.body) + '</div>' : '') +
      '<div class="modal-btns">' +
      '<button class="modal-cancel">' + esc(opts.cancelText || '取消') + '</button>' +
      '<button class="modal-ok' + (opts.danger ? ' danger' : '') + '">' + esc(opts.okText || '确定') + '</button>' +
      '</div></div>'
    document.body.appendChild(ov)
    const done = (val) => { try { document.body.removeChild(ov) } catch (e) {}; resolve(val) }
    ov.querySelector('.modal-cancel').onclick = () => done(false)
    ov.querySelector('.modal-ok').onclick = () => done(true)
    ov.onclick = (e) => { if (e.target === ov) done(false) }
  })
}

// 单选弹窗(effort/model 等)
export function pickModal(title, options, current) {
  return new Promise((resolve) => {
    const ov = document.createElement('div'); ov.className = 'modal-ov'
    ov.innerHTML =
      '<div class="modal">' +
      '<div class="modal-t">' + esc(title) + '</div>' +
      '<div class="modal-opts">' +
      options.map((o) =>
        '<button class="modal-opt' + (o.value === current ? ' cur' : '') + '" data-v="' + esc(o.value) + '">' + esc(o.label) + '</button>'
      ).join('') +
      '</div>' +
      '<div class="modal-btns"><button class="modal-cancel">取消</button></div>' +
      '</div>'
    document.body.appendChild(ov)
    const done = (val) => { try { document.body.removeChild(ov) } catch (e) {}; resolve(val) }
    Array.prototype.forEach.call(ov.querySelectorAll('.modal-opt'), (b) => { b.onclick = () => done(b.getAttribute('data-v')) })
    ov.querySelector('.modal-cancel').onclick = () => done(null)
    ov.onclick = (e) => { if (e.target === ov) done(null) }
  })
}

// ── 日志地基: 缓冲 + 批量回传 /api/android/log ──────────────────────────────
export const LOG = (function () {
  const buf = []
  function rec(level, args) {
    let m
    try { m = Array.prototype.map.call(args, (a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') } catch (e) { m = String(args) }
    buf.push({ ts: Date.now(), level, src: 'lofa-web', msg: m }); if (buf.length > 500) buf.shift()
  }
  ;['log', 'info', 'warn', 'error'].forEach((k) => {
    const o = console[k] ? console[k].bind(console) : function () {}
    console[k] = function () { rec(k, arguments); o.apply(null, arguments) }
  })
  window.addEventListener('error', (e) => rec('error', ['window.onerror', e.message, e.filename + ':' + e.lineno]))
  window.addEventListener('unhandledrejection', (e) => rec('error', ['unhandledrejection', (e.reason && e.reason.message) || e.reason]))
  function flush() {
    if (!store.base || !buf.length) return
    const b = buf.splice(0, buf.length)
    fetch(store.base + '/api/android/log', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries: b }) }).catch(() => {})
  }
  setInterval(flush, 4000)
  return { rec, flush }
})()

// ── 静默常驻通知: 下拉栏显示 待审 + 待输入计数(无声无震) ────────────────────
export const NOTIF = (function () {
  function ln() { return (window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.LocalNotifications) || null }
  let ready = false, last = ''
  async function init() {
    const L = ln(); if (!L || ready) return
    try {
      await L.requestPermissions()
      await L.createChannel({ id: 'lofa-status', name: 'LOFA 常驻状态', description: '待审/待输入计数', importance: 2, visibility: 1, vibration: false })
      ready = true
    } catch (e) { LOG.rec('error', ['notif.init', e.message || e]) }
  }
  async function update(reviewN, agentN, pushedN) {
    const L = ln(); if (!L) return; if (!ready) { await init(); if (!ready) return }
    const body = '审阅待办 ' + reviewN + (pushedN ? ('（新推送 ' + pushedN + '）') : '') + ' · agent 待输入 ' + agentN
    if (body === last) return; last = body
    try { await L.schedule({ notifications: [{ id: 1001, title: 'LOFA', body, channelId: 'lofa-status', ongoing: true, autoCancel: false, smallIcon: 'ic_launcher' }] }) }
    catch (e) { LOG.rec('error', ['notif.update', e.message || e]) }
  }
  async function clear() { const L = ln(); if (!L) return; try { await L.cancel({ notifications: [{ id: 1001 }] }) } catch (e) {} last = '' }
  return { init, update, clear }
})()

// ── 计数轮询 ────────────────────────────────────────────────────────────────
let _pollTimer = null
async function pollCounts() {
  if (!store.base) return
  try {
    const st = await api('/api/boss-sight/reviewstage/_stats')
    const reviewN = (st && st.by_status && st.by_status.pending) || 0
    const pushedN = (st && st.pushed_unread) || 0
    let agentN = 0
    try {
      const r = await api('/api/boss-sight/residents')
      const list = (r && r.residents) || []
      agentN = list.filter((a) => { const s = String(a.run_status || '').toLowerCase(); return /wait|input|block|review|need|pend/.test(s) }).length
    } catch (e) {}
    NOTIF.update(reviewN, agentN, pushedN)
  } catch (e) { LOG.rec('error', ['poll.fail', e.message || e]) }
}
export function startPolling() { if (_pollTimer) return; pollCounts(); _pollTimer = setInterval(pollCounts, 15000) }

// ── OTA 自更新 ──────────────────────────────────────────────────────────────
let _updMani = null
async function ownVersionCode() {
  try { const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; if (!A) return 0; const info = await A.getInfo(); return parseInt(info.build, 10) || 0 } catch (e) { return 0 }
}
export async function checkUpdate() {
  if (!store.base) return
  try {
    const r = await api('/api/android/apk/version')
    const m = r && r.manifest
    if (!m || !m.versionCode) { $('updateBanner').classList.remove('show'); return }
    const own = await ownVersionCode()
    if (m.versionCode > own) {
      _updMani = m
      $('updateText').textContent = '发现新版本 ' + (m.versionName || ('#' + m.versionCode)) + '（当前 ' + (own || '?') + '）'
      $('updateBanner').classList.add('show')
      LOG.rec('info', ['update.available', m.versionCode, 'own', own])
    } else { $('updateBanner').classList.remove('show') }
  } catch (e) { LOG.rec('error', ['checkUpdate', e.message || e]) }
}
export async function doUpdate() {
  const AI = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ApkInstaller
  if (!AI) { toast('此环境不支持自安装'); return }
  try {
    const can = await AI.canInstall()
    if (!can || !can.granted) { toast('请先允许 LOFA「安装未知应用」，开启后再点更新'); await AI.openInstallPermission(); return }
    toast('下载中… 安装器稍后弹出'); LOG.rec('info', ['update.start', store.base])
    await AI.downloadAndInstall({ url: store.base + '/api/android/apk/latest' })
    LOG.rec('info', ['update.installer-launched'])
  } catch (e) { toast('更新失败: ' + (e.message || e)); LOG.rec('error', ['update.fail', e.message || e]) }
}

// ── 连接 ────────────────────────────────────────────────────────────────────
export async function connect(base, onConnected) {
  setDot(''); setBar(base.replace(/^https?:\/\//, '') + ' · 探测中…')
  LOG.rec('info', ['connect.try', base])
  try {
    const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 6000)
    const r = await fetch(base + '/api/healthz', { signal: ctrl.signal, cache: 'no-store' }); clearTimeout(to)
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json(); if (!j.ok) throw new Error('healthz not ok')
    store.base = base; setDot('ok'); setBar(base.replace(/^https?:\/\//, ''))
    LOG.rec('info', ['connect.ok', base]); LOG.flush()
    fetch(base + '/api/android/register', { method: 'POST' }).catch(() => {})
    NOTIF.init(); startPolling(); checkUpdate()
    if (onConnected) onConnected()
  } catch (e) {
    setDot('bad'); setBar('未连接')
    const msg = (e.name === 'AbortError') ? '超时(6s) — 网络不通/防火墙/未开局域网绑定' : String(e.message || e)
    LOG.rec('error', ['connect.fail', base, msg]); LOG.flush()
    const es = $('emptyStatus'); if (es) es.textContent = '连不上 ' + base + '\n' + msg
    const ss = $('setStatus'); if (ss) ss.textContent = ''
    showView('emptyView')
  }
}

// WS URL(http→ws / https→wss)
export function wsUrl(sid) {
  return store.base.replace(/^http/, 'ws') + '/api/cc/chat/sessions/' + encodeURIComponent(sid) + '/ws'
}
