// browserView.js - chrome-free LOFA host for the Omnicompany Dashboard.
// Dashboard owns the business UI and the only visible tab strip. LOFA keeps only
// connection/native controls around it; Android popup events are forwarded into it.

import { store, toast, checkUpdate, doUpdate } from './core.js'
import * as router from './router.js'

export const LOFA_BRIDGE_PROTOCOL = 'omni:lofa-native-bridge/v1'
export const LOFA_BOOTSTRAP_REQUEST = 'omni:lofa-bootstrap-request'
export const LOFA_BOOTSTRAP_RESPONSE = 'omni:lofa-bootstrap-response'
export const LOFA_NATIVE_REQUEST = 'omni:lofa-native-request'
export const LOFA_NATIVE_RESULT = 'omni:lofa-native-result'
export const LOFA_NATIVE_BRIDGE_VERSION = 2

let view = null
let dashboardFrame = null
let dashboardLoaded = false
let initialized = false
let dashboardUrl = ''
const pendingTabs = []
const pendingNativeTabs = []
let lastDashboardBootstrap = null

function resolveWebUrl(value, baseOverride) {
  let url = String(value == null ? '' : value).trim()
  if (!url) return ''
  const base = (baseOverride || store.base || '').replace(/\/+$/, '')
  if (url.charAt(0) === '/') return base + url
  const local = url.match(/^(https?:)\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i)
  if (local) {
    let host = ''
    try { host = new URL(base).hostname } catch (e) { host = base.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') }
    return local[1] + '//' + host + (local[3] || '') + (local[4] || '/')
  }
  try {
    const parsed = new URL(url, base || window.location.href)
    if (!/^https?:$/.test(parsed.protocol)) return ''
    return parsed.href
  } catch (e) { return '' }
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host === '::1' || host.startsWith('127.')) return true
  const match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  if (octets.some((value) => value < 0 || value > 255)) return false
  return octets[0] === 10 ||
    octets[0] === 127 ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168)
}

export function isInternalWebUrl(value, baseOverride) {
  const baseValue = baseOverride || store.base || window.location.href
  const resolved = resolveWebUrl(value, baseValue)
  if (!resolved) return false
  try {
    const target = new URL(resolved)
    const base = new URL(resolveWebUrl(baseValue, baseValue) || baseValue)
    return target.origin === base.origin ||
      target.hostname === base.hostname ||
      (isPrivateHostname(target.hostname) && isPrivateHostname(base.hostname))
  } catch (e) { return false }
}

function isDashboardRootUrl(value) {
  try {
    const target = new URL(resolveWebUrl(value))
    const base = new URL(resolveWebUrl((store.base || '').replace(/\/+$/, '') + '/'))
    return target.origin === base.origin &&
      target.pathname.replace(/\/+$/, '') === base.pathname.replace(/\/+$/, '') &&
      !target.searchParams.has('open_type') &&
      !target.searchParams.has('surface')
  } catch (e) { return false }
}

export async function openExternalBrowser(url) {
  const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ExternalBrowser
  if (plugin && typeof plugin.open === 'function') {
    try {
      await plugin.open({ url })
      return true
    } catch (e) {
      toast('\u65e0\u6cd5\u6253\u5f00\u5916\u90e8\u6d4f\u89c8\u5668')
      return false
    }
  }
  const native = Boolean(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' &&
    window.Capacitor.isNativePlatform())
  if (native) {
    toast('\u5f53\u524d LOFA \u7248\u672c\u4e0d\u652f\u6301\u5916\u90e8\u6d4f\u89c8\u5668\uff0c\u8bf7\u5347\u7ea7')
    return false
  }
  window.open(url, '_blank', 'noopener,noreferrer')
  return true
}

function titleFor(url, title) {
  const named = String(title || '').trim()
  if (named) return named
  try { return new URL(url).hostname || '\u7f51\u9875' } catch (e) { return '\u7f51\u9875' }
}

function connectedDashboardUrl() {
  const base = (store.base || '').replace(/\/+$/, '') + '/'
  try {
    const url = new URL(base)
    url.searchParams.set('lofaRemoteWeb', '1')
    // Explicit client identity is intentionally separate from viewport detection:
    // Dashboard can gate native-bridge capabilities without inventing a second UI.
    url.searchParams.set('client', 'lofa')
    return url.href
  } catch (e) { return base + '?lofaRemoteWeb=1&client=lofa' }
}

function dashboardOrigin() {
  try { return new URL(dashboardUrl).origin } catch (e) { return '*' }
}

function plugins() {
  return (window.Capacitor && window.Capacitor.Plugins) || {}
}

