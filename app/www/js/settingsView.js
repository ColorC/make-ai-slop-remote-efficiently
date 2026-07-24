// settingsView.js — 「我的」tab(#meView)与连接编辑页(#connectView)。
//   分组设置列表:连接 / 外观 / 终端 / 工具 / 关于。连接编辑页从主机行推入。
//   笔记与代码面板入口在此(推入全屏 iframe,由 notesView 提供)。

import {
  esc, store, toast, connect, normBase, getSaved, save, hostLabel, DEFAULT_BASE,
  FONT_SCALES, getFontScale, setFontScale,
  getReduceGlass, setReduceGlass, getReduceMotion, setReduceMotion,
  checkUpdate, doUpdate,
} from './core.js'
import { largeHeader, icons, openSheet } from './ui.js'
import * as router from './router.js'
import * as notes from './notesView.js'

const TERM_KEY = 'lofa.termFontSize'
const TERM_SIZES = [11, 12, 13, 14, 16, 18]
function termFontSize() { try { return parseInt(localStorage.getItem(TERM_KEY), 10) || 13 } catch (e) { return 13 } }
function setTermFontSize(n) { try { localStorage.setItem(TERM_KEY, String(n)) } catch (e) {} }

let _scroll = null
let _onConnected = null

// ── 我的 tab ────────────────────────────────────────────────────────────────
export function init(opts) {
  opts = opts || {}
  _onConnected = opts.onConnected || null
  const view = document.getElementById('meView')
  view.innerHTML = ''
  const head = largeHeader({ title: '我的' })
  const scroll = document.createElement('div'); scroll.className = 'scroll'; scroll.id = 'meList'
  view.appendChild(head.el); view.appendChild(scroll)
  head.watch(scroll)
  _scroll = scroll
  buildConnectView()
}

export function load() { render() }

function group(title, rowsHtml) {
  return '<div class="lg-group"><div class="lg-group-title">' + esc(title) + '</div>' +
    '<div class="lg-group-body">' + rowsHtml + '</div></div>'
}
function navRow(k, label, value) {
  return '<button class="lg-set-row chev" data-k="' + k + '"><span class="lg-set-l">' + esc(label) + '</span>' +
    '<span class="lg-set-v">' + esc(value != null ? value : '') + '</span></button>'
}
// 拨片 switch(role=switch + aria-checked 语义;视觉/热区在 components.css .lg-switch,±10 扩热区 ≥44)
function toggleRow(k, label, on) {
  return '<button class="lg-set-row" data-k="' + k + '"><span class="lg-set-l">' + esc(label) + '</span>' +
    '<span class="lg-switch' + (on ? ' on' : '') + '" role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="' + esc(label) + '"></span></button>'
}

function render() {
  if (!_scroll) return
  const connected = !!store.base
  const connRows =
    navRow('host', '主机地址', hostLabel() || '未设置') +
    '<div class="lg-set-row" data-k="status"><span class="lg-set-dot ' + (connected ? 'ok' : 'bad') + '"></span>' +
    '<span class="lg-set-l">' + (connected ? '已连接' : '未连接') + '</span>' +
    (connected ? '' : '<button class="lg-set-btn" data-k="retry">重试</button>') + '</div>'

  const fontLabel = (FONT_SCALES.find((f) => f.value === getFontScale()) || FONT_SCALES[0]).label
  const apprRows =
    navRow('font', '字号', fontLabel) +
    toggleRow('glass', '减少透明度', getReduceGlass()) +
    toggleRow('motion', '减少动效', getReduceMotion())

  const termRows = navRow('termfont', '默认字号', termFontSize() + ' px')

  const toolRows = navRow('code', '代码面板') + navRow('notes', '笔记')

  const up = store.update
  // 版本行(V1 空值 bug 修复):版本源 = 原生 Capacitor App 插件(app.js 设 window.__lofaVersion);
  // web 预览无该数据源(非逻辑问题),回落 'web' 兜底;原生未回包前显示「读取中…」不留空。
  const ownVer = (up && up.own) ? String(up.own)
    : (window.__lofaVersion || (window.Capacitor ? '读取中…' : 'web'))
  const aboutRows =
    '<div class="lg-set-row" data-k="version"><span class="lg-set-l">版本</span>' +
    '<span class="lg-set-v me-version">' + esc(ownVer) + '</span></div>' +
    '<button class="lg-set-row' + (up ? '' : ' chev') + '" data-k="update"><span class="lg-set-l">' +
    (up ? '有新版本 ' + esc(up.versionName) : '检查更新') + '</span>' +
    (up ? '<button class="lg-set-btn" data-k="doupdate">更新</button>' : '<span class="lg-set-v"></span>') + '</button>'

  _scroll.innerHTML =
    group('连接', connRows) + group('外观', apprRows) + group('终端', termRows) +
    group('工具', toolRows) + group('关于', aboutRows)
  wire()
  router.setBadge('me', up ? '' : 0)   // 有更新 → 我的 tab 红点
}

