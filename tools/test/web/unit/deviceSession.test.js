// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { api, connect, store } from '../../../../app/www/js/core.js'

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

  it('includes the HttpOnly device cookie on cross-origin shell API requests', async () => {
    globalThis.fetch.mockResolvedValue(jsonResponse({ ok: true }))
    await api('/api/android/apk/version')
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://10.3.43.246:12443/api/android/apk/version',
      expect.objectContaining({ credentials: 'include' }),
    )
  })

  it('runs the connected callback before OTA probing', async () => {
    const calls = []
    globalThis.fetch.mockImplementation(async (url) => {
      calls.push(String(url))
      return jsonResponse({ ok: true, manifest: null })
    })
    await connect('https://10.3.43.246:12443', async () => { calls.push('device-session-ready') })
    await Promise.resolve()
    expect(calls[0]).toContain('/api/healthz')
    expect(calls[1]).toBe('device-session-ready')
    expect(calls.slice(2).some((entry) => entry.includes('/api/android/apk/version'))).toBe(true)
  })
})
