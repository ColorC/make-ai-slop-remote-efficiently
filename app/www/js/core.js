// Shared shell primitives. No project, session, PTY or review state belongs here.
import { banner } from './ui.js'

export const LS_KEY = 'lofa.baseUrl'
export const DEFAULT_BASE = location.origin || 'https://localhost:12443'
export const store = { base: null, update: null }

let connectionState = 'idle'
let probePromise = null
let updateListener = () => {}

export function connectionTrying() { connectionState = 'connecting'; banner('connecting') }
export function connectionAlive(announce) {
  const recovered = connectionState === 'disconnected' || connectionState === 'connecting'
  connectionState = 'connected'
  banner(announce || recovered ? 'connected' : null)
}
export function connectionLost() { connectionState = 'disconnected'; banner('disconnected') }

export const $ = (id) => document.getElementById(id)
export function esc(value) {
  return (value == null ? '' : String(value)).replace(/[&<>]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;',
  }[character]))
}

const nextFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (callback) => setTimeout(callback, 0)
export function toast(message, options = {}) {
  const host = $('toast')
  if (!host) return
  const element = document.createElement('div')
  element.className = 'lg-toast' + (options.type ? ' ' + options.type : '')
  element.textContent = message
  host.appendChild(element)
  nextFrame(() => element.classList.add('show'))
  setTimeout(() => {
    element.classList.remove('show')
    setTimeout(() => { try { host.removeChild(element) } catch (error) {} }, 200)
  }, options.ms || 1900)
}

export const FONT_SCALES = [
  { value: 'sm', label: '小', scale: 1 },
  { value: 'md', label: '中', scale: 1.15 },
  { value: 'lg', label: '大', scale: 1.3 },
  { value: 'xl', label: '特大', scale: 1.5 },
]
const FONT_KEY = 'lofa.fontScale'
export function getFontScale() { try { return localStorage.getItem(FONT_KEY) || 'sm' } catch (error) { return 'sm' } }
function applyFontScale(value) {
  const entry = FONT_SCALES.find((candidate) => candidate.value === value) || FONT_SCALES[0]
  document.documentElement.style.setProperty('--font-scale', String(entry.scale))
  return entry.value
}
export function setFontScale(value) { try { localStorage.setItem(FONT_KEY, value) } catch (error) {} return applyFontScale(value) }
export function initFontScale() { return applyFontScale(getFontScale()) }

export function initA11yPrefs() {
  document.documentElement.classList.toggle('no-glass', getReduceGlass())
  document.documentElement.classList.toggle('reduce-motion', getReduceMotion())
}
export function setReduceGlass(enabled) {
  try { localStorage.setItem('lofa.reduceGlass', enabled ? '1' : '0') } catch (error) {}
  document.documentElement.classList.toggle('no-glass', Boolean(enabled))
}
export function setReduceMotion(enabled) {
  try { localStorage.setItem('lofa.reduceMotion', enabled ? '1' : '0') } catch (error) {}
  document.documentElement.classList.toggle('reduce-motion', Boolean(enabled))
}
export function getReduceGlass() { try { return localStorage.getItem('lofa.reduceGlass') === '1' } catch (error) { return false } }
export function getReduceMotion() { try { return localStorage.getItem('lofa.reduceMotion') === '1' } catch (error) { return false } }

