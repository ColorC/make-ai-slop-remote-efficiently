// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openReconnectingWs } from '../../../../app/www/js/ws.js'

class FakeWebSocket {
  static instances = []

  constructor(url) {
    this.url = url
    this.readyState = 0
    this.sent = []
    FakeWebSocket.instances.push(this)
  }

  open() {
    this.readyState = 1
    if (this.onopen) this.onopen({})
  }

  message(frame) {
    if (this.onmessage) this.onmessage({ data: JSON.stringify(frame) })
  }

  close() {
    this.readyState = 3
    if (this.onclose) this.onclose({ code: 1000 })
  }

  send(data) { this.sent.push(data) }
}

describe('openReconnectingWs generation isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    FakeWebSocket.instances = []
    vi.stubGlobal('WebSocket', FakeWebSocket)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('ignores late frames and close events from the previous socket generation', () => {
    const frames = []
    const reconnecting = vi.fn()
    const conn = openReconnectingWs('ws://test/chat', {
      onFrame: (frame) => frames.push(frame),
      onReconnecting: reconnecting,
    })

    const first = FakeWebSocket.instances[0]
    first.open()
    first.message({ kind: 'snapshot', generation: 1 })
    const lateMessage = first.onmessage
    const lateClose = first.onclose

    expect(conn.reconnectNow()).toBe(true)
    const second = FakeWebSocket.instances[1]
    second.open()
    second.message({ kind: 'snapshot', generation: 2 })

    lateMessage({ data: JSON.stringify({ kind: 'snapshot', generation: 1, late: true }) })
    lateClose({ code: 1006 })
    vi.advanceTimersByTime(9000)

    expect(frames).toEqual([
      { kind: 'snapshot', generation: 1 },
      { kind: 'snapshot', generation: 2 },
    ])
    expect(reconnecting).not.toHaveBeenCalled()
    expect(FakeWebSocket.instances).toHaveLength(2)
    conn.leave()
  })

  it('ensureConnected immediately recreates a non-open socket', () => {
    const conn = openReconnectingWs('ws://test/chat', {})
    expect(FakeWebSocket.instances).toHaveLength(1)
    expect(conn.ensureConnected()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(2)
    FakeWebSocket.instances[1].open()
    expect(conn.ensureConnected()).toBe(true)
    conn.leave()
  })
})