export function nativeCapabilities() {
  const p = plugins()
  const capabilities = [
    'shell.reload-dashboard',
    'shell.open-settings',
    'navigation.open-entity',
    'file.open-bridge',
  ]
  if (p.ExternalBrowser && typeof p.ExternalBrowser.open === 'function') capabilities.push('browser.open-external')
  if (p.ExternalWebview) {
    if (typeof p.ExternalWebview.open === 'function') capabilities.push('browser.webview.open')
    if (typeof p.ExternalWebview.update === 'function') capabilities.push('browser.webview.update')
    if (typeof p.ExternalWebview.reload === 'function') capabilities.push('browser.webview.reload')
    if (typeof p.ExternalWebview.close === 'function') capabilities.push('browser.webview.close')
  }
  if (p.DeviceAutomation) {
    if (typeof p.DeviceAutomation.status === 'function') capabilities.push('device.status')
    if (typeof p.DeviceAutomation.openAccessibilitySettings === 'function') capabilities.push('device.open-accessibility-settings')
    if (typeof p.DeviceAutomation.devTunnelStatus === 'function') capabilities.push('device.dev-tunnel-status')
    if (typeof p.DeviceAutomation.startDevTunnel === 'function') capabilities.push('device.start-dev-tunnel')
    if (typeof p.DeviceAutomation.stopDevTunnel === 'function') capabilities.push('device.stop-dev-tunnel')
  }
  if (p.ApkInstaller) capabilities.push('apk.check-update', 'apk.install-update')
  return capabilities.sort()
}

async function appVersion() {
  const app = plugins().App
  if (!app || typeof app.getInfo !== 'function') return 'web'
  try {
    const info = await app.getInfo()
    return String(info.version || info.build || '')
  } catch (e) { return '' }
}

function postBridgeMessage(target, payload, origin) {
  if (!target || typeof target.postMessage !== 'function') return false
  try { target.postMessage(payload, origin); return true } catch (e) { return false }
}

function isTrustedDashboardMessage(event) {
  if (!dashboardFrame || !dashboardFrame.contentWindow || event.source !== dashboardFrame.contentWindow) return false
  const origin = dashboardOrigin()
  return origin !== '*' && event.origin === origin
}

function bridgeResult(event, requestId, ok, result, error) {
  postBridgeMessage(event.source, {
    type: LOFA_NATIVE_RESULT,
    protocol: LOFA_BRIDGE_PROTOCOL,
    request_id: requestId,
    ok,
    ...(ok ? { result } : { error: String(error || 'native request failed') }),
  }, event.origin)
}

async function runNativeAction(action, args) {
  if (!nativeCapabilities().includes(action)) throw new Error('native capability is unavailable: ' + action)
  const p = plugins()
  switch (action) {
    case 'shell.reload-dashboard':
      return { reloaded: reloadDashboard() }
    case 'shell.open-settings':
      router.tab('me'); return { opened: true }
    case 'navigation.open-entity':
      return { opened: openEntity(args && args.type, args && args.id, args && args.title) }
    case 'file.open-bridge':
      return { opened: openEntity('file_bridge', 'main', 'Agent 暂存区') }
    case 'browser.open-external': {
      const value = String((args && args.url) || '').trim()
      let parsed
      try { parsed = new URL(value) } catch (e) { throw new Error('invalid external URL') }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('external URL must be HTTP(S)')
      return { opened: await openExternalBrowser(parsed.href) }
    }
    case 'browser.webview.open': {
      const value = String((args && args.url) || '').trim()
      let parsed
      try { parsed = new URL(value) } catch (e) { throw new Error('invalid webview URL') }
      if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
        throw new Error('webview URL must be credential-free HTTP(S)')
      }
      return p.ExternalWebview.open({
        id: String((args && args.id) || ''),
        url: parsed.href,
        profile: String((args && args.profile) || 'human'),
        bounds: args && args.bounds,
        visible: args && args.visible !== false,
        pixelRatio: Number((args && args.pixelRatio) || 1),
        webviewSession: args && args.webviewSession,
      })
    }
    case 'browser.webview.update':
      return p.ExternalWebview.update({
        id: String((args && args.id) || ''),
        bounds: args && args.bounds,
        visible: args && args.visible !== false,
        focus: args && args.focus === true,
        pixelRatio: Number((args && args.pixelRatio) || 1),
      })
    case 'browser.webview.reload':
      return p.ExternalWebview.reload({ id: String((args && args.id) || '') })
    case 'browser.webview.close':
      return p.ExternalWebview.close({ id: String((args && args.id) || '') })
    case 'device.status': return p.DeviceAutomation.status()
    case 'device.open-accessibility-settings': return p.DeviceAutomation.openAccessibilitySettings()
    case 'device.dev-tunnel-status': return p.DeviceAutomation.devTunnelStatus()
    // Dashboard cannot inject relay tokens or arbitrary endpoints. The native
    // plugin derives its already-paired defaults from DeviceBridgeConfig.
    case 'device.start-dev-tunnel': return p.DeviceAutomation.startDevTunnel({})
    case 'device.stop-dev-tunnel': return p.DeviceAutomation.stopDevTunnel({})
    case 'apk.check-update':
      await checkUpdate(); return { available: !!store.update, update: store.update || null }
    case 'apk.install-update':
      await doUpdate(); return { started: true }
    default:
      throw new Error('native action is not allowlisted: ' + action)
  }
}

