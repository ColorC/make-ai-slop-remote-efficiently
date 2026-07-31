export const TERMINAL_RENDERER_KEY = 'lofa.termRenderer'

function normalizedOverride(value) {
  const renderer = String(value || '').trim().toLowerCase()
  return renderer === 'dom' || renderer === 'webgl' ? renderer : ''
}

/**
 * WebGL is fast on desktop, but Android WebView and coarse-pointer tablets have
 * repeatedly produced corrupted or inconsistently scaled terminal glyphs. Keep
 * those devices on xterm's DOM renderer unless a diagnostic override explicitly
 * opts them back into WebGL.
 */
export function preferredTerminalRenderer({
  override = '',
  nativePlatform = false,
  userAgent = '',
  maxTouchPoints = 0,
  coarsePointer = false,
} = {}) {
  const explicit = normalizedOverride(override)
  if (explicit) return explicit

  const ua = String(userAgent || '').toLowerCase()
  const androidWebView = ua.includes('android') || ua.includes('; wv)') || ua.includes(' version/4.0')
  const touchTablet = Number(maxTouchPoints || 0) > 0 && Boolean(coarsePointer)
  return nativePlatform || androidWebView || touchTablet ? 'dom' : 'webgl'
}

export function terminalRendererForWindow(win = window) {
  let override = ''
  let nativePlatform = false
  let coarsePointer = false
  try { override = win.localStorage && win.localStorage.getItem(TERMINAL_RENDERER_KEY) || '' } catch (e) {}
  try {
    const capacitor = win.Capacitor
    nativePlatform = Boolean(capacitor && typeof capacitor.isNativePlatform === 'function' && capacitor.isNativePlatform())
  } catch (e) {}
  try { coarsePointer = Boolean(win.matchMedia && win.matchMedia('(pointer: coarse)').matches) } catch (e) {}

  return preferredTerminalRenderer({
    override,
    nativePlatform,
    userAgent: win.navigator && win.navigator.userAgent || '',
    maxTouchPoints: win.navigator && win.navigator.maxTouchPoints || 0,
    coarsePointer,
  })
}
