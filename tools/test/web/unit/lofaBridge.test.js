// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

describe('LOFA shell native bridge', () => {
  let bridge

  beforeEach(async () => {
    vi.resetModules()
    delete window.Capacitor
    document.body.innerHTML = '<div id="viewport"><section class="view" id="browserView"></section></div>'
    const core = await import('../../../../app/www/js/core.js')
    core.store.base = 'https://10.3.43.246:12443'
    bridge = await import('../../../../app/www/js/browserView.js')
  })

  it('retires the floating shell tools once Dashboard declares it hosts them', async () => {
    bridge.init()
    await bridge.openHome()
    const frame = document.querySelector('#browserView iframe')
    frame.dispatchEvent(new Event('load'))
    const tools = document.querySelector('.browser-local-tools')
    // 未握手(未连接 / 旧版驾驶舱 / 401 登录页): 浮标必须在, 那是唯一自救入口。
    expect(tools.hidden).toBe(false)

    const bootstrap = (features) => window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://10.3.43.246:12443',
      data: {
        type: bridge.LOFA_BOOTSTRAP_REQUEST,
        protocol: bridge.LOFA_BRIDGE_PROTOCOL,
        request_id: 'bootstrap-tools',
        bootstrap: {
          frontend_build: 'ui-cl-1400000',
          api_schema_version: 1,
          min_native_bridge_version: 1,
          features,
        },
      },
    }))

    bootstrap(['dashboard.entities'])
    await Promise.resolve()
    expect(tools.hidden).toBe(false)

    bootstrap(['dashboard.entities', 'shell.hosts-lofa-controls'])
    await Promise.resolve()
    expect(tools.hidden).toBe(true)
  })

  it('answers a trusted bootstrap with version and declared capabilities', async () => {
    bridge.init()
    await bridge.openHome()
    const frame = document.querySelector('#browserView iframe')
    frame.dispatchEvent(new Event('load'))
    const post = vi.spyOn(frame.contentWindow, 'postMessage')
    const request = {
      type: bridge.LOFA_BOOTSTRAP_REQUEST,
      protocol: bridge.LOFA_BRIDGE_PROTOCOL,
      request_id: 'bootstrap-1',
      bootstrap: {
        frontend_build: 'ui-cl-1400000',
        api_schema_version: 1,
        min_native_bridge_version: 1,
        features: ['dashboard.entities'],
      },
    }

    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://evil.example',
      data: request,
    }))
    await Promise.resolve()
    expect(post).not.toHaveBeenCalled()

    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://10.3.43.246:12443',
      data: request,
    }))
    await Promise.resolve()
    await Promise.resolve()
    expect(bridge.getDashboardBootstrap()).toEqual({
      frontend_build: 'ui-cl-1400000',
      api_schema_version: 1,
      min_native_bridge_version: 1,
      features: ['dashboard.entities'],
    })
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: bridge.LOFA_BOOTSTRAP_RESPONSE,
      protocol: bridge.LOFA_BRIDGE_PROTOCOL,
      request_id: 'bootstrap-1',
      native_bridge_version: bridge.LOFA_NATIVE_BRIDGE_VERSION,
      capabilities: bridge.nativeCapabilities(),
    }), 'https://10.3.43.246:12443')
  })

  it('executes only exact allowlisted actions and has no eval escape hatch', async () => {
    bridge.init()
    await bridge.openHome()
    const frame = document.querySelector('#browserView iframe')
    const post = vi.spyOn(frame.contentWindow, 'postMessage')
    const send = async (action, requestId) => {
      window.dispatchEvent(new MessageEvent('message', {
        source: frame.contentWindow,
        origin: 'https://10.3.43.246:12443',
        data: {
          type: bridge.LOFA_NATIVE_REQUEST,
          protocol: bridge.LOFA_BRIDGE_PROTOCOL,
          request_id: requestId,
          action,
          args: {},
        },
      }))
      for (let index = 0; index < 5; index += 1) await Promise.resolve()
      return post.mock.calls.map(([value]) => value).find((value) => value.type === bridge.LOFA_NATIVE_RESULT && value.request_id === requestId)
    }

    expect(await send('eval', 'native-1')).toMatchObject({
      ok: false,
      error: expect.stringContaining('capability is unavailable'),
    })
    expect(await send('shell.reload-dashboard', 'native-2')).toMatchObject({ ok: true })
  })

  it('keeps public pages in Dashboard tabs when the native page carrier exists', async () => {
    window.Capacitor = {
      Plugins: {
        ExternalWebview: {
          open: vi.fn(), update: vi.fn(), reload: vi.fn(), close: vi.fn(),
          closeAll: vi.fn(), setHostVisible: vi.fn(),
        },
      },
      isNativePlatform: () => true,
    }
    bridge.init()
    await bridge.openHome()
    const frame = document.querySelector('#browserView iframe')
    frame.dispatchEvent(new Event('load'))
    const post = vi.spyOn(frame.contentWindow, 'postMessage')

    expect(bridge.openWeb('https://example.com/no-frames', 'External')).toBe('tab')
    expect(post).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'omni:open-web-tab' }), expect.anything())

    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://10.3.43.246:12443',
      data: {
        type: bridge.LOFA_BOOTSTRAP_REQUEST,
        protocol: bridge.LOFA_BRIDGE_PROTOCOL,
        request_id: 'bootstrap-native',
        bootstrap: {
          frontend_build: 'ui-native',
          api_schema_version: 1,
          min_native_bridge_version: 1,
          features: [],
        },
      },
    }))
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: 'omni:open-web-tab',
      url: 'https://example.com/no-frames',
    }), 'https://10.3.43.246:12443')
  })

  it('forwards bounded native page operations without a generic plugin escape hatch', async () => {
    const open = vi.fn(async (request) => ({ label: request.id }))
    window.Capacitor = {
      Plugins: {
        ExternalWebview: {
          open, update: vi.fn(), reload: vi.fn(), close: vi.fn(),
        },
      },
      isNativePlatform: () => true,
    }
    bridge.init()
    await bridge.openHome()
    const frame = document.querySelector('#browserView iframe')
    const post = vi.spyOn(frame.contentWindow, 'postMessage')
    window.dispatchEvent(new MessageEvent('message', {
      source: frame.contentWindow,
      origin: 'https://10.3.43.246:12443',
      data: {
        type: bridge.LOFA_NATIVE_REQUEST,
        protocol: bridge.LOFA_BRIDGE_PROTOCOL,
        request_id: 'native-webview-open',
        action: 'browser.webview.open',
        args: {
          id: 'web_1234',
          url: 'https://example.com/no-frames',
          profile: 'human',
          bounds: { x: 10, y: 20, width: 300, height: 200 },
          visible: true,
          pixelRatio: 2,
        },
      },
    }))
    for (let index = 0; index < 5; index += 1) await Promise.resolve()
    expect(open).toHaveBeenCalledWith(expect.objectContaining({
      id: 'web_1234',
      url: 'https://example.com/no-frames',
      pixelRatio: 2,
    }))
    expect(post).toHaveBeenCalledWith(expect.objectContaining({
      type: bridge.LOFA_NATIVE_RESULT,
      request_id: 'native-webview-open',
      ok: true,
    }), 'https://10.3.43.246:12443')
  })
})
