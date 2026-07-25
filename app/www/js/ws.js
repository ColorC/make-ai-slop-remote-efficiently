// ws.js - reusable reconnecting WebSocket wrapper.
//
// A connection generation isolates late events from sockets that are no longer current.
// reconnectNow() performs an immediate foreground recovery without leaking stale events.

import { LOG } from './core.js'

export function openReconnectingWs(url, handlers) {
  handlers = handlers || {}
  let ws = null
  let closedByUser = false
  let retry = 0
  let retryTimer = null
  let generation = 0

  function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } }
  function isCurrent(sock, gen) { return !closedByUser && ws === sock && generation === gen }
  function detach(sock) {
    if (!sock) return
    sock.onopen = null; sock.onmessage = null; sock.onerror = null; sock.onclose = null
  }

  function connect() {
    if (closedByUser) return
    clearRetry()
    const gen = ++generation
    let sock
    try {
      sock = new WebSocket(url)
      ws = sock
    } catch (e) {
      LOG.rec('error', ['ws.ctor', e.message || e])
      if (generation === gen) scheduleRetry()
      return
    }
    sock.onopen = () => {
      if (!isCurrent(sock, gen)) return
      retry = 0
      if (handlers.onOpen) handlers.onOpen()
    }
    sock.onmessage = (ev) => {
      if (!isCurrent(sock, gen)) return
      let frame
      try { frame = JSON.parse(ev.data) } catch (e) { return }
      if (handlers.onFrame) handlers.onFrame(frame)
    }
    sock.onerror = () => {
      if (!isCurrent(sock, gen)) return
      if (handlers.onError) handlers.onError()
    }
    sock.onclose = (ev) => {
      if (!isCurrent(sock, gen)) return
      ws = null
      if (handlers.onClose) handlers.onClose(ev)
      if (closedByUser) return
      if (handlers.onReconnecting) handlers.onReconnecting(retry)
      scheduleRetry()
    }
  }

  function scheduleRetry() {
    if (closedByUser) return
    retry++
    const delay = Math.min(1000 * retry, 8000)
    clearRetry()
    retryTimer = setTimeout(connect, delay)
  }

  function reconnectNow() {
    if (closedByUser) return false
    clearRetry()
    retry = 0
    const old = ws
    ws = null
    generation++ // Invalidate callbacks from the previous socket before closing it.
    if (old) { detach(old); try { old.close() } catch (e) {} }
    connect()
    return true
  }

  function ensureConnected() {
    if (ws && ws.readyState === 1) return true
    reconnectNow()
    return false
  }

  function send(obj) {
    if (!ws || ws.readyState !== 1) return false
    try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); return true }
    catch (e) { LOG.rec('error', ['ws.send', e.message || e]); return false }
  }

  function isOpen() { return !!ws && ws.readyState === 1 }

  function leave() {
    closedByUser = true
    clearRetry()
    generation++
    const old = ws; ws = null
    if (old) { detach(old); try { old.close() } catch (e) {} }
  }

  connect()
  return { send, leave, isOpen, reconnectNow, ensureConnected }
}
