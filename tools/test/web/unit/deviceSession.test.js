// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, connect, store, termWsUrl, wsUrl } from '../../../../app/www/js/core.js'

function jsonResponse(body) {
  return {
    ok: true,
    headers: { get: () => 'application/json' },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  }
}

describe('paired LOFA web session', () => {
  beforeEach(() => {
    store.base = 'https://10.3.43.246:12443'
    globalThis.fetch = vi.fn()
  })

  it('includes the HttpOnly device cookie on cross-origin API requests', async () => {
    globalThis.fetch.mockResolvedValue(jsonResponse({ ok: true }))

    await api('/api/projects')

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://10.3.43.246:12443/api/projects',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('establishes the device session before background API polling starts', async () => {
    const calls = []
    globalThis.fetch.mockImplementation(async (url) => {
      calls.push(String(url))
      return jsonResponse({ ok: true })
    })

    await connect(
      'https://10.3.43.246:12443',
      async () => { calls.push('device-session-ready') },
    )

    expect(calls[0]).toContain('/api/healthz')
    expect(calls[1]).toBe('device-session-ready')
    expect(calls.slice(2).some((entry) => entry.includes('/api/'))).toBe(true)
  })

  it('advertises the current PTY protocol without changing chat WebSocket URLs', () => {
    expect(termWsUrl('pty id')).toBe(
      'wss://10.3.43.246:12443/api/cc/sessions/pty%20id/ws' +
      '?client_protocol=focused-visible-v1',
    )
    expect(wsUrl('chat id')).toBe(
      'wss://10.3.43.246:12443/api/cc/chat/sessions/chat%20id/ws',
    )
  })
})
