// LOFA is an Android shell around the current Dashboard build. It owns only
// connection, diagnostics, OTA and the declared native bridge.
import {
  store, connect, probeConnection, normBase, getSaved,
  initFontScale, initA11yPrefs, setUpdateListener,
} from './core.js'
import * as router from './router.js'
import * as settingsView from './settingsView.js'
import * as browserView from './browserView.js'
import { startRemote } from './remote.js'

function openDashboardEntity(type, id, title) {
  return browserView.openEntity(type, id, title)
}

function openDashboardDeepLink(value) {
  const link = value && typeof value === 'object' ? value : {}
  return openDashboardEntity(link.type, link.id, link.title)
}

async function onConnected() {
  await startRemote()
  browserView.reloadAfterConnect()
  settingsView.load()
  await browserView.openHome()
}

function connectInit() {
  const saved = getSaved()
  if (saved) connect(normBase(saved), onConnected, () => {
    if (!store.base) router.open('connect')
  })
  else router.open('connect')
}

let resumeTimer = null
function resumeConnections() {
  if (resumeTimer) clearTimeout(resumeTimer)
  resumeTimer = setTimeout(() => {
    resumeTimer = null
    if (store.base) probeConnection(store.base)
  }, 120)
}

function onHardwareBack() {
  const active = document.activeElement
  if (active && (active.tagName === 'TEXTAREA' || active.tagName === 'INPUT')) {
    active.blur()
    return
  }
  if (!router.back()) {
    const app = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App
    if (app && app.minimizeApp) app.minimizeApp()
  }
}

function registerDashboardOpeners() {
  router.registerOpener('connect', () => settingsView.openConnect())
  router.registerOpener('browser', () => browserView.openHome())
  router.registerOpener('code', () => browserView.openHome())
  router.registerOpener('web', (value) => browserView.openWeb((value && value.url) || '', (value && value.title) || ''))
  router.registerOpener('chat', (meta) => openDashboardEntity('cc_session', meta && meta.id, meta && (meta.name || meta.titleHint)))
  router.registerOpener('term', (meta) => openDashboardEntity('cc_session', meta && meta.id, meta && meta.name))
  router.registerOpener('session', (id) => openDashboardEntity('cc_session', id, id))
  router.registerOpener('sessions', () => openDashboardEntity('multiagent', 'main', '会话'))
  router.registerOpener('review-detail', (id) => openDashboardEntity('review_material', id, id))
  router.registerOpener('review', (id) => openDashboardEntity(id ? 'review_material' : 'review_queue', id || 'main', id || '审阅'))
  router.registerOpener('projects', () => openDashboardEntity('project_board', 'main', '项目'))
  router.registerOpener('project-detail', (id) => openDashboardEntity('project', id, id))
}

function boot() {
  initFontScale()
  initA11yPrefs()
  settingsView.init({ onConnected })
  browserView.init()
  router.init({ tabs: { me: 'meView' }, defaultTab: 'me' })
  registerDashboardOpeners()
  setUpdateListener(() => settingsView.load())

  const app = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App
  if (app && app.addListener) {
    try { app.addListener('backButton', onHardwareBack) } catch (error) {}
    try { app.addListener('appStateChange', (state) => { if (state && state.isActive) resumeConnections() }) } catch (error) {}
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') resumeConnections() })
  window.addEventListener('pageshow', resumeConnections)
  window.addEventListener('online', resumeConnections)
  if (app && app.getInfo) {
    try {
      app.getInfo().then((info) => {
        window.__lofaVersion = info.version || info.build
        settingsView.load()
      }).catch(() => {})
    } catch (error) {}
  }

  const notifications = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications
  if (notifications && notifications.addListener) {
    try {
      notifications.addListener('localNotificationActionPerformed', (action) => {
        const notification = action && action.notification
        const extra = notification && (notification.extra || notification.data)
        if (extra && extra.lofa_deep_link) openDashboardDeepLink(extra.lofa_deep_link)
      })
    } catch (error) {}
  }
  window.addEventListener('lofa:file-share', () => {
    openDashboardEntity('file_bridge', 'main', 'Agent 暂存区')
  })

  connectInit()
}

boot()
window.LOFA = { connect: connectInit, router, openDashboardDeepLink }
