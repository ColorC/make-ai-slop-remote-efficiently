// core.js — LOFA 共享地基。
//   · 连接健康(banner 驱动)  · API fetch / WS URL  · 全局字号  · 极简 markdown
//   · 日志回传  · 常驻通知  · OTA 自更新(toast + 我的 tab 红点)  · 计数轮询
//   · promptModal/confirmModal/pickModal 桥接到 ui 新实现(旧签名不变)
// 纯 vanilla,无构建;视图机制在 router.js,组件在 ui.js。

import { openModal, openSheet, banner } from './ui.js'

export const LS_KEY = 'lofa.baseUrl'
export const DEFAULT_BASE = location.origin || 'https://localhost:12443'   // 默认同源; 跨机访问时改为 PC 的 LAN IP

// 连接态单例。code = 主机 /lofa-config.json 下发的代码面板配置。update = OTA 待装清单。
export const store = { base: null, code: null, update: null }
let _connectionState = 'idle'
let _probePromise = null

export function connectionTrying() { _connectionState = 'connecting'; banner('connecting') }
export function connectionAlive(announce) {
  const recover = _connectionState === 'disconnected' || _connectionState === 'connecting'
  _connectionState = 'connected'
  if (announce || recover) banner('connected')
  else banner(null)
}
export function connectionLost() { _connectionState = 'disconnected'; banner('disconnected') }

export const $ = (id) => document.getElementById(id)
export function esc(s) {
  return (s == null ? '' : String(s)).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

// ── toast(底部胶囊,ok/err 变体;多条堆叠) ──────────────────────────────────
const _raf = (typeof requestAnimationFrame === 'function') ? requestAnimationFrame : ((cb) => setTimeout(cb, 0))
export function toast(m, opts) {
  opts = opts || {}
  const host = $('toast'); if (!host) return
  const el = document.createElement('div'); el.className = 'lg-toast' + (opts.type ? (' ' + opts.type) : '')
  el.textContent = m; host.appendChild(el)
  _raf(() => el.classList.add('show'))
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => { try { host.removeChild(el) } catch (e) {} }, 200) }, opts.ms || 1900)
}

// ── 全局字号档位:只按倍数缩放正文/消息 font-size(.scale-text 与消息类) ──────
export const FONT_SCALES = [
  { value: 'sm', label: '小', scale: 1 },
  { value: 'md', label: '中', scale: 1.15 },
  { value: 'lg', label: '大', scale: 1.3 },
  { value: 'xl', label: '特大', scale: 1.5 },
]
const FONT_KEY = 'lofa.fontScale'
export function getFontScale() { try { return localStorage.getItem(FONT_KEY) || 'sm' } catch (e) { return 'sm' } }
function applyFontScale(v) {
  const f = FONT_SCALES.find((x) => x.value === v) || FONT_SCALES[0]
  document.documentElement.style.setProperty('--font-scale', String(f.scale))
  return f.value
}
export function setFontScale(v) { try { localStorage.setItem(FONT_KEY, v) } catch (e) {} return applyFontScale(v) }
export function initFontScale() { return applyFontScale(getFontScale()) }

// ── 减少透明度 / 减少动效(存 localStorage,尊重系统偏好) ────────────────────
export function initA11yPrefs() {
  let g = false, m = false
  try { g = localStorage.getItem('lofa.reduceGlass') === '1' } catch (e) {}
  try { m = localStorage.getItem('lofa.reduceMotion') === '1' } catch (e) {}
  document.documentElement.classList.toggle('no-glass', g)
  document.documentElement.classList.toggle('reduce-motion', m)
}
export function setReduceGlass(on) { try { localStorage.setItem('lofa.reduceGlass', on ? '1' : '0') } catch (e) {} document.documentElement.classList.toggle('no-glass', !!on) }
export function setReduceMotion(on) { try { localStorage.setItem('lofa.reduceMotion', on ? '1' : '0') } catch (e) {} document.documentElement.classList.toggle('reduce-motion', !!on) }
export function getReduceGlass() { try { return localStorage.getItem('lofa.reduceGlass') === '1' } catch (e) { return false } }
export function getReduceMotion() { try { return localStorage.getItem('lofa.reduceMotion') === '1' } catch (e) { return false } }

