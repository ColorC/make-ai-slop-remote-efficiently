// browserView.js - chrome-free LOFA host for the Omnicompany Dashboard.
// Dashboard owns the only visible tab strip. Android popup events are forwarded into it.

import { store, toast } from './core.js'
import * as router from './router.js'

let view = null
let dashboardFrame = null
let dashboardLoaded = false
let initialized = false
let dashboardUrl = ''
const pendingTabs = []

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
    return url.href
  } catch (e) { return base + '?lofaRemoteWeb=1' }
}

function dashboardOrigin() {
  try { return new URL(dashboardUrl).origin } catch (e) { return '*' }
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

export function init() {
  if (initialized) return
  initialized = true
  view = document.getElementById('browserView')
  if (!view) return
  view.innerHTML =
    '<div class="browser-shell">' +
      '<iframe class="browser-frame" title="Omnicompany Dashboard" allow="clipboard-read; clipboard-write; fullscreen; camera; microphone" referrerpolicy="no-referrer"></iframe>' +
    '</div>'
  dashboardFrame = view.querySelector('.browser-frame')
  dashboardFrame.addEventListener('load', () => {
    dashboardLoaded = true
    attachSameOriginPopupFallback(dashboardFrame)
    flushPendingTabs()
  })

  window.addEventListener('lofa:new-window', (event) => {
    const detail = (event && event.detail) || {}
    if (detail.url) openWeb(detail.url, detail.title || '')
  })

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
    void openExternalBrowser(url)
    return 'external'
  }
  ensureDashboardFrame()
  router.push('browserView')

  if (!isDashboardRootUrl(url)) {
    postTab({ type: 'omni:open-web-tab', url, title: titleFor(url, title) })
    return 'tab'
  }
  return 'home'
}

export async function openHome() {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  ensureDashboardFrame()
  router.push('browserView')
}
