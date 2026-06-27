// ws.js — 可复用的自动重连 WebSocket 封装。
//
// 痛点①(断开重连)的地基: 连接掉了自动重连, 重连后服务端会重发 snapshot,
// 由消费方(chatView)据 snapshot 清空重建列表。本封装只管「连/重连/收发」,
// 不懂业务帧。leave() 是用户主动离开(停止重连), close 事件触发被动重连。

import { LOG } from './core.js'

export function openReconnectingWs(url, handlers) {
  handlers = handlers || {}
  let ws = null
  let closedByUser = false
  let retry = 0
  let retryTimer = null

  function clearRetry() { if (retryTimer) { clearTimeout(retryTimer); retryTimer = null } }

  function connect() {
    clearRetry()
    try {
      ws = new WebSocket(url)
    } catch (e) {
      LOG.rec('error', ['ws.ctor', e.message || e])
      scheduleRetry()
      return
    }
    ws.onopen = () => {
      retry = 0
      if (handlers.onOpen) handlers.onOpen()
    }
    ws.onmessage = (ev) => {
      let frame
      try { frame = JSON.parse(ev.data) } catch (e) { return }
      if (handlers.onFrame) handlers.onFrame(frame)
    }
    ws.onerror = () => { if (handlers.onError) handlers.onError() }
    ws.onclose = () => {
      if (closedByUser) return
      if (handlers.onReconnecting) handlers.onReconnecting(retry)
      scheduleRetry()
    }
  }

  function scheduleRetry() {
    if (closedByUser) return
    retry++
    const delay = Math.min(1000 * retry, 8000)   // 线性退避, 上限 8s
    clearRetry()
    retryTimer = setTimeout(connect, delay)
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
    if (ws) { try { ws.close() } catch (e) {} ws = null }
  }

  connect()
  return { send, leave, isOpen }
}