// ── 地址工具 ────────────────────────────────────────────────────────────────
export function normBase(v) {
  v = (v || '').trim().replace(/\/+$/, '')
  if (!v) return ''
  if (!/^https?:\/\//.test(v)) v = 'https://' + v
  return v
}
export function getSaved() {
  try {
    let v = localStorage.getItem(LS_KEY) || ''
    if (v && (/^http:\/\//i.test(v) || /:8210(\b|\/|$)/.test(v))) v = ''   // 旧架构存值作废
    return v
  } catch (e) { return '' }
}
export function save(b) { try { localStorage.setItem(LS_KEY, b) } catch (e) {} }
export function hostLabel() { return store.base ? store.base.replace(/^https?:\/\//, '') : '' }

// ── 代码面板地址:来自主机下发的 /lofa-config.json ────────────────────────────
export async function fetchCodeConfig() {
  try {
    let cfg = await api('/lofa-config.json')
    if (typeof cfg === 'string') { try { cfg = JSON.parse(cfg) } catch (e) { cfg = null } }
    store.code = (cfg && cfg.code) || null
  } catch (e) { store.code = null; LOG.rec('error', ['code.config.fail', e.message || e]) }
}
export function codeUrl() {
  const c = store.code
  if (!store.base || !c || c.enabled === false || !c.path) return ''
  const sep = c.token ? ('?tkn=' + encodeURIComponent(c.token)) : ''
  return store.base.replace(/\/+$/, '') + c.path + sep
}

// ── API fetch ─────────────────────────────────────────────────────────────────
export async function api(path, opts) {
  const r = await fetch(store.base + path, Object.assign(
    { cache: 'no-store', credentials: 'include' },
    opts || {},
  ))
  if (!r.ok) {
    let detail = ''
    try { const j = await r.json(); detail = j.detail || '' } catch (e) {}
    throw new Error(detail || ('HTTP ' + r.status))
  }
  connectionAlive(false)
  const ct = r.headers.get('content-type') || ''
  return ct.indexOf('application/json') >= 0 ? r.json() : r.text()
}
export const apiJson = (path, method, body) =>
  api(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })

// WS URL(http→ws / https→wss)
const PTY_CLIENT_PROTOCOL = 'focused-visible-v1'
export function wsUrl(sid) {
  return store.base.replace(/^http/, 'ws') + '/api/cc/chat/sessions/' + encodeURIComponent(sid) + '/ws'
}
export function termWsUrl(sid) {
  return store.base.replace(/^http/, 'ws') + '/api/cc/sessions/' + encodeURIComponent(sid) +
    '/ws?client_protocol=' + encodeURIComponent(PTY_CLIENT_PROTOCOL)
}

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

// ── prompt/confirm/pick 弹窗:桥接到 ui 新实现(旧签名不变) ────────────────────
export function promptModal(title, value, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    openModal({
      title, value, okText: opts.okText,
      input: !opts.textarea, textarea: !!opts.textarea,
      onOk: (v) => resolve(v), onCancel: () => resolve(null),
    })
  })
}
export function confirmModal(title, opts) {
  opts = opts || {}
  return new Promise((resolve) => {
    openModal({
      title, body: opts.body, okText: opts.okText, cancelText: opts.cancelText, danger: opts.danger,
      onOk: () => resolve(true), onCancel: () => resolve(false),
    })
  })
}
// 单选:改走 radio sheet(点选即生效自动收起),替代旧两段弹窗。
export function pickModal(title, options, current) {
  return new Promise((resolve) => {
    let picked = false
    openSheet({
      title,
      rows: (options || []).map((o) => ({ type: 'radio', label: o.label, on: o.value === current, onTap: () => { picked = true; resolve(o.value) } })),
      onClose: () => { if (!picked) resolve(null) },
    })
  })
}

// ── 日志地基:缓冲 + 批量回传 ─────────────────────────────────────────────────
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
    fetch(store.base + '/api/android/log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: b }),
    }).catch(() => {})
  }
  setInterval(flush, 4000)
  return { rec, flush }
})()

// ── 静默常驻通知 ─────────────────────────────────────────────────────────────
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

// ── 计数轮询(审阅未读 → 底 tab badge + 常驻通知) ────────────────────────────
let _pollTimer = null
let _badgeCb = () => {}
export function setBadgeListener(cb) { _badgeCb = cb || (() => {}) }
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
    _badgeCb({ review: pushedN || reviewN })
  } catch (e) { LOG.rec('error', ['poll.fail', e.message || e]) }
}
export function startPolling() { if (_pollTimer) return; pollCounts(); _pollTimer = setInterval(pollCounts, 15000) }