async function onDashboardBridgeMessage(event) {
  if (!isTrustedDashboardMessage(event)) return
  const data = event.data
  if (!data || data.protocol !== LOFA_BRIDGE_PROTOCOL || typeof data.request_id !== 'string') return
  if (data.type === LOFA_BOOTSTRAP_REQUEST) {
    const bootstrap = data.bootstrap
    if (!bootstrap || typeof bootstrap.frontend_build !== 'string' || !Number.isFinite(Number(bootstrap.api_schema_version))) return
    lastDashboardBootstrap = {
      frontend_build: bootstrap.frontend_build,
      api_schema_version: Number(bootstrap.api_schema_version),
      min_native_bridge_version: Number(bootstrap.min_native_bridge_version) || 0,
      features: Array.isArray(bootstrap.features) ? bootstrap.features.filter((item) => typeof item === 'string') : [],
    }
    document.documentElement.dataset.lofaFrontendBuild = lastDashboardBootstrap.frontend_build
    postBridgeMessage(event.source, {
      type: LOFA_BOOTSTRAP_RESPONSE,
      protocol: LOFA_BRIDGE_PROTOCOL,
      request_id: data.request_id,
      native_bridge_version: LOFA_NATIVE_BRIDGE_VERSION,
      app_version: await appVersion(),
      capabilities: nativeCapabilities(),
    }, event.origin)
    while (pendingNativeTabs.length) postTab(pendingNativeTabs.shift())
    return
  }
  if (data.type !== LOFA_NATIVE_REQUEST || typeof data.action !== 'string') return
  try {
    const result = await runNativeAction(data.action, data.args && typeof data.args === 'object' ? data.args : {})
    bridgeResult(event, data.request_id, true, result)
  } catch (error) {
    bridgeResult(event, data.request_id, false, null, error && error.message ? error.message : error)
  }
}

export function getDashboardBootstrap() {
  return lastDashboardBootstrap
}

function postTab(request) {
  if (!dashboardFrame || !dashboardLoaded || !dashboardFrame.contentWindow) {
    pendingTabs.push(request)
    return false
  }
  try {
    dashboardFrame.contentWindow.postMessage(request, dashboardOrigin())
    return true
  } catch (e) {
    pendingTabs.push(request)
    return false
  }
}

function flushPendingTabs() {
  if (!dashboardLoaded || !dashboardFrame || !dashboardFrame.contentWindow) return
  while (pendingTabs.length) {
    const request = pendingTabs.shift()
    try { dashboardFrame.contentWindow.postMessage(request, dashboardOrigin()) } catch (e) { pendingTabs.unshift(request); break }
  }
}

function attachSameOriginPopupFallback(frame) {
  try {
    const doc = frame.contentDocument
    const win = frame.contentWindow
    if (!doc || !win || doc.documentElement.dataset.omniWebTabHost === '1') return
    if (doc.documentElement.dataset.lofaPopupBridge === '1') return
    doc.documentElement.dataset.lofaPopupBridge = '1'
    doc.addEventListener('click', (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null
      if (!anchor || !anchor.href || anchor.hasAttribute('download')) return
      event.preventDefault()
      openWeb(anchor.href, anchor.textContent || '')
    }, true)
    const originalOpen = win.open && win.open.bind(win)
    win.open = function (url) {
      if (url) { openWeb(url, ''); return win }
      return originalOpen ? originalOpen.apply(win, arguments) : null
    }
  } catch (e) {
    // Cross-origin popups are converted to lofa:new-window by Android WebChromeClient.
  }
}

function ensureDashboardFrame() {
  init()
  const nextUrl = connectedDashboardUrl()
  if (!dashboardFrame) return null
  if (dashboardUrl !== nextUrl) {
    dashboardUrl = nextUrl
    dashboardLoaded = false
    dashboardFrame.src = dashboardUrl
  }
  return dashboardFrame
}

function reloadDashboard() {
  if (!store.base || !dashboardFrame) return false
  const externalWebview = plugins().ExternalWebview
  if (externalWebview && typeof externalWebview.closeAll === 'function') void externalWebview.closeAll()
  lastDashboardBootstrap = null
  dashboardUrl = connectedDashboardUrl()
  dashboardLoaded = false
  dashboardFrame.src = dashboardUrl
  return true
}

