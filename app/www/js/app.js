// app.js — 启动外壳:字号/可达性 → 各 view init → 接线 → router.init 四 tab → 连接。
//   Android 硬件返回按 §4b 优先级;OTA 检测 → toast + 我的红点;remote(B 档)反向控制。
// 业务在各 view;本文件只管壳、路由接缝与连接。

import {
  store, connect, probeConnection, normBase, getSaved,
  initFontScale, initA11yPrefs, setBadgeListener, setUpdateListener,
} from './core.js'
import * as router from './router.js'
import * as sessionsView from './sessionsView.js'
import * as chatView from './chatView.js'
import * as termView from './termView.js'
import * as reviewView from './reviewView.js'
import * as projectsView from './projectsView.js'
import * as settingsView from './settingsView.js'
import * as notes from './notesView.js'
import * as browserView from './browserView.js'
import { startRemote } from './remote.js'

const TABS = { sessions: 'sessionsView', review: 'reviewView', projects: 'projectsView', me: 'meView' }

// ── 连接成功:渲染我的、加载当前 tab、起 remote ─────────────────────────────
function onConnected() {
  settingsView.load()
  loadTab(router.current() === 'sessionsView' ? 'sessions' : null)
  startRemote()
}
function connectInit() {
  const saved = getSaved()
  if (saved) connect(normBase(saved), onConnected, () => { if (!store.base) router.open('connect') })
  else router.open('connect')   // §7h 首次无地址 → 直接落连接编辑页
}

let resumeTimer = null
function resumeConnections() {
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    if (store.base) probeConnection(store.base)
    chatView.reconnectNow()
    termView.reconnectNow()
    reviewView.reconnectNow()
  }, 120)
}

// ── tab 切换驱动数据加载(仅连上后) ─────────────────────────────────────────
function loadTab(name) {
  if (!store.base || !name) return
  if (name === 'sessions') sessionsView.load()
  else if (name === 'review') reviewView.load()
  else if (name === 'projects') projectsView.load()
  else if (name === 'me') settingsView.load()
}

// ── Android 硬件返回:软键盘 → 浮层 → pop → 非默认 tab 回默认 → 根页最小化 ──
function onHardwareBack() {
  if (reviewView.exitImmersive && reviewView.exitImmersive()) return
  const ae = document.activeElement
  if (ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT')) { ae.blur(); return }
  if (!router.back()) {
    const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App
    if (A && A.minimizeApp) A.minimizeApp()
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────
function boot() {
  initFontScale()
  initA11yPrefs()

  sessionsView.init()
  chatView.init()
  termView.init()
  reviewView.init()
  projectsView.init()
  settingsView.init({ onConnected })
  browserView.init()

  // opener 注册(深链 / 通知点击 / remote.navigate 共用)
  router.registerOpener('chat', (meta) => { chatView.open(meta); router.push('chatView') })
  router.registerOpener('term', (meta) => { termView.open(meta); router.push('termView') })
  router.registerOpener('review-detail', (id) => reviewView.openDetail(id))
  router.registerOpener('project-detail', (id) => projectsView.openDetail(id))
  router.registerOpener('notes', () => notes.openNotes())
  router.registerOpener('code', () => browserView.openHome())
  router.registerOpener('browser', () => browserView.openHome())
  router.registerOpener('web', (p) => browserView.openWeb((p && p.url) || '', (p && p.title) || ''))
  router.registerOpener('connect', () => settingsView.openConnect())
  router.registerOpener('session', (id) => { router.tab('sessions'); void id })
  router.registerOpener('review', (id) => { router.tab('review'); if (id) reviewView.openDetail(id) })

  // 只在停在 tab 根页时加载列表:push 详情/对话/终端(view≠根)不触发重复拉取,pop 回根页再刷。
  router.onChange(({ tab, view }) => { if (view === TABS[tab]) loadTab(tab) })

  // core 健康/计数/OTA → 底 tab 角标 + 我的红点
  setBadgeListener(({ review }) => router.setBadge('review', review))
  setUpdateListener(() => settingsView.load())

  router.init({ tabs: TABS, defaultTab: 'sessions' })

  const A = window.Capacitor && Capacitor.Plugins && Capacitor.Plugins.App
  if (A && A.addListener) {
    try { A.addListener('backButton', onHardwareBack) } catch (e) {}
    try { A.addListener('appStateChange', (state) => { if (state && state.isActive) resumeConnections() }) } catch (e) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeConnections() })
  window.addEventListener('pageshow', resumeConnections)
  window.addEventListener('online', resumeConnections)
  if (A && A.getInfo) { try { A.getInfo().then((i) => { window.__lofaVersion = i.version || i.build; settingsView.load() }).catch(() => {}) } catch (e) {} }

  connectInit()
}

boot()
window.LOFA = { connect: connectInit, router }