function wire() {
  _scroll.querySelectorAll('[data-k]').forEach((el) => {
    const k = el.getAttribute('data-k')
    el.addEventListener('click', (e) => {
      if (k === 'host') openConnect()
      else if (k === 'retry') { e.stopPropagation(); doConnect(getSaved() || DEFAULT_BASE) }
      else if (k === 'font') pickFont()
      else if (k === 'glass') { setReduceGlass(!getReduceGlass()); render() }
      else if (k === 'motion') { setReduceMotion(!getReduceMotion()); render() }
      else if (k === 'termfont') pickTermFont()
      else if (k === 'code') notes.openCode()
      else if (k === 'notes') notes.openNotes()
      else if (k === 'update') { if (store.update) { e.stopPropagation(); doUpdate() } else { toast('检查中…'); checkUpdate().then(() => render()) } }
      else if (k === 'doupdate') { e.stopPropagation(); doUpdate() }
    })
  })
}

function pickFont() {
  const cur = getFontScale()
  openSheet({
    title: '字号', rows: FONT_SCALES.map((f) => ({
      type: 'radio', label: f.label, on: f.value === cur,
      onTap: () => { setFontScale(f.value); render() },
    })),
  })
}
function pickTermFont() {
  const cur = termFontSize()
  openSheet({
    title: '终端字号', rows: TERM_SIZES.map((n) => ({
      type: 'radio', label: n + ' px', on: n === cur,
      onTap: () => { setTermFontSize(n); render() },
    })),
  })
}

// ── 连接编辑页(#connectView,推入) ─────────────────────────────────────────
function buildConnectView() {
  const view = document.getElementById('connectView')
  view.innerHTML =
    '<div class="lg-nav"><button class="lg-nav-back" aria-label="返回">' + icons.back + '</button>' +
    '<div class="lg-nav-mid"><div class="lg-nav-title">连接本机</div></div><div class="lg-nav-actions"></div></div>' +
    '<div class="scroll"><div class="connect-body">' +
    '<label class="lg-field-label">主机地址（IP:端口）</label>' +
    '<input class="connect-input" id="connectHost" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="10.3.43.246:12443">' +
    '<div class="connect-hint">输入本机 PC 的局域网地址（与手机同一 Wi-Fi），经 Caddy HTTPS 单端口访问。连不上时无功能（不离线缓存）。</div>' +
    '<div class="connect-actions"><button class="lg-btn block" id="connectGo">连接</button></div>' +
    '<div class="connect-status" id="connectStatus"></div>' +
    '</div></div>'
  view.querySelector('.lg-nav-back').addEventListener('click', () => router.pop())
  view.querySelector('#connectGo').addEventListener('click', () => {
    const b = normBase(view.querySelector('#connectHost').value)
    if (!b) { setStatus('请输入地址', 'bad'); return }
    save(b); doConnect(b)
  })
}
function setStatus(msg, cls) {
  const s = document.getElementById('connectStatus'); if (!s) return
  s.textContent = msg; s.className = 'connect-status' + (cls ? ' ' + cls : '')
}
function doConnect(base) {
  base = normBase(base)
  setStatus('连接中…', '')
  connect(base, () => {
    setStatus('已连接 ' + hostLabel(), 'ok')
    render()
    if (router.current() === 'connectView') router.pop()
    if (_onConnected) _onConnected()
  }, (msg) => {
    setStatus('连不上 ' + base + '\n' + msg, 'bad')
    render()
  })
}

// 供 app.js 深链/启动调用:打开连接编辑页(可带初值)
export function openConnect() {
  const inp = document.getElementById('connectHost')
  if (inp) inp.value = getSaved() || DEFAULT_BASE
  setStatus('', '')
  if (router.current() !== 'connectView') router.push('connectView')
  setTimeout(() => { try { inp && inp.focus() } catch (e) {} }, 120)
}