export function normBase(value) {
  let normalized = String(value || '').trim().replace(/\/+$/, '')
  if (!normalized) return ''
  if (!/^https?:\/\//i.test(normalized)) normalized = 'https://' + normalized
  return normalized
}
export function getSaved() {
  try {
    let value = localStorage.getItem(LS_KEY) || ''
    if (value && (/^http:\/\//i.test(value) || /:8210(\b|\/|$)/.test(value))) value = ''
    return value
  } catch (error) { return '' }
}
export function save(base) { try { localStorage.setItem(LS_KEY, base) } catch (error) {} }
export function hostLabel() { return store.base ? store.base.replace(/^https?:\/\//, '') : '' }

export async function api(path, options) {
  const response = await fetch(store.base + path, Object.assign({
    cache: 'no-store',
    credentials: 'include',
  }, options || {}))
  if (!response.ok) {
    let detail = ''
    try {
      const payload = await response.json()
      detail = payload.detail || payload.error || ''
    } catch (error) {}
    throw new Error(detail || 'HTTP ' + response.status)
  }
  connectionAlive(false)
  const contentType = response.headers.get('content-type') || ''
  return contentType.includes('application/json') ? response.json() : response.text()
}

export const apiJson = (path, method, body) => api(path, {
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body || {}),
})

export const LOG = (() => {
  const buffer = []
  function rec(level, args) {
    let message
    try {
      message = Array.from(args).map((value) => typeof value === 'object' ? JSON.stringify(value) : String(value)).join(' ')
    } catch (error) { message = String(args) }
    buffer.push({ ts: Date.now(), level, src: 'lofa-web', msg: message })
    if (buffer.length > 500) buffer.shift()
  }
  ;['log', 'info', 'warn', 'error'].forEach((level) => {
    const original = console[level] ? console[level].bind(console) : () => {}
    console[level] = function () { rec(level, arguments); original.apply(null, arguments) }
  })
  window.addEventListener('error', (event) => rec('error', ['window.onerror', event.message, event.filename + ':' + event.lineno]))
  window.addEventListener('unhandledrejection', (event) => rec('error', ['unhandledrejection', event.reason && event.reason.message || event.reason]))
  function flush() {
    if (!store.base || !buffer.length) return
    const entries = buffer.splice(0, buffer.length)
    fetch(store.base + '/api/android/log', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    }).catch(() => {})
  }
  setInterval(flush, 4000)
  return { rec, flush }
})()

export function setUpdateListener(listener) { updateListener = listener || (() => {}) }
async function ownVersionCode() {
  try {
    const app = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App
    if (!app) return 0
    const info = await app.getInfo()
    return parseInt(info.build, 10) || 0
  } catch (error) { return 0 }
}

export async function checkUpdate() {
  if (!store.base) return
  try {
    const response = await api('/api/android/apk/version')
    const manifest = response && response.manifest
    if (!manifest || !manifest.versionCode) {
      store.update = null
      updateListener(null)
      return
    }
    const own = await ownVersionCode()
    if (manifest.versionCode > own) {
      const first = !store.update
      store.update = { manifest, versionName: manifest.versionName || '#' + manifest.versionCode, own }
      if (first) toast('发现新 APK ' + store.update.versionName, { type: 'ok', ms: 2600 })
      updateListener(store.update)
      LOG.rec('info', ['update.available', manifest.versionCode, 'own', own])
    } else {
      store.update = null
      updateListener(null)
    }
  } catch (error) { LOG.rec('error', ['checkUpdate', error.message || error]) }
}

let updatePromise = null
export async function doUpdate() {
  if (updatePromise) { toast('更新正在下载，请稍候'); return updatePromise }
  const installer = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.ApkInstaller
  if (!installer) { toast('当前环境不支持 APK 安装'); return }
  updatePromise = (async () => {
    const permission = await installer.canInstall()
    if (!permission || !permission.granted) {
      toast('请先允许 LOFA 安装未知应用')
      await installer.openInstallPermission()
      return
    }
    toast('下载中，安装器稍后弹出')
    await installer.downloadAndInstall({
      url: store.base + '/api/android/apk/latest',
      sha256: String(store.update && store.update.manifest && store.update.manifest.sha256 || ''),
    })
  })()
  try { return await updatePromise }
  catch (error) { toast('更新失败：' + (error.message || error)); LOG.rec('error', ['update.fail', error.message || error]) }
  finally { updatePromise = null }
}

async function healthCheck(base) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 6000)
  try {
    const response = await fetch(base + '/api/healthz', {
      signal: controller.signal,
      cache: 'no-store',
      credentials: 'include',
    })
    if (!response.ok) throw new Error('HTTP ' + response.status)
    const payload = await response.json()
    if (!payload.ok) throw new Error('healthz not ok')
    return payload
  } finally { clearTimeout(timeout) }
}

export function probeConnection(base = store.base) {
  if (!base) return Promise.resolve(false)
  if (probePromise) return probePromise
  connectionTrying()
  probePromise = healthCheck(base).then(() => {
    store.base = base
    connectionAlive(true)
    LOG.rec('info', ['connect.recovered', base])
    return true
  }).catch((error) => {
    connectionLost()
    LOG.rec('error', ['connect.probe.fail', base, error.message || error])
    return false
  }).finally(() => { probePromise = null })
  return probePromise
}

export async function connect(base, onOk, onFail) {
  connectionTrying()
  LOG.rec('info', ['connect.try', base])
  try {
    await healthCheck(base)
    store.base = base
    connectionAlive(true)
    if (onOk) await onOk()
    LOG.flush()
    checkUpdate()
  } catch (error) {
    connectionLost()
    const message = error.name === 'AbortError' ? '连接超时（6 秒）' : String(error.message || error)
    LOG.rec('error', ['connect.fail', base, message])
    LOG.flush()
    if (onFail) onFail(message)
  }
}