export function init() {
  if (initialized) return
  initialized = true
  view = document.getElementById('browserView')
  if (!view) return
  view.innerHTML =
    '<div class="browser-shell">' +
      '<iframe class="browser-frame" title="Omnicompany Dashboard" allow="clipboard-read; clipboard-write; fullscreen; camera; microphone" referrerpolicy="no-referrer"></iframe>' +
      '<div class="browser-local-tools" data-omni-capture-ignore="true">' +
        '<button type="button" class="browser-local-btn" data-browser-action="reload" aria-label="刷新 Dashboard" title="刷新 Dashboard">&#8635;</button>' +
        '<button type="button" class="browser-local-btn browser-local-home" data-browser-action="settings" aria-label="打开 LOFA 本地设置" title="LOFA 本地设置">LOFA</button>' +
      '</div>' +
    '</div>'
  dashboardFrame = view.querySelector('.browser-frame')
  dashboardFrame.addEventListener('load', () => {
    // A Dashboard hot reload cannot reliably post unmount cleanup while its
    // document is being replaced. Remove old native layers before the new
    // document negotiates and recreates its retained page tabs.
    const externalWebview = plugins().ExternalWebview
    if (externalWebview && typeof externalWebview.closeAll === 'function') void externalWebview.closeAll()
    dashboardLoaded = true
    attachSameOriginPopupFallback(dashboardFrame)
    flushPendingTabs()
  })
  view.querySelector('[data-browser-action="reload"]').addEventListener('click', () => {
    if (!reloadDashboard()) toast('\u672a\u8fde\u63a5')
  })
  view.querySelector('[data-browser-action="settings"]').addEventListener('click', () => router.tab('me'))

  window.addEventListener('lofa:new-window', (event) => {
    const detail = (event && event.detail) || {}
    if (detail.url) openWeb(detail.url, detail.title || '')
  })
  window.addEventListener('message', onDashboardBridgeMessage)

  const syncNativeHostVisibility = () => {
    const externalWebview = plugins().ExternalWebview
    if (!externalWebview || typeof externalWebview.setHostVisible !== 'function') return
    void externalWebview.setHostVisible({ visible: view.classList.contains('show') })
  }
  new MutationObserver(syncNativeHostVisibility).observe(view, { attributes: true, attributeFilter: ['class'] })
  syncNativeHostVisibility()

  // Links opened by LOFA surfaces also enter the Dashboard's internal tab strip.
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null
    if (!anchor || !anchor.href || (view && view.contains(anchor))) return
    event.preventDefault()
    openWeb(anchor.href, anchor.textContent || '')
  }, true)
}

export function openWeb(value, title) {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  const url = resolveWebUrl(value)
  if (!url) { toast('\u5730\u5740\u65e0\u6548'); return }
  if (!isInternalWebUrl(url)) {
    const externalWebview = plugins().ExternalWebview
    if (!externalWebview || typeof externalWebview.open !== 'function') {
      void openExternalBrowser(url)
      return 'external'
    }
    ensureDashboardFrame()
    router.push('browserView')
    const request = { type: 'omni:open-web-tab', url, title: titleFor(url, title) }
    if (lastDashboardBootstrap) postTab(request)
    else pendingNativeTabs.push(request)
    return 'tab'
  }
  ensureDashboardFrame()
  router.push('browserView')

  if (!isDashboardRootUrl(url)) {
    postTab({ type: 'omni:open-web-tab', url, title: titleFor(url, title) })
    return 'tab'
  }
  return 'home'
}

// Dashboard entity deep-link is the single handoff for notifications, remote
// commands and legacy LOFA routes. The host's webTabHost converts it into a native
// Dashboard tab instead of nesting another Dashboard document in an iframe.
export function openEntity(type, id, title) {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return false }
  const entityType = String(type || '').trim()
  const entityId = String(id || '').trim()
  if (!entityType || !entityId) return false
  const url = new URL(connectedDashboardUrl())
  url.searchParams.set('open_type', entityType)
  url.searchParams.set('open_id', entityId)
  if (title) url.searchParams.set('open_title', String(title))
  return openWeb(url.href, title || entityId)
}

// The Dashboard frame may hold the gateway's pre-enrollment response. A
// cross-origin frame cannot expose that state, so reconnect reloads only a frame
// that LOFA previously opened.
export function reloadAfterConnect() {
  if (!dashboardFrame || !dashboardUrl) return
  dashboardLoaded = false
  dashboardUrl = connectedDashboardUrl()
  dashboardFrame.src = dashboardUrl
}

export async function openHome() {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  ensureDashboardFrame()
  router.push('browserView')
}
