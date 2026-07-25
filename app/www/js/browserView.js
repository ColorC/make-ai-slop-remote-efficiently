// browserView.js - LOFA remote web workspace with Dashboard-managed tabs.
// Android MainActivity converts target=_blank/window.open popups into lofa:new-window events.

import { store, toast } from './core.js'
import { icons } from './ui.js'
import * as router from './router.js'

const state = { tabs: [], activeId: '', seq: 0 }
let view = null
let tabsHost = null
let pagesHost = null
let initialized = false

function resolveWebUrl(value) {
  let url = String(value == null ? '' : value).trim()
  if (!url) return ''
  const base = (store.base || '').replace(/\/+$/, '')
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

function titleFor(url, title) {
  const named = String(title || '').trim()
  if (named) return named
  try { return new URL(url).hostname || '\u7f51\u9875' } catch (e) { return '\u7f51\u9875' }
}

function tabById(id) { return state.tabs.find((tab) => tab.id === id) || null }

function setActive(id) {
  if (!tabById(id)) return
  state.activeId = id
  renderTabs()
  state.tabs.forEach((tab) => {
    tab.frame.classList.toggle('active', tab.id === id)
    tab.frame.setAttribute('aria-hidden', tab.id === id ? 'false' : 'true')
  })
}

function closeTab(id) {
  const index = state.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return
  const wasActive = state.activeId === id
  const removed = state.tabs.splice(index, 1)[0]
  try { removed.frame.remove() } catch (e) {}
  if (!state.tabs.length) {
    state.activeId = ''
    renderTabs()
    router.pop()
    return
  }
  if (wasActive) setActive(state.tabs[Math.min(index, state.tabs.length - 1)].id)
  else renderTabs()
}

function renderTabs() {
  if (!tabsHost) return
  tabsHost.innerHTML = ''
  state.tabs.forEach((tab) => {
    const button = document.createElement('button')
    button.className = 'browser-tab' + (tab.id === state.activeId ? ' active' : '')
    button.type = 'button'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', tab.id === state.activeId ? 'true' : 'false')
    button.title = tab.url

    const label = document.createElement('span')
    label.className = 'browser-tab-title'
    label.textContent = tab.title
    button.appendChild(label)

    const close = document.createElement('span')
    close.className = 'browser-tab-close'
    close.setAttribute('role', 'button')
    close.setAttribute('aria-label', '\u5173\u95ed ' + tab.title)
    close.innerHTML = icons.close
    close.addEventListener('click', (event) => { event.stopPropagation(); closeTab(tab.id) })
    button.appendChild(close)

    button.addEventListener('click', () => setActive(tab.id))
    tabsHost.appendChild(button)
  })
  const active = tabsHost.querySelector('.browser-tab.active')
  if (active && active.scrollIntoView) active.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function attachSameOriginPopupFallback(frame) {
  try {
    const doc = frame.contentDocument
    const win = frame.contentWindow
    if (!doc || !win || doc.documentElement.dataset.lofaPopupBridge === '1') return
    doc.documentElement.dataset.lofaPopupBridge = '1'
    doc.addEventListener('click', (event) => {
      const anchor = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null
      if (!anchor || !anchor.href) return
      event.preventDefault()
      openWeb(anchor.href, anchor.textContent || '')
    }, true)
    const originalOpen = win.open && win.open.bind(win)
    win.open = function (url) {
      if (url) { openWeb(url, ''); return win }
      return originalOpen ? originalOpen.apply(win, arguments) : null
    }
  } catch (e) {
    // Cross-origin iframe access is blocked in JS; Android WebChromeClient handles its popup.
  }
}

function createTab(url, title) {
  const id = 'browser-' + (++state.seq)
  const frame = document.createElement('iframe')
  frame.className = 'browser-frame'
  frame.title = title
  frame.name = id
  frame.allow = 'clipboard-read; clipboard-write; fullscreen; camera; microphone'
  frame.referrerPolicy = 'no-referrer'
  frame.src = url
  frame.setAttribute('aria-hidden', 'true')
  frame.addEventListener('load', () => {
    attachSameOriginPopupFallback(frame)
    try {
      const pageTitle = frame.contentDocument && frame.contentDocument.title
      const tab = tabById(id)
      if (tab && pageTitle) { tab.title = pageTitle; renderTabs() }
    } catch (e) {}
  })
  pagesHost.appendChild(frame)
  const tab = { id, url, title, frame }
  state.tabs.push(tab)
  setActive(id)
  return tab
}

export function init() {
  if (initialized) return
  initialized = true
  view = document.getElementById('browserView')
  if (!view) return
  view.innerHTML =
    '<div class="browser-shell">' +
      '<header class="browser-chrome">' +
        '<button class="browser-control browser-exit" type="button" aria-label="\u8fd4\u56de Dashboard">' + icons.back + '</button>' +
        '<div class="browser-tabs" role="tablist" aria-label="\u7f51\u9875\u9875\u7b7e"></div>' +
        '<button class="browser-control browser-new" type="button" aria-label="\u6253\u5f00\u8fdc\u7a0b\u7f51\u9875\u9996\u9875">' + icons.plus + '</button>' +
      '</header>' +
      '<div class="browser-pages"></div>' +
    '</div>'
  tabsHost = view.querySelector('.browser-tabs')
  pagesHost = view.querySelector('.browser-pages')
  view.querySelector('.browser-exit').addEventListener('click', () => router.pop())
  view.querySelector('.browser-new').addEventListener('click', () => openHome())

  window.addEventListener('lofa:new-window', (event) => {
    const detail = (event && event.detail) || {}
    if (detail.url) openWeb(detail.url, detail.title || '')
  })

  // Browser preview fallback for target=_blank links in the LOFA top document.
  document.addEventListener('click', (event) => {
    const anchor = event.target && event.target.closest ? event.target.closest('a[target="_blank"]') : null
    if (!anchor || !anchor.href || (view && view.contains(anchor))) return
    event.preventDefault()
    openWeb(anchor.href, anchor.textContent || '')
  }, true)
}

export function openWeb(value, title) {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  init()
  const url = resolveWebUrl(value)
  if (!url) { toast('\u5730\u5740\u65e0\u6548'); return }
  createTab(url, titleFor(url, title))
  router.push('browserView')
}

export async function openHome() {
  if (!store.base) { toast('\u672a\u8fde\u63a5'); return }
  init()
  // Remote web mode replaces the old VSCode-specific home. Start at the connected Dashboard root.
  const url = store.base.replace(/\/+$/, '') + '/'
  const existing = state.tabs.find((tab) => tab.url === url)
  if (existing) setActive(existing.id)
  else createTab(url, '\u8fdc\u7a0b\u7f51\u9875')
  router.push('browserView')
}
