// Local shell settings only. Dashboard owns every business preference and view.
import {
  esc, store, toast, connect, normBase, getSaved, save, hostLabel, DEFAULT_BASE,
  FONT_SCALES, getFontScale, setFontScale,
  getReduceGlass, setReduceGlass, getReduceMotion, setReduceMotion,
  checkUpdate, doUpdate,
} from './core.js'
import { largeHeader, icons, openSheet } from './ui.js'
import * as router from './router.js'
import * as browserView from './browserView.js'

let scroll = null
let onConnected = null

export function init(options = {}) {
  onConnected = options.onConnected || null
  const view = document.getElementById('meView')
  view.innerHTML = ''
  const header = largeHeader({ title: 'LOFA 设置' })
  scroll = document.createElement('div')
  scroll.className = 'scroll'
  scroll.id = 'meList'
  view.appendChild(header.el)
  view.appendChild(scroll)
  header.watch(scroll)
  buildConnectView()
  render()
}

export function load() { render() }

function group(title, rows) {
  return '<div class="lg-group"><div class="lg-group-title">' + esc(title) + '</div>' +
    '<div class="lg-group-body">' + rows + '</div></div>'
}

function navRow(key, label, value = '') {
  return '<button class="lg-set-row chev" data-k="' + key + '"><span class="lg-set-l">' + esc(label) + '</span>' +
    '<span class="lg-set-v">' + esc(value) + '</span></button>'
}

function toggleRow(key, label, enabled) {
  return '<button class="lg-set-row" data-k="' + key + '"><span class="lg-set-l">' + esc(label) + '</span>' +
    '<span class="lg-switch' + (enabled ? ' on' : '') + '" role="switch" aria-checked="' + enabled + '" aria-label="' + esc(label) + '"></span></button>'
}

function render() {
  if (!scroll) return
  const connected = Boolean(store.base)
  const connectionRows =
    navRow('host', '主机地址', hostLabel() || '未设置') +
    '<div class="lg-set-row"><span class="lg-set-dot ' + (connected ? 'ok' : 'bad') + '"></span>' +
    '<span class="lg-set-l">' + (connected ? '已连接' : '未连接') + '</span>' +
    (connected ? '' : '<button class="lg-set-btn" data-k="retry">重试</button>') + '</div>'

  const font = FONT_SCALES.find((entry) => entry.value === getFontScale()) || FONT_SCALES[0]
  const appearanceRows =
    navRow('font', '字号', font.label) +
    toggleRow('glass', '减少透明度', getReduceGlass()) +
    toggleRow('motion', '减少动效', getReduceMotion())

  const dashboardRows = navRow('dashboard', '返回 Dashboard', '当前网页构建')
  const update = store.update
  const version = update && update.own ? String(update.own) : (window.__lofaVersion || (window.Capacitor ? '读取中…' : 'web'))
  const aboutRows =
    '<div class="lg-set-row"><span class="lg-set-l">壳版本</span><span class="lg-set-v me-version">' + esc(version) + '</span></div>' +
    '<button class="lg-set-row' + (update ? '' : ' chev') + '" data-k="update"><span class="lg-set-l">' +
    (update ? '发现新版本 ' + esc(update.versionName) : '检查 APK 更新') + '</span>' +
    (update ? '<button class="lg-set-btn" data-k="install">更新</button>' : '<span class="lg-set-v"></span>') + '</button>'

  scroll.innerHTML =
    group('连接', connectionRows) +
    group('外观', appearanceRows) +
    group('网页业务前端', dashboardRows) +
    group('关于', aboutRows)
  wire()
}

function wire() {
  scroll.querySelectorAll('[data-k]').forEach((element) => {
    const key = element.getAttribute('data-k')
    element.addEventListener('click', (event) => {
      if (key === 'host') openConnect()
      else if (key === 'retry') { event.stopPropagation(); doConnect(getSaved() || DEFAULT_BASE) }
      else if (key === 'font') pickFont()
      else if (key === 'glass') { setReduceGlass(!getReduceGlass()); render() }
      else if (key === 'motion') { setReduceMotion(!getReduceMotion()); render() }
      else if (key === 'dashboard') browserView.openHome()
      else if (key === 'update') {
        if (store.update) { event.stopPropagation(); doUpdate() }
        else { toast('检查中…'); checkUpdate().then(render) }
      } else if (key === 'install') { event.stopPropagation(); doUpdate() }
    })
  })
}

function pickFont() {
  const current = getFontScale()
  openSheet({
    title: '字号',
    rows: FONT_SCALES.map((entry) => ({
      type: 'radio', label: entry.label, on: entry.value === current,
      onTap: () => { setFontScale(entry.value); render() },
    })),
  })
}

function buildConnectView() {
  const view = document.getElementById('connectView')
  view.innerHTML =
    '<div class="lg-nav"><button class="lg-nav-back" aria-label="返回">' + icons.back + '</button>' +
    '<div class="lg-nav-mid"><div class="lg-nav-title">连接主机</div></div><div class="lg-nav-actions"></div></div>' +
    '<div class="scroll"><div class="connect-body">' +
    '<label class="lg-field-label">主机地址（IP:端口）</label>' +
    '<input class="connect-input" id="connectHost" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" placeholder="10.3.43.246:12443">' +
    '<div class="connect-hint">输入运行 Dashboard 的主机局域网地址。LOFA 不保存业务数据，也不提供离线业务副本。</div>' +
    '<div class="connect-actions"><button class="lg-btn block" id="connectGo">连接</button></div>' +
    '<div class="connect-status" id="connectStatus"></div></div></div>'
  view.querySelector('.lg-nav-back').addEventListener('click', () => router.pop())
  view.querySelector('#connectGo').addEventListener('click', () => {
    const base = normBase(view.querySelector('#connectHost').value)
    if (!base) { setStatus('请输入地址', 'bad'); return }
    save(base)
    doConnect(base)
  })
}

function setStatus(message, className = '') {
  const status = document.getElementById('connectStatus')
  if (!status) return
  status.textContent = message
  status.className = 'connect-status' + (className ? ' ' + className : '')
}

function doConnect(value) {
  const base = normBase(value)
  setStatus('连接中…')
  connect(base, async () => {
    if (onConnected) await onConnected()
    setStatus('已连接 ' + hostLabel(), 'ok')
    render()
  }, (message) => {
    setStatus('连接失败 ' + base + '\n' + message, 'bad')
    render()
  })
}

export function openConnect() {
  const input = document.getElementById('connectHost')
  if (input) input.value = getSaved() || DEFAULT_BASE
  setStatus('')
  if (router.current() !== 'connectView') router.push('connectView')
  setTimeout(() => { try { if (input) input.focus() } catch (error) {} }, 120)
}