// ── OTA 自更新:检测到新版 → toast 一次 + 我的 tab 红点(横幅已废) ─────────────
let _updateCb = () => {}
export function setUpdateListener(cb) { _updateCb = cb || (() => {}) }
async function ownVersionCode() {
  try { const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App; if (!A) return 0; const info = await A.getInfo(); return parseInt(info.build, 10) || 0 } catch (e) { return 0 }
}
export async function checkUpdate() {
  if (!store.base) return
  try {
    const r = await api('/api/android/apk/version')
    const m = r && r.manifest
    if (!m || !m.versionCode) { store.update = null; _updateCb(null); return }
    const own = await ownVersionCode()
    if (m.versionCode > own) {
      const first = !store.update
      store.update = { manifest: m, versionName: m.versionName || ('#' + m.versionCode), own }
      if (first) toast('发现新版本 ' + store.update.versionName + '，在「我的」里更新', { type: 'ok', ms: 2600 })
      _updateCb(store.update)
      LOG.rec('info', ['update.available', m.versionCode, 'own', own])
    } else { store.update = null; _updateCb(null) }
  } catch (e) { LOG.rec('error', ['checkUpdate', e.message || e]) }
}
let _updatePromise = null
export async function doUpdate() {
  if (_updatePromise) { toast('更新正在下载，请稍候…'); return _updatePromise }
  const AI = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.ApkInstaller
  if (!AI) { toast('此环境不支持自安装'); return }
  _updatePromise = (async () => {
    const can = await AI.canInstall()
    if (!can || !can.granted) { toast('请先允许 LOFA「安装未知应用」，开启后再点更新'); await AI.openInstallPermission(); return }
    toast('下载中… 安装器稍后弹出'); LOG.rec('info', ['update.start', store.base])
    await AI.downloadAndInstall({
      url: store.base + '/api/android/apk/latest',
      sha256: String((store.update && store.update.manifest && store.update.manifest.sha256) || ''),
    })
    LOG.rec('info', ['update.installer-launched'])
  })()
  try { return await _updatePromise }
  catch (e) { toast('更新失败: ' + (e.message || e)); LOG.rec('error', ['update.fail', e.message || e]) }
  finally { _updatePromise = null }
}

// Connection health check and foreground recovery.
async function healthCheck(base) {
  const ctrl = new AbortController()
  const to = setTimeout(() => ctrl.abort(), 6000)
  try {
    const r = await fetch(base + '/api/healthz', {
      signal: ctrl.signal,
      cache: 'no-store',
      credentials: 'include',
    })
    if (!r.ok) throw new Error('HTTP ' + r.status)
    const j = await r.json()
    if (!j.ok) throw new Error('healthz not ok')
    return j
  } finally { clearTimeout(to) }
}

// Foreground probes never navigate and never duplicate polling setup.
export function probeConnection(base) {
  base = base || store.base
  if (!base) return Promise.resolve(false)
  if (_probePromise) return _probePromise
  connectionTrying()
  _probePromise = healthCheck(base).then(() => {
    store.base = base
    connectionAlive(true)
    LOG.rec('info', ['connect.recovered', base])
    return true
  }).catch((e) => {
    connectionLost()
    LOG.rec('error', ['connect.probe.fail', base, e.message || e])
    return false
  }).finally(() => { _probePromise = null })
  return _probePromise
}

export async function connect(base, onOk, onFail) {
  connectionTrying()
  LOG.rec('info', ['connect.try', base])
  try {
    await healthCheck(base)
    store.base = base; connectionAlive(true)
    LOG.rec('info', ['connect.ok', base])
    if (onOk) await onOk()
    LOG.flush()
    NOTIF.init(); startPolling(); checkUpdate()
    fetchCodeConfig()
  } catch (e) {
    connectionLost()
    const msg = (e.name === 'AbortError')
      ? '超时(6s) — 网络不通/防火墙/未开局域网绑定'
      : String(e.message || e)
    LOG.rec('error', ['connect.fail', base, msg]); LOG.flush()
    if (onFail) onFail(msg)
  }
}
